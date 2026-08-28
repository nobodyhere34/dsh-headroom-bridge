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
import { LOG_TAG, PKG_NAME, resolveConfig } from './config.js';
import { installArmA } from './arm-a.js';
import { installArmB } from './arm-b.js';
import { installApi } from './api.js';
import { createConfigSource, installSettings } from './settings.js';
import { CcrStore } from './store.js';
import { retrieveStatsTool, retrieveTool } from './tools.js';
import { newCounters } from './stats.js';
export const name = PKG_NAME;
/** Require the tool registry and the webserver the web card fetches. */
export const inject = ['tools', 'webServer'];
/**
 * Config validator face for loaders probing a standard-schema-style export;
 * resolution itself runs inside apply() and throws on invalid input so
 * misconfiguration fails loud at load.
 */
export const Config = {
    '~standard': {
        version: 1,
        vendor: PKG_NAME,
        validate(value) {
            try {
                resolveConfig(value);
                return { value };
            }
            catch (error) {
                return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
            }
        },
    },
};
/**
 * Plugin entry point.
 * @param ctx - cordis context to mount effects on.
 * @param config - partial bridge configuration (composition layer).
 */
export function apply(ctx, config) {
    const source = createConfigSource(config);
    const initial = source.get();
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
    const store = new CcrStore({ enabled: initial.ccr.enabled, ttlMs: initial.ccr.ttlMs, maxEntries: initial.ccr.maxEntries, path: initial.ccr.path, logger: ctx.logger });
    store.init();
    // Finalizer-only effect: persistence state dies with the fiber.
    ctx.effect(() => () => { store.dispose(); }, LOG_TAG + ': ccr store lifecycle');
    // The client is stateless; resolving a fresh one per use makes baseUrl and
    // timeoutMs hot-edits take effect without rebuilding the fiber.
    const getClient = () => new HeadroomClient(source.get().baseUrl, source.get().timeoutMs);
    const getConfig = () => source.get();
    void getClient().health().then((healthy) => {
        ctx.logger.info(LOG_TAG + ': proxy health at ' + source.get().baseUrl + ' healthy=' + healthy);
    });
    installSettings(ctx, source, config);
    installApi(ctx, source, store, counters, getClient);
    ctx.effect(() => installArmA(ctx, getConfig, store, getClient, counters), LOG_TAG + ': arm-a post-execute');
    ctx.effect(() => installArmB(ctx, getConfig, store, getClient, counters), LOG_TAG + ': arm-b pre-step');
    ctx.effect(() => ctx.tools.register(retrieveTool(ctx, getConfig, store, getClient)), LOG_TAG + ': retrieve tool');
    ctx.effect(() => ctx.tools.register(retrieveStatsTool(ctx, getConfig, store, counters)), LOG_TAG + ': stats tool');
}
//# sourceMappingURL=index.js.map