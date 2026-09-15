/**
 * Arm A: compress NEW tool results before they materialize.
 *
 * Ordered per docs/tool-execution-pipeline.md: listeners run inside the
 * tools/post-execute waterfall and MUST await next() first, so downstream
 * policy settles before we inspect what will ship. The acceptance chain is
 * RESEARCH-REPORT.md section 10.7: DSH-side protection gates, exactly-once
 * attempt per callId, inflight cap, proxy call under CCR mode, savings +
 * strict-shrink validation, then (live mode) store-before-ship adoption.
 * Every failure path keeps the original decision untouched (fail-open).
 * @module
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedConfig } from './config.js';
import { CcrStore } from './store.js';
import { HeadroomClient } from './proxy-client.js';
import type { BridgeCounters } from './stats.js';
/**
 * Install the arm-A waterfall listener on one context.
 * @returns a disposer; Cordis also unwinds listeners on fiber disposal.
 */
export declare function installArmA(ctx: Context, getConfig: () => ResolvedConfig, store: CcrStore, getClient: () => HeadroomClient, counters: BridgeCounters): () => void;
