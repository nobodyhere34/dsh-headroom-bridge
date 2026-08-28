/** Model-facing consumers: headroom_retrieve. @module */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { LOG_TAG } from './config.js';
/**
 * headroom_retrieve restores one compressed original by hash: local store
 * first (zero latency), proxy CCR store as fallback for proxies' own row-drop
 * markers. Misses are first-class results, never throws.
 */
export function retrieveTool(ctx, getConfig, store, getClient) {
    return defineTool({
        name: 'headroom_retrieve',
        description: 'Restore an exact original that headroom compression offloaded; pass the hash shown in its [headroom-bridge ...] marker.',
        parameters: {
            hash: { type: 'string', required: true, description: 'hash= value from a compression marker' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: { type: 'string', required: true },
                    found: { type: 'boolean', required: true },
                    content: { type: 'string' },
                    toolName: { type: 'string' },
                    charsBefore: { type: 'integer' },
                    charsAfter: { type: 'integer' },
                    source: { type: 'string' },
                    detail: { type: 'string' },
                },
            },
            render(_args, value) {
                const r = value;
                if (!r.found)
                    return [{ type: 'text', text: LOG_TAG + ': no original stored for hash=' + r.id + (r.detail ? ' (' + r.detail + ')' : '') }];
                const head = LOG_TAG + ': original for ' + r.id +
                    (r.toolName ? ' via ' + r.toolName : '') +
                    (r.charsBefore !== undefined && r.charsAfter !== undefined ? ' (' + r.charsBefore + '->' + r.charsAfter + ' chars)' : '');
                return [{ type: 'text', text: head + '\n\n' + String(r.content ?? '') }];
            },
        },
        async execute(args) {
            const raw = typeof args.hash === 'string' ? args.hash.trim().toLowerCase() : '';
            const id = /^[0-9a-f]{8,64}$/.test(raw) ? raw : '';
            if (id.length === 0)
                return { id: raw, found: false, detail: 'invalid hash format' };
            const local = store.get(id);
            if (local !== undefined) {
                return {
                    id,
                    found: true,
                    content: local.originalText,
                    toolName: local.toolName,
                    charsBefore: local.charsBefore,
                    charsAfter: local.charsAfter,
                    source: 'local',
                };
            }
            try {
                const res = await getClient().retrieveHash(id);
                const content = typeof res.original_content === 'string' ? res.original_content : undefined;
                if (content === undefined || content.length === 0) {
                    return { id, found: false, detail: 'proxy returned no content' };
                }
                return { id, found: true, content, source: 'proxy' };
            }
            catch (error) {
                return { id, found: false, detail: error instanceof Error ? error.message : String(error) };
            }
        },
    });
}
/** headroom_stats: per-fiber arm counters plus live ledger size. */
export function retrieveStatsTool(ctx, getConfig, store, counters) {
    return defineTool({
        name: 'headroom_stats',
        description: 'Show headroom-bridge compression counters and local CCR ledger size.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    mode: { type: 'string', required: true },
                    attempts: { type: 'integer', required: true },
                    failures: { type: 'integer', required: true },
                    adopted: { type: 'integer', required: true },
                    savedChars: { type: 'integer', required: true },
                    ledgerEntries: { type: 'integer', required: true },
                },
            },
            render(_args, value) {
                const r = value;
                return [{ type: 'text', text: LOG_TAG + ': mode=' + String(r.mode) +
                            ' attempts=' + String(r.attempts) +
                            ' failures=' + String(r.failures) +
                            ' adopted=' + String(r.adopted) +
                            ' savedChars=' + String(r.savedChars) +
                            ' ledgerEntries=' + String(r.ledgerEntries) }];
            },
        },
        async execute() {
            const st = store.stats();
            return {
                mode: getConfig().mode,
                attempts: counters.attempts,
                failures: counters.failures,
                adopted: counters.adopted,
                savedChars: counters.savedChars,
                ledgerEntries: st.entries,
            };
        },
    });
}
//# sourceMappingURL=tools.js.map