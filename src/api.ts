/**
 * Host HTTP API consumed by the web settings card (same-origin fetch).
 *
 * Routes under /headroom-bridge/api expose bridge counters, ledger browsing,
 * and proxy health without needing a Typert remote contract: the web card
 * fetches JSON exactly like the super-injector panel does.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { LOG_TAG } from './config.js'
import type { CcrStore } from './store.js'
import type { HeadroomClient } from './proxy-client.js'
import type { ConfigSource } from './settings.js'
import type { BridgeCounters } from './stats.js'
// Type-only: the ctx.webServer Context merge.
import type {} from '@deepseek-ai/dsh-host-webserver'

const API_PREFIX = '/headroom-bridge/api'

function send(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

/**
 * Install the bridge HTTP routes on one context.
 * @param ctx - plugin context with the webserver service.
 * @param source - mutable config source for the mode/baseUrl projection.
 * @param store - CCR ledger for browsing.
 * @param counters - arm counters for the stats projection.
 * @param getClient - thunk resolving the current proxy client.
 */
export function installApi(
  ctx: Context,
  source: ConfigSource,
  store: CcrStore,
  counters: BridgeCounters,
  getClient: () => HeadroomClient,
): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix' as const,
    path: API_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname
          .replace(new RegExp('^' + API_PREFIX.replace(/\//g, '\\/')), '') || '/'
        const cfg = source.get()
        if (req.method === 'GET' && path === '/stats') {
          const st = store.stats()
          return send(res, 200, {
            ok: true,
            mode: cfg.mode,
            enabled: cfg.enabled,
            baseUrl: cfg.baseUrl,
            counters,
            ledger: st,
          })
        }
        if (req.method === 'GET' && path === '/ledger/recent') {
          const q = new URL(req.url ?? '/', 'http://localhost').searchParams
          const limit = Math.min(50, Math.max(1, Number(q.get('limit') ?? 10)))
          return send(res, 200, { ok: true, entries: store.recent(limit) })
        }
        // Merged ledger + audit activity stream (card "recent operations").
        if (req.method === 'GET' && path === '/ledger/activity') {
          const q = new URL(req.url ?? '/', 'http://localhost').searchParams
          const limit = Math.min(100, Math.max(1, Number(q.get('limit') ?? 20)))
          const session = q.get('session') ?? undefined
          return send(res, 200, { ok: true, rows: store.activity(limit, session) })
        }
        // One ledger row's metadata + original text for the trajectory chip's
        // before/after compare. 404s (rather than 200-with-null) when the
        // hash is unknown or its original has been demoted, so the chip can
        // show "expired" distinctly from a live compare.
        if (req.method === 'GET' && path === '/ledger/entry') {
          const q = new URL(req.url ?? '/', 'http://localhost').searchParams
          const hash = q.get('hash') ?? ''
          const found = store.inspect(hash)
          if (found === undefined) return send(res, 404, { ok: false, error: 'unknown hash' })
          if (found.originalText === null) return send(res, 404, { ok: false, error: 'original expired', meta: found.row })
          return send(res, 200, { ok: true, meta: found.row, originalText: found.originalText })
        }
        if (req.method === 'GET' && path === '/health') {
          const healthy = await getClient().health()
          return send(res, 200, { ok: true, healthy })
        }
        return send(res, 404, { ok: false, error: 'not found' })
      } catch (error: unknown) {
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), LOG_TAG + ': api routes')
}
