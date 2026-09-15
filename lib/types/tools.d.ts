/** Model-facing consumers: headroom_retrieve. @module */
import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedConfig } from './config.js';
import type { CcrStore } from './store.js';
import type { HeadroomClient } from './proxy-client.js';
/** Retrieve-tool JSON outcome. */
export interface RetrieveOutcome {
    id: string;
    found: boolean;
    content?: string;
    toolName?: string;
    charsBefore?: number;
    charsAfter?: number;
    source?: 'local' | 'proxy';
    detail?: string;
}
/**
 * headroom_retrieve restores one compressed original by hash: local store
 * first (zero latency), proxy CCR store as fallback for proxies' own row-drop
 * markers. Misses are first-class results, never throws.
 */
export declare function retrieveTool(ctx: Context, getConfig: () => ResolvedConfig, store: CcrStore, getClient: () => HeadroomClient): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** headroom_stats: per-fiber arm counters plus live ledger size. */
export declare function retrieveStatsTool(ctx: Context, getConfig: () => ResolvedConfig, store: CcrStore, counters: import('./stats.js').BridgeCounters): import("@deepseek-ai/dsh-tools").ToolDefinition;
