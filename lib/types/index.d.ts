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
import type { Context, Volatile } from '@deepseek-ai/cordis';
import type ToolRegistry from '@deepseek-ai/dsh-tools';
import { Config } from './config.js';
import type { ArmBConfig, CcrConfig } from './config.js';
export declare const name = "@nobodyhere34/dsh-headroom-bridge";
/** Require the tool registry and the webserver the web card fetches. */
export declare const inject: string[];
export { Config };
/**
 * apply's config parameter: the schema's `.volatile()` fields arrive as live
 * getters (a hot edit is read at the next get, no fiber rebuild); the rest
 * arrive as resolved plain values (cordis.yml, restart semantics).
 */
interface ApplyConfig {
    enabled: Volatile<boolean>;
    mode: Volatile<'audit' | 'live'>;
    baseUrl: Volatile<string>;
    timeoutMs: Volatile<number>;
    minChars: Volatile<number>;
    minSavingsRatio: Volatile<number>;
    protectErrorOutputs: Volatile<boolean>;
    excludeTools: string[];
    protectPathGlobs: string[];
    maxInflight: number;
    armB: Partial<ArmBConfig>;
    ccr: Partial<CcrConfig>;
}
/**
 * Plugin entry point.
 * @param ctx - cordis context to mount effects on.
 * @param config - the resolved entry config (volatile fields are live getters).
 */
export declare function apply(ctx: Context & {
    tools: ToolRegistry;
}, config: ApplyConfig): void;
