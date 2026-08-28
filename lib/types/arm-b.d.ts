/**
 * Arm B: reclaim OLD oversized tool results at the next step boundary.
 *
 * Arm A compresses NEW results before materialization; Arm B backstops the
 * rare misses (proxy unreachable at the time, a transient skip, or an
 * exactly-once attempt before an operator flipped the mode). It walks the
 * current surface inside agent/pre-step and shadow-replaces any
 * over-threshold tool-result node that the protection gates allow, following
 * the shared shadow-price protocol: a log-only compaction/prune metering
 * event immediately followed by a tool/result surface replace citing the
 * shadowed node, so the original stays in the session log and replay/fork
 * reconstructs both the compressed view and the verbatim text.
 *
 * High threshold + small per-pass budget keep this a rare backstop, not a
 * hot-path rewrite of already-sent history.
 * @module
 */
import type { Context } from 'cordis';
import type { ResolvedConfig } from './config.js';
import { CcrStore } from './store.js';
import { HeadroomClient } from './proxy-client.js';
import type { BridgeCounters } from './stats.js';
/**
 * Install the arm-B pre-step listener on one context.
 * @returns a disposer; Cordis also unwinds listeners on fiber disposal.
 */
export declare function installArmB(ctx: Context, getConfig: () => ResolvedConfig, store: CcrStore, getClient: () => HeadroomClient, counters: BridgeCounters): () => void;
