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
import type { Context } from 'cordis';
import type ToolRegistry from '@deepseek-ai/dsh-tools';
import type { Config as RawBridgeConfig } from './config.js';
export declare const name = "@dsh-external/dsh-headroom-bridge";
/** Require the tool registry and the webserver the web card fetches. */
export declare const inject: string[];
/**
 * Config validator face for loaders probing a standard-schema-style export;
 * resolution itself runs inside apply() and throws on invalid input so
 * misconfiguration fails loud at load.
 */
export declare const Config: {
    '~standard': {
        version: 1;
        vendor: string;
        validate(value: unknown): {
            value: unknown;
            issues?: undefined;
        } | {
            issues: {
                message: string;
            }[];
            value?: undefined;
        };
    };
};
/**
 * Plugin entry point.
 * @param ctx - cordis context to mount effects on.
 * @param config - partial bridge configuration (composition layer).
 */
export declare function apply(ctx: Context & {
    tools: ToolRegistry;
}, config: RawBridgeConfig | undefined): void;
