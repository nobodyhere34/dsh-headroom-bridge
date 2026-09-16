/**
 * Local CCR store: the bridge-side original-text ledger on SQLite.
 *
 * Bounded-losslessness policy ("有限的轨迹无损"): every compression is
 * recorded (adopted rows keep the exact original; kept/failed attempts are
 * audited), but originals are retained under a byte budget instead of forever.
 * Retention tiers, newest-first protected:
 *   1. inside the fresh window (model can still retrieve - retrieval only
 *      happens while the content sits in the context window),
 *   2. budget headroom (`maxBytes`) - the oldest-retrieved originals degrade
 *      (metadata + accounting stay, the blob is dropped) whenever the live
 *      byte total moves past budget, and once an entry leaves the fresh
 *      window it is demoted unconditionally.
 * `deleteSession` cascades every row of a deleted session (the durable
 * session log itself outlives our ledger by design; see RESEARCH-REPORT.md
 * section 11.4 revision decision 1a).
 * @module
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LOG_TAG } from './config.js';
const LEGACY_FILE_NAME = 'dsh-headroom-bridge-ccr.json';
/** Resolve the on-disk SQLite path (legacy JSON import source is its sibling). */
export function defaultStorePath(explicitPath) {
    if (explicitPath.length > 0 && explicitPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(explicitPath))
        return explicitPath;
    const home = process.env.DSH_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh');
    return join(home, 'storages', 'dsh-headroom-bridge-ccr.db');
}
/** Legacy v0 JSON ledger location beside the SQLite file. */
function legacyPath(dbPath) {
    return join(dirname(dbPath), LEGACY_FILE_NAME);
}
/** Content-addressed original-text ledger with tiered bounded retention. */
export class CcrStore {
    options;
    db;
    disposed = false;
    hitsCount = 0;
    missesCount = 0;
    writesCount = 0;
    demotedCount = 0;
    constructor(options) {
        this.options = options;
    }
    /** Open the database; corrupt/unreadable files start empty rather than failing. */
    init() {
        if (!this.options.enabled || this.disposed)
            return;
        const target = defaultStorePath(this.options.path);
        try {
            mkdirSync(dirname(target), { recursive: true });
            this.db = new DatabaseSync(target);
            this.db.exec('PRAGMA journal_mode = WAL');
            this.db.exec('PRAGMA synchronous = NORMAL');
            this.db.exec(`CREATE TABLE IF NOT EXISTS ccr (
        hash TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL DEFAULT '',
        call_id TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        strategy TEXT NOT NULL DEFAULT '',
        chars_before INTEGER NOT NULL DEFAULT 0,
        chars_after INTEGER NOT NULL DEFAULT 0,
        tokens_before INTEGER,
        tokens_after INTEGER,
        original_text TEXT,
        stored_at INTEGER NOT NULL,
        fresh_until INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        degraded INTEGER NOT NULL DEFAULT 0,
        seq INTEGER
      )`);
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_ccr_session ON ccr(session_id)');
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_ccr_fresh ON ccr(degraded, fresh_until)');
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_ccr_seen ON ccr(last_seen_at)');
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_ccr_call ON ccr(session_id, call_id)');
            // v1 databases predate the seq column; add it when missing.
            try {
                this.db.exec('ALTER TABLE ccr ADD COLUMN seq INTEGER');
            }
            catch { /* already present */ }
            this.db.exec(`CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        tool_name TEXT NOT NULL DEFAULT '',
        call_id TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        chars_before INTEGER NOT NULL DEFAULT 0,
        chars_after INTEGER NOT NULL DEFAULT 0,
        strategy TEXT NOT NULL DEFAULT ''
      )`);
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_audit_session ON audit(session_id)');
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts)');
            this.importLegacy(target);
        }
        catch (error) {
            this.options.logger.warn(LOG_TAG + ': ccr sqlite open failed, store disabled: ' + String(error));
            this.db = undefined;
        }
    }
    /** Import the v0.x JSON ledger once, then park the file aside. */
    importLegacy(target) {
        const db = this.db;
        if (db === undefined)
            return;
        const old = legacyPath(target);
        if (!existsSync(old))
            return;
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(old, 'utf8'));
        }
        catch {
            try {
                renameSync(old, old + '.imported');
            }
            catch { /* best effort */ }
            return;
        }
        const shape = parsed;
        const now = Date.now();
        const entries = shape.version === 1 && Array.isArray(shape.entries) ? shape.entries : [];
        const insert = db.prepare(`INSERT OR IGNORE INTO ccr
      (hash, tool_name, call_id, session_id, strategy, chars_before, chars_after,
       tokens_before, tokens_after, original_text, stored_at, fresh_until, last_seen_at, degraded)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`);
        let imported = 0;
        for (const raw of entries) {
            if (raw === null || typeof raw !== 'object')
                continue;
            if (typeof raw.hash !== 'string' || typeof raw.originalText !== 'string')
                continue;
            const storedAt = typeof raw.storedAt === 'number' ? raw.storedAt : now;
            if (typeof raw.expiresAt === 'number' && raw.expiresAt <= now)
                continue; // already stale
            try {
                insert.run(String(raw.hash), String(raw.toolName ?? ''), String(raw.callId ?? ''), String(raw.sessionId ?? ''), String(raw.strategy ?? ''), Number(raw.charsBefore ?? 0), Number(raw.charsAfter ?? 0), null, null, String(raw.originalText), storedAt, typeof raw.expiresAt === 'number' ? raw.expiresAt : now + this.options.ttlMs, now);
                imported++;
            }
            catch { /* one bad row must not abort the import */ }
        }
        try {
            renameSync(old, old + '.imported');
        }
        catch { /* best effort */ }
        if (imported > 0)
            this.options.logger.warn(LOG_TAG + ': ccr imported ' + imported + ' legacy entries');
    }
    /**
     * Persist one original before its replacement ships (store-before-adopt).
     * @returns the content hash keying the entry.
     */
    put(entry) {
        if (!this.options.enabled || this.disposed)
            return entry.hash;
        const db = this.db;
        if (db === undefined)
            return entry.hash;
        const now = Date.now();
        try {
            db.prepare(`INSERT INTO ccr
        (hash, tool_name, call_id, session_id, strategy, chars_before, chars_after,
         tokens_before, tokens_after, original_text, stored_at, fresh_until, last_seen_at, degraded, seq)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
        ON CONFLICT(hash) DO UPDATE SET
          original_text = excluded.original_text,
          fresh_until = excluded.fresh_until,
          last_seen_at = excluded.last_seen_at,
          degraded = 0,
          seq = COALESCE(ccr.seq, excluded.seq)`)
                .run(entry.hash, entry.toolName, entry.callId, entry.sessionId, entry.strategy, entry.charsBefore, entry.charsAfter, entry.tokensBefore ?? null, entry.tokensAfter ?? null, entry.originalText, now, now + this.options.ttlMs, now, entry.seq ?? null);
            this.writesCount++;
            this.enforceBudget();
        }
        catch (error) {
            this.options.logger.warn(LOG_TAG + ': ccr put failed (keeping original anyway): ' + String(error));
        }
        return entry.hash;
    }
    /** Record one kept/failed attempt (never stores the original). */
    audit(e) {
        if (!this.options.enabled || this.disposed)
            return;
        const db = this.db;
        if (db === undefined)
            return;
        try {
            db.prepare('INSERT INTO audit (ts, tool_name, call_id, session_id, state, reason, chars_before, chars_after, strategy) VALUES (?,?,?,?,?,?,?,?,?)')
                .run(Date.now(), e.toolName, e.callId, e.sessionId, e.state, e.reason, e.charsBefore, e.charsAfter, e.strategy);
            db.prepare('DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY ts DESC, id DESC LIMIT ?)')
                .run(this.options.auditKeep);
        }
        catch (error) {
            this.options.logger.warn(LOG_TAG + ': ccr audit write failed: ' + String(error));
        }
    }
    /**
     * Fetch one live original by hash. Entries outside their fresh window or
     * demoted to metadata-only count as misses (retrieval demand only exists
     * while the content is inside a context window).
     */
    get(hash) {
        const db = this.db;
        if (db === undefined) {
            this.missesCount++;
            return undefined;
        }
        const row = db.prepare('SELECT * FROM ccr WHERE hash = ?').get(hash);
        if (row === undefined || row.degraded === 1 || row.original_text === null || row.fresh_until <= Date.now()) {
            this.missesCount++;
            return undefined;
        }
        this.hitsCount++;
        try {
            db.prepare('UPDATE ccr SET last_seen_at = ? WHERE hash = ?').run(Date.now(), hash);
        }
        catch { /* cosmetic */ }
        return {
            hash: row.hash, toolName: row.tool_name, callId: row.call_id, sessionId: row.session_id,
            strategy: row.strategy, charsBefore: row.chars_before, charsAfter: row.chars_after,
            tokensBefore: row.tokens_before ?? undefined, tokensAfter: row.tokens_after ?? undefined,
            originalText: row.original_text, storedAt: row.stored_at, expiresAt: row.fresh_until,
        };
    }
    /** Metadata + original-presence for one hash (UI detail face; no hit counting). */
    inspect(hash) {
        const db = this.db;
        if (db === undefined)
            return undefined;
        const row = db.prepare('SELECT * FROM ccr WHERE hash = ?').get(hash);
        if (row === undefined)
            return undefined;
        // Redeemability is judged exactly as get() judges it (degraded OR expired
        // OR missing text), so the API/tool/UI faces never disagree about one row
        // while a demoted-by-timing row still awaits its gc marking.
        const redeemable = row.degraded === 0 && row.original_text !== null && row.fresh_until > Date.now();
        return {
            row: {
                kind: 'ledger', ts: row.stored_at, toolName: row.tool_name, callId: row.call_id,
                sessionId: row.session_id, state: 'adopted', reason: '',
                charsBefore: row.chars_before, charsAfter: row.chars_after, strategy: row.strategy,
                hash: row.hash, originalAvailable: redeemable,
                seq: row.seq ?? null,
            },
            originalText: redeemable ? row.original_text : null,
        };
    }
    /**
     * Most recent live originals by storedAt, newest first (browsing face).
     * @param limit - maximum entries to return.
     */
    recent(limit) {
        const db = this.db;
        if (db === undefined)
            return [];
        const rows = db.prepare('SELECT * FROM ccr WHERE degraded = 0 AND fresh_until > ? ORDER BY stored_at DESC LIMIT ?').all(Date.now(), Math.max(0, limit));
        return rows.map((row) => ({
            hash: row.hash, toolName: row.tool_name, callId: row.call_id, sessionId: row.session_id,
            strategy: row.strategy, charsBefore: row.chars_before, charsAfter: row.chars_after,
            tokensBefore: row.tokens_before ?? undefined, tokensAfter: row.tokens_after ?? undefined,
            originalText: row.original_text ?? '', storedAt: row.stored_at, expiresAt: row.fresh_until,
        }));
    }
    /**
     * Merged activity stream for the card / audit face: newest ledger + audit
     * rows interleaved by time. Never returns original text.
     * @param limit - maximum rows to return.
     * @param session - when set, only rows of this session (pushed into the
     * queries, so a busy global stream never crowds a session's own rows out).
     */
    activity(limit, session) {
        const db = this.db;
        if (db === undefined)
            return [];
        const cap = Math.max(0, limit);
        const ledger = (session === undefined
            ? db.prepare('SELECT * FROM ccr ORDER BY stored_at DESC LIMIT ?').all(cap)
            : db.prepare('SELECT * FROM ccr WHERE session_id = ? ORDER BY stored_at DESC LIMIT ?').all(session, cap));
        const ledgerRows = ledger
            .map((row) => ({
            kind: 'ledger', ts: row.stored_at, toolName: row.tool_name, callId: row.call_id,
            sessionId: row.session_id, state: 'adopted', reason: '',
            charsBefore: row.chars_before, charsAfter: row.chars_after, strategy: row.strategy,
            hash: row.hash, originalAvailable: row.degraded === 0 && row.original_text !== null,
            seq: row.seq ?? null,
        }));
        const audit = (session === undefined
            ? db.prepare('SELECT * FROM audit ORDER BY ts DESC, id DESC LIMIT ?').all(cap)
            : db.prepare('SELECT * FROM audit WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT ?').all(session, cap));
        const auditRows = audit.map((a) => ({
            kind: 'audit', ts: a.ts, toolName: a.tool_name, callId: a.call_id, sessionId: a.session_id,
            state: a.state, reason: a.reason, charsBefore: a.chars_before, charsAfter: a.chars_after,
            strategy: a.strategy, hash: '', originalAvailable: false, seq: null,
        }));
        return [...ledgerRows, ...auditRows].sort((a, b) => b.ts - a.ts).slice(0, cap);
    }
    /**
     * Retention pass: demote fresh-window-expired originals, then enforce the
     * byte budget by demoting oldest-last-seen first. Safe to call often.
     */
    gc() {
        const db = this.db;
        if (db === undefined)
            return;
        const now = Date.now();
        try {
            const expired = db.prepare('UPDATE ccr SET original_text = NULL, degraded = 1 WHERE degraded = 0 AND fresh_until <= ?').run(now);
            if (expired.changes > 0)
                this.demotedCount += Number(expired.changes);
            this.enforceBudget();
        }
        catch (error) {
            this.options.logger.warn(LOG_TAG + ': ccr gc failed: ' + String(error));
        }
    }
    liveBytes() {
        const db = this.db;
        if (db === undefined)
            return 0;
        const row = db.prepare('SELECT COALESCE(SUM(LENGTH(CAST(original_text AS BLOB))), 0) AS bytes FROM ccr WHERE degraded = 0').get();
        return Number(row.bytes);
    }
    enforceBudget() {
        const db = this.db;
        if (db === undefined)
            return;
        let over = this.liveBytes() > this.options.maxBytes;
        let guard = 0;
        while (over && guard < 200) {
            guard++;
            const victim = db.prepare('SELECT hash FROM ccr WHERE degraded = 0 ORDER BY last_seen_at ASC, stored_at ASC LIMIT 1').get();
            if (victim === undefined)
                break;
            db.prepare('UPDATE ccr SET original_text = NULL, degraded = 1 WHERE hash = ?').run(victim.hash);
            this.demotedCount++;
            over = this.liveBytes() > this.options.maxBytes;
        }
        // legacy hard ceiling on ledger rows (count, not bytes)
        const count = db.prepare('SELECT COUNT(*) AS n FROM ccr').get();
        const ceiling = Math.max(this.options.maxEntries, 1000);
        if (Number(count.n) > ceiling) {
            db.prepare('DELETE FROM ccr WHERE hash NOT IN (SELECT hash FROM ccr ORDER BY stored_at DESC LIMIT ?)').run(ceiling);
        }
    }
    /**
     * Distinct non-empty session ids owning ledger rows (reconciliation face).
     * @returns session ids present in the ledger.
     */
    sessionIds() {
        const db = this.db;
        if (db === undefined)
            return [];
        const rows = db.prepare("SELECT DISTINCT session_id FROM ccr WHERE session_id <> ''")
            .all();
        return rows.map((r) => r.session_id);
    }
    /**
     * Cascade-remove every ledger and audit row of one deleted session.
     * @returns the number of removed rows across both tables.
     */
    deleteSession(sessionId) {
        const db = this.db;
        if (db === undefined || sessionId.length === 0)
            return 0;
        try {
            const a = db.prepare('DELETE FROM ccr WHERE session_id = ?').run(sessionId);
            const b = db.prepare('DELETE FROM audit WHERE session_id = ?').run(sessionId);
            return Number(a.changes) + Number(b.changes);
        }
        catch (error) {
            this.options.logger.warn(LOG_TAG + ': ccr deleteSession failed: ' + String(error));
            return 0;
        }
    }
    /** Current counters, live byte total, and browsing state. */
    stats() {
        const db = this.db;
        let entries = 0;
        if (db !== undefined) {
            const row = db.prepare('SELECT COUNT(*) AS n FROM ccr WHERE degraded = 0').get();
            entries = Number(row.n);
        }
        return {
            entries, hits: this.hitsCount, misses: this.missesCount, writes: this.writesCount,
            demoted: this.demotedCount, bytesLive: this.liveBytes(),
        };
    }
    /** Compatibility no-op (SQLite writes are immediate). */
    flush() { }
    /** Close the database (plugin unload). */
    dispose() {
        this.disposed = true;
        try {
            this.db?.close();
        }
        catch { /* already closed */ }
        this.db = undefined;
    }
}
//# sourceMappingURL=store.js.map