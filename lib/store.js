/**
 * Local CCR store: the bridge-side original-text ledger.
 *
 * Content-addressed (SHA-256 of the exact original, truncated) so repeated
 * identifications share one entry and hashes stay stable across sessions.
 * Persistence is best-effort durability beside the session log - deliberately
 * not a replacement for it (out-of-tree events cannot join the log vocabulary;
 * see RESEARCH-REPORT.md section 11.4 revision decision 1a).
 * @module
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { LOG_TAG } from './config.js';
const STORE_VERSION = 1;
const STORE_FILE_NAME = 'dsh-headroom-bridge-ccr.json';
/** Whether a deserialized record still looks usable. */
function isUsable(value, now) {
    if (value === null || typeof value !== 'object')
        return false;
    const e = value;
    return typeof e.hash === 'string' && e.hash.length > 0 &&
        typeof e.originalText === 'string' &&
        typeof e.toolName === 'string' &&
        typeof e.callId === 'string' &&
        typeof e.storedAt === 'number' && Number.isFinite(e.storedAt) &&
        typeof e.expiresAt === 'number' && Number.isFinite(e.expiresAt) &&
        e.expiresAt > now;
}
/** Resolve the on-disk store path. */
export function defaultStorePath(explicitPath) {
    if (explicitPath.length > 0 && isAbsolute(explicitPath))
        return explicitPath;
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return join(home, 'storages', STORE_FILE_NAME);
}
/** Content-addressed original-text store with debounced atomic persistence. */
export class CcrStore {
    options;
    map = new Map();
    saveTimer;
    dirty = false;
    disposed = false;
    hitsCount = 0;
    missesCount = 0;
    writesCount = 0;
    constructor(options) {
        this.options = options;
    }
    /** Load persisted entries; corrupt files start empty rather than failing. */
    init() {
        const now = Date.now();
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(this.filePath(), 'utf8'));
        }
        catch {
            return; // first run, missing file, or unreadable - start empty
        }
        if (parsed === null || typeof parsed !== 'object')
            return;
        const shape = parsed;
        if (shape.version !== STORE_VERSION || !Array.isArray(shape.entries))
            return;
        for (const raw of shape.entries.slice(-this.options.maxEntries)) {
            if (!isUsable(raw, now))
                continue;
            this.map.set(raw.hash, raw);
        }
    }
    filePath() {
        return defaultStorePath(this.options.path);
    }
    /**
     * Persist one original before its replacement ships (store-before-adopt).
     * @returns the content hash keying the entry.
     */
    put(entry) {
        if (!this.options.enabled || this.disposed)
            return entry.hash;
        this.map.delete(entry.hash); // refresh recency position deterministically
        this.map.set(entry.hash, { ...entry, storedAt: Date.now(), expiresAt: Date.now() + this.options.ttlMs });
        this.evictOverflow();
        this.writesCount++;
        this.scheduleSave();
        return entry.hash;
    }
    evictOverflow() {
        while (this.map.size > this.options.maxEntries) {
            let oldestKey;
            let oldestAt = Infinity;
            for (const [key, entry] of this.map) {
                if (entry.storedAt < oldestAt) {
                    oldestAt = entry.storedAt;
                    oldestKey = key;
                }
            }
            if (oldestKey === undefined)
                break;
            this.map.delete(oldestKey);
        }
    }
    /** Fetch one live entry by hash; expired entries disappear on read. */
    get(hash) {
        const entry = this.map.get(hash);
        if (entry === undefined) {
            this.missesCount++;
            return undefined;
        }
        if (Date.now() >= entry.expiresAt) {
            this.map.delete(hash);
            this.missesCount++;
            return undefined;
        }
        this.hitsCount++;
        return entry;
    }
    /**
     * Most recent live entries by storedAt, newest first (browsing face).
     * @param limit - maximum entries to return.
     * @returns live entries in recency order.
     */
    recent(limit) {
        const sorted = [...this.map.values()]
            .filter((e) => Date.now() < e.expiresAt)
            .sort((a, b) => b.storedAt - a.storedAt);
        return sorted.slice(0, Math.max(0, limit));
    }
    /** Current counters and live entry count. */
    stats() {
        return { entries: this.map.size, hits: this.hitsCount, misses: this.missesCount, writes: this.writesCount };
    }
    scheduleSave() {
        if (!this.dirty) {
            this.dirty = true;
            this.saveTimer = setTimeout(() => { this.flush(); }, 1_000);
            this.saveTimer.unref?.();
        }
    }
    /** Atomic write-through; failures degrade to an in-memory-only store. */
    flush() {
        this.dirty = false;
        if (this.disposed)
            return;
        try {
            const target = this.filePath();
            mkdirSync(dirname(target), { recursive: true });
            const payload = { version: STORE_VERSION, entries: [...this.map.values()] };
            const tmp = join(tmpdir(), STORE_FILE_NAME + '.' + process.pid + '.tmp');
            writeFileSync(tmp, JSON.stringify(payload), 'utf8');
            renameSync(tmp, target);
        }
        catch (error) {
            this.options.logger.warn(LOG_TAG + ': ccr persist failed, keeping memory-only: ' + String(error));
        }
    }
    /** Stop persistence timers and flush immediately (plugin unload). */
    dispose() {
        this.disposed = true;
        if (this.saveTimer !== undefined)
            clearTimeout(this.saveTimer);
        if (!this.dirty)
            return;
        this.dirty = false;
        try {
            const target = this.filePath();
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, JSON.stringify({ version: STORE_VERSION, entries: [...this.map.values()] }), 'utf8');
        }
        catch (error) {
            this.options.logger.warn(LOG_TAG + ': ccr dispose flush failed: ' + String(error));
        }
    }
}
//# sourceMappingURL=store.js.map