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
/** One stored original plus its compression accounting. */
export interface CcrEntry {
    readonly hash: string;
    readonly toolName: string;
    readonly callId: string;
    readonly sessionId: string;
    /** transforms_applied chain from the proxy = the compression type record. */
    readonly strategy: string;
    readonly charsBefore: number;
    readonly charsAfter: number;
    readonly tokensBefore?: number;
    readonly tokensAfter?: number;
    readonly originalText: string;
    readonly storedAt: number;
    readonly expiresAt: number;
    /** Durable log seq when known at put time (arm B reclaims existing nodes). */
    readonly seq?: number;
}
/** One kept/failed attempt audit row (no original text). */
export interface CcrAuditEntry {
    readonly toolName: string;
    readonly callId: string;
    readonly sessionId: string;
    /** skipped | not-adopted | empty-response | inflight-cap | failed */
    readonly state: string;
    readonly reason: string;
    readonly charsBefore: number;
    readonly charsAfter: number;
    readonly strategy: string;
}
/** UI-facing activity row (ledger row or audit row, newest first). */
export interface CcrActivityRow {
    readonly kind: 'ledger' | 'audit';
    readonly ts: number;
    readonly toolName: string;
    readonly callId: string;
    readonly sessionId: string;
    readonly state: string;
    readonly reason: string;
    readonly charsBefore: number;
    readonly charsAfter: number;
    readonly strategy: string;
    readonly hash: string;
    readonly originalAvailable: boolean;
    /** Durable log seq once backfilled (ledger rows only). */
    readonly seq: number | null;
}
/** Store statistics snapshot. */
export interface CcrStats {
    entries: number;
    hits: number;
    misses: number;
    writes: number;
    /** originals demoted to metadata-only (out of window or over budget) */
    demoted: number;
    /** live (non-degraded) original bytes */
    bytesLive: number;
}
/** Minimal logger surface the store needs. */
export interface StoreLogger {
    warn(msg: string): void;
}
/** Resolve the on-disk SQLite path (legacy JSON import source is its sibling). */
export declare function defaultStorePath(explicitPath: string): string;
/** Content-addressed original-text ledger with tiered bounded retention. */
export declare class CcrStore {
    private readonly options;
    private db;
    private disposed;
    private hitsCount;
    private missesCount;
    private writesCount;
    private demotedCount;
    constructor(options: {
        enabled: boolean;
        /** fresh window: while inside it the model may still retrieve the original */
        ttlMs: number;
        /** legacy row cap (kept for API compatibility; hard ceiling on ledger rows) */
        maxEntries: number;
        /** byte budget for live originals; overflow demotes oldest-last-seen first */
        maxBytes: number;
        /** audit rows kept (rolling) */
        auditKeep: number;
        path: string;
        logger: StoreLogger;
    });
    /** Open the database; corrupt/unreadable files start empty rather than failing. */
    init(): void;
    /** Import the v0.x JSON ledger once, then park the file aside. */
    private importLegacy;
    /**
     * Persist one original before its replacement ships (store-before-adopt).
     * @returns the content hash keying the entry.
     */
    put(entry: Omit<CcrEntry, 'storedAt' | 'expiresAt'>): string;
    /** Record one kept/failed attempt (never stores the original). */
    audit(e: CcrAuditEntry): void;
    /**
     * Fetch one live original by hash. Entries outside their fresh window or
     * demoted to metadata-only count as misses (retrieval demand only exists
     * while the content is inside a context window).
     */
    get(hash: string): CcrEntry | undefined;
    /** Metadata + original-presence for one hash (UI detail face; no hit counting). */
    inspect(hash: string): {
        row: CcrActivityRow;
        originalText: string | null;
    } | undefined;
    /**
     * Most recent live originals by storedAt, newest first (browsing face).
     * @param limit - maximum entries to return.
     */
    recent(limit: number): CcrEntry[];
    /**
     * Merged activity stream for the card / audit face: newest ledger + audit
     * rows interleaved by time. Never returns original text.
     * @param limit - maximum rows to return.
     * @param session - when set, only rows of this session (pushed into the
     * queries, so a busy global stream never crowds a session's own rows out).
     */
    activity(limit: number, session?: string): CcrActivityRow[];
    /**
     * Retention pass: demote fresh-window-expired originals, then enforce the
     * byte budget by demoting oldest-last-seen first. Safe to call often.
     */
    gc(): void;
    private liveBytes;
    private enforceBudget;
    /**
     * Distinct non-empty session ids owning ledger rows (reconciliation face).
     * @returns session ids present in the ledger.
     */
    sessionIds(): string[];
    /**
     * Cascade-remove every ledger and audit row of one deleted session.
     * @returns the number of removed rows across both tables.
     */
    deleteSession(sessionId: string): number;
    /** Current counters, live byte total, and browsing state. */
    stats(): CcrStats;
    /** Compatibility no-op (SQLite writes are immediate). */
    flush(): void;
    /** Close the database (plugin unload). */
    dispose(): void;
}
