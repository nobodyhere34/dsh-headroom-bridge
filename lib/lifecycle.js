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
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_TAG } from './config.js';
/** Trash ledger root kept by dsh-session-manager, beside the DSH home. */
function trashRoot() {
    const home = process.env.DSH_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh');
    return join(home, 'dsh-delete-session-trash');
}
/** Session ids currently parked in the trash root (restorable, must survive). */
function trashedSessionIds() {
    const root = trashRoot();
    try {
        if (!existsSync(root))
            return new Set();
        return new Set(readdirSync(root, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name));
    }
    catch {
        return new Set();
    }
}
/**
 * Install the lifecycle channels onto one context.
 * @param ctx - plugin context.
 * @param store - the SQLite ledger.
 * @param gcIntervalMs - retention timer period.
 * @returns a disposer. Cordis also unwinds listeners and effects on unload.
 */
export function installLifecycle(ctx, store, gcIntervalMs) {
    // Channel 1: session-delete cascade via the trash domain's change event.
    // The snapshot carries the whole current trash set; the cascade is applied
    // unconditionally to every id (deleteSession on an unknown id is a cheap
    // no-op), so no baseline priming is needed: the first delete after a
    // restart cascades immediately, a restored session simply starts with no
    // originals (CCR was never a log replacement), and the set is bounded by
    // the manager's trash limit.
    const offDomain = ctx.on('domain/changed', (change) => {
        if (change.domain !== 'dsh_delete_session' || change.table !== '' || change.operation !== 'put')
            return;
        const value = change.value;
        const entries = Array.isArray(value?.entries) ? value.entries : [];
        for (const entry of entries) {
            const id = typeof entry.sessionId === 'string' ? entry.sessionId : '';
            if (id.length === 0)
                continue;
            const removed = store.deleteSession(id);
            if (removed > 0)
                ctx.logger.info(LOG_TAG + ': session trashed, cascaded ' + removed + ' ledger rows (' + id + ')');
        }
    });
    // Channel 3: a durable `compaction/summary`/`compaction/prune` event
    // proves history just left the context window, so a retention pass runs
    // immediately (debounced so a burst of events runs a single pass).
    let compactionTick;
    const offEvent = ctx.on('session/event', (_session, event) => {
        if (event?.type !== 'compaction/summary' && event?.type !== 'compaction/prune')
            return;
        if (compactionTick !== undefined)
            return;
        compactionTick = setTimeout(() => {
            compactionTick = undefined;
            store.gc();
        }, 2_000);
        compactionTick.unref?.();
    });
    // Reconciliation: sweep orphan ledger rows for sessions neither persisted
    // nor trashed (a delete that bypassed the domain). Never runs before the
    // first list() resolves; runs at start and on a slow timer.
    const reconcile = async () => {
        let persisted;
        try {
            persisted = ctx.get('sessionPersistence');
        }
        catch {
            persisted = undefined;
        }
        if (persisted === undefined)
            return; // persistence provider not present yet
        let live;
        try {
            const snaps = await persisted.list();
            live = new Set(snaps.map((s) => String(s.header.id)));
        }
        catch {
            return;
        }
        const trashed = trashedSessionIds();
        for (const id of store.sessionIds()) {
            if (live.has(id) || trashed.has(id))
                continue;
            const removed = store.deleteSession(id);
            if (removed > 0)
                ctx.logger.info(LOG_TAG + ': reconcile dropped ' + removed + ' orphan ledger rows (' + id + ')');
        }
    };
    void reconcile().catch((error) => ctx.logger.warn(LOG_TAG + ': reconcile failed: ' + String(error)));
    // Channel 2: the retention timer (reconciliation runs alongside, slower).
    const timer = setInterval(() => {
        store.gc();
    }, Math.max(5_000, gcIntervalMs));
    timer.unref?.();
    const reconcileTimer = setInterval(() => {
        void reconcile().catch((error) => ctx.logger.warn(LOG_TAG + ': reconcile failed: ' + String(error)));
    }, 3_600_000);
    reconcileTimer.unref?.();
    return () => {
        offDomain();
        offEvent();
        clearInterval(timer);
        clearInterval(reconcileTimer);
        if (compactionTick !== undefined)
            clearTimeout(compactionTick);
    };
}
//# sourceMappingURL=lifecycle.js.map