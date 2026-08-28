/**
 * Host HTTP API consumed by the web settings card (same-origin fetch).
 *
 * Routes under /headroom-bridge/api expose bridge counters, ledger browsing,
 * and proxy health without needing a Typert remote contract: the web card
 * fetches JSON exactly like the super-injector panel does.
 * @module
 */
import { LOG_TAG } from './config.js';
const API_PREFIX = '/headroom-bridge/api';
function send(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}
/**
 * Install the bridge HTTP routes on one context.
 * @param ctx - plugin context with the webserver service.
 * @param source - mutable config source for the mode/baseUrl projection.
 * @param store - CCR ledger for browsing.
 * @param counters - arm counters for the stats projection.
 * @param getClient - thunk resolving the current proxy client.
 */
export function installApi(ctx, source, store, counters, getClient) {
    ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
            try {
                const path = new URL(req.url ?? '/', 'http://localhost').pathname
                    .replace(new RegExp('^' + API_PREFIX.replace(/\//g, '\\/')), '') || '/';
                const cfg = source.get();
                if (req.method === 'GET' && path === '/stats') {
                    const st = store.stats();
                    return send(res, 200, {
                        ok: true,
                        mode: cfg.mode,
                        enabled: cfg.enabled,
                        baseUrl: cfg.baseUrl,
                        counters,
                        ledger: st,
                    });
                }
                if (req.method === 'GET' && path === '/ledger/recent') {
                    const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
                    const limit = Math.min(50, Math.max(1, Number(q.get('limit') ?? 10)));
                    return send(res, 200, { ok: true, entries: store.recent(limit) });
                }
                if (req.method === 'GET' && path === '/health') {
                    const healthy = await getClient().health();
                    return send(res, 200, { ok: true, healthy });
                }
                return send(res, 404, { ok: false, error: 'not found' });
            }
            catch (error) {
                send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
        },
    }), LOG_TAG + ': api routes');
}
//# sourceMappingURL=api.js.map