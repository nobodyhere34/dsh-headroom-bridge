/**
 * Host HTTP API consumed by the web settings card (same-origin fetch).
 *
 * Routes under /headroom-bridge/api expose bridge counters, ledger browsing,
 * and proxy health without needing a Typert remote contract: the web card
 * fetches JSON exactly like the super-injector panel does.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CcrStore } from './store.js';
import type { HeadroomClient } from './proxy-client.js';
import type { ConfigSource } from './settings.js';
import type { BridgeCounters } from './stats.js';
/**
 * Install the bridge HTTP routes on one context.
 * @param ctx - plugin context with the webserver service.
 * @param source - mutable config source for the mode/baseUrl projection.
 * @param store - CCR ledger for browsing.
 * @param counters - arm counters for the stats projection.
 * @param getClient - thunk resolving the current proxy client.
 */
export declare function installApi(ctx: Context, source: ConfigSource, store: CcrStore, counters: BridgeCounters, getClient: () => HeadroomClient): void;
