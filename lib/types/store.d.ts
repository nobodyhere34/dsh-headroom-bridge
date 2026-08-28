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
/** One stored original plus its compression accounting. */
export interface CcrEntry {
    readonly hash: string;
    readonly toolName: string;
    readonly callId: string;
    readonly sessionId: string;
    readonly strategy: string;
    readonly charsBefore: number;
    readonly charsAfter: number;
    readonly originalText: string;
    readonly storedAt: number;
    readonly expiresAt: number;
}
/** Store statistics snapshot. */
export interface CcrStats {
    entries: number;
    hits: number;
    misses: number;
    writes: number;
}
/** Minimal logger surface the store needs. */
export interface StoreLogger {
    warn(msg: string): void;
}
/** Resolve the on-disk store path. */
export declare function defaultStorePath(explicitPath: string): string;
/** Content-addressed original-text store with debounced atomic persistence. */
export declare class CcrStore {
    private readonly options;
    private readonly map;
    private saveTimer;
    private dirty;
    private disposed;
    private hitsCount;
    private missesCount;
    private writesCount;
    constructor(options: {
        enabled: boolean;
        ttlMs: number;
        maxEntries: number;
        path: string;
        logger: StoreLogger;
    });
    /** Load persisted entries; corrupt files start empty rather than failing. */
    init(): void;
    private filePath;
    /**
     * Persist one original before its replacement ships (store-before-adopt).
     * @returns the content hash keying the entry.
     */
    put(entry: Omit<CcrEntry, 'storedAt' | 'expiresAt'>): string;
    private evictOverflow;
    /** Fetch one live entry by hash; expired entries disappear on read. */
    get(hash: string): CcrEntry | undefined;
    /**
     * Most recent live entries by storedAt, newest first (browsing face).
     * @param limit - maximum entries to return.
     * @returns live entries in recency order.
     */
    recent(limit: number): CcrEntry[];
    /** Current counters and live entry count. */
    stats(): CcrStats;
    private scheduleSave;
    /** Atomic write-through; failures degrade to an in-memory-only store. */
    flush(): void;
    /** Stop persistence timers and flush immediately (plugin unload). */
    dispose(): void;
}
