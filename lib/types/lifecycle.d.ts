/**
 * Ledger lifecycle: bounded-lossless retention made real.
 *
 * Three cooperating channels keep the SQLite ledger from outgrowing the
 * session log it shadows:
 *   1. session-delete cascade - `dsh-session-manager` writes every delete to
 *      the `dsh_delete_session` storage domain (its only durable side effect);
 *      the core emits `domain/changed` after each such write. Every event
 *      applies the cascade to the full snapshot (idempotent, bounded by the
 *      trash limit), so the bridge drops every ledger + audit row of a
 *      deleted session the moment it is trashed - including the first delete
 *      after a restart; `purge`/restore need no handling (a restored session
 *      simply starts with no originals; the session log still carries it, and
 *      CCR was never a log replacement).
 *   2. a retention timer running `store.gc()` - demotes originals that left
 *      their fresh window and enforces the byte budget.
 *   3. a compaction trigger - a durable `compaction/summary`/`compaction/prune`
 *      event proves the shadowed history just left the context window, so a
 *      retention pass runs immediately (retrieval demand for those originals
 *      is gone; budget frees for live content).
 * A periodic reconciliation pass (a `sessionPersistence.list()` diff) sweeps
 * orphans left by deletions that never touched the domain (a manual `rm`
 * bypassing the manager); it skips anything still under the trash root.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CcrStore } from './store.js';
declare module '@deepseek-ai/cordis' {
    interface Events {
        'domain/changed'(change: {
            domain: string;
            table: string;
            key: string;
            operation: 'put' | 'deleted';
            value?: unknown;
        }): void;
    }
}
/**
 * Install the lifecycle channels onto one context.
 * @param ctx - plugin context.
 * @param store - the SQLite ledger.
 * @param gcIntervalMs - retention timer period.
 * @returns a disposer. Cordis also unwinds listeners and effects on unload.
 */
export declare function installLifecycle(ctx: Context, store: CcrStore, gcIntervalMs: number): () => void;
