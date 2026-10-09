/**
 * dsh-headroom-bridge - Headroom content-aware compression for dsh.

 * Mounts:
 *  1. Arm A: a tools/post-execute transformer compressing NEW plain-text
 *     tool results before materialization (audit default, live opt-in);
 *  2. Arm B: an agent/pre-step shadow-price reclaim of old oversized nodes;
 *  3. headroom_retrieve / headroom_stats model tools;
 *  4. the headroom settings namespace (web card hot-edit) and the host
 *     /headroom-bridge/api JSON routes the card consumes;
 * plus a best-effort local CCR ledger persisted beside the session log.

 * The plugin never alters composition and fails open: any proxy/store/handler
 * failure keeps the untouched original decision.
 * @module
 */
import { HeadroomClient } from './proxy-client.js';
import { Config, LOG_TAG, PKG_NAME, resolveConfig } from './config.js';
import { installArmA } from './arm-a.js';
import { installArmB } from './arm-b.js';
import { installApi } from './api.js';
import { CcrStore } from './store.js';
import { installLifecycle } from './lifecycle.js';
import { retrieveStatsTool, retrieveTool } from './tools.js';
import { newCounters } from './stats.js';
export const name = PKG_NAME;
/** Require the tool registry and the webserver the web card fetches. */
export const inject = ['tools', 'webServer'];
// The Loader entry schema (schemastery). Re-exported so the loader reads it as
// this plugin's Config face: SettingsForms projects it into the web settings
// namespace keyed by the entry id, serving the `.volatile()` fields.
export { Config };
/**
 * Plugin entry point.
 * @param ctx - cordis context to mount effects on.
 * @param config - the resolved entry config (volatile fields are live getters).
 */
export function apply(ctx, config) {
    // Resolve the immutable runtime view fresh on each read: the volatile getters
    // return the card's latest edits, so hot changes need no fiber rebuild, while
    // resolveConfig still runs the full validation + protection gates each pass.
    const getConfig = () => resolveConfig({
        enabled: config.enabled.get(),
        mode: config.mode.get(),
        baseUrl: config.baseUrl.get(),
        timeoutMs: config.timeoutMs.get(),
        minChars: config.minChars.get(),
        minSavingsRatio: config.minSavingsRatio.get(),
        protectErrorOutputs: config.protectErrorOutputs.get(),
        excludeTools: config.excludeTools,
        protectPathGlobs: config.protectPathGlobs,
        maxInflight: config.maxInflight,
        armB: config.armB,
        ccr: config.ccr,
    });
    const initial = getConfig();
    ctx.logger.info(LOG_TAG + ': armed mode=' + initial.mode +
        ' baseUrl=' + initial.baseUrl +
        ' minChars=' + initial.minChars +
        ' minSavings=' + initial.minSavingsRatio +
        ' inflight<=' + initial.maxInflight +
        ' ccrEnabled=' + initial.ccr.enabled);
    if (!initial.enabled)
        return;
    const counters = newCounters();
    // CCR ledger options are fixed at construct time; ccr.* hot-edits follow
    // restart semantics (documented in README).
    const store = new CcrStore({
        enabled: initial.ccr.enabled,
        ttlMs: initial.ccr.ttlMs,
        maxEntries: initial.ccr.maxEntries,
        maxBytes: initial.ccr.maxBytes,
        auditKeep: initial.ccr.auditKeep,
        path: initial.ccr.path,
        logger: ctx.logger,
    });
    store.init();
    // Finalizer-only effect: persistence state dies with the fiber.
    ctx.effect(() => () => { store.dispose(); }, LOG_TAG + ': ccr store lifecycle');
    ctx.effect(() => installLifecycle(ctx, store, initial.ccr.gcIntervalMs), LOG_TAG + ': ccr lifecycle (gc + cascade + reconcile)');
    // The client is stateless; resolving a fresh one per use makes baseUrl and
    // timeoutMs hot-edits take effect without rebuilding the fiber.
    const getClient = () => new HeadroomClient(getConfig().baseUrl, getConfig().timeoutMs);
    void getClient().health().then((healthy) => {
        ctx.logger.info(LOG_TAG + ': proxy health at ' + getConfig().baseUrl + ' healthy=' + healthy);
    });
    installApi(ctx, getConfig, store, counters, getClient);
    ctx.effect(() => installArmA(ctx, getConfig, store, getClient, counters), LOG_TAG + ': arm-a post-execute');
    ctx.effect(() => installArmB(ctx, getConfig, store, getClient, counters), LOG_TAG + ': arm-b pre-step');
    ctx.effect(() => ctx.tools.register(retrieveTool(ctx, getConfig, store, getClient)), LOG_TAG + ': retrieve tool');
    ctx.effect(() => ctx.tools.register(retrieveStatsTool(ctx, getConfig, store, counters)), LOG_TAG + ': stats tool');
}
//# sourceMappingURL=index.js.map