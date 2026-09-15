/**
 * Host-surface coverage: proxy client wire branches, model tools, the
 * mutable config source + settings wiring, the HTTP API routes, and the
 * plugin entry apply().
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeadroomClient, compressedContentOf } from '../src/proxy-client.ts'
import { retrieveTool, retrieveStatsTool } from '../src/tools.ts'
import { createConfigSource, installSettings } from '../src/settings.ts'
import { installApi } from '../src/api.ts'
import { CcrStore } from '../src/store.ts'
import { newCounters } from '../src/stats.ts'
import { apply } from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'

const quiet = { info() {}, warn() {}, debug() {}, error() {} }

afterEach(() => { vi.unstubAllGlobals() })

describe('proxy-client', () => {
  it('compressedContentOf extracts only well-shaped string content', () => {
    expect(compressedContentOf({ messages: [{ content: 'ok' }], tokens_before: 1, tokens_after: 1 })).toBe('ok')
    expect(compressedContentOf({ messages: [], tokens_before: 1, tokens_after: 1 })).toBeUndefined()
    expect(compressedContentOf({ messages: [null as never], tokens_before: 1, tokens_after: 1 })).toBeUndefined()
    expect(compressedContentOf({ messages: [{ content: 42 }], tokens_before: 1, tokens_after: 1 })).toBeUndefined()
    expect(compressedContentOf({ messages: [{ content: '   ' }], tokens_before: 1, tokens_after: 1 })).toBeUndefined()
  })

  it('health reports reachability without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    expect(await new HeadroomClient('http://p').health()).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    expect(await new HeadroomClient('http://p').health()).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    expect(await new HeadroomClient('http://p').health()).toBe(false)
  })

  it('compressToolMessage posts a CCR tool message and honors the override', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ messages: [{ content: 'c' }], tokens_before: 10, tokens_after: 2 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new HeadroomClient('http://p')
    const out = await client.compressToolMessage({ toolCallId: 'c1', text: 'x'.repeat(500), model: 'm', timeoutMs: 1234 })
    expect(out.tokens_before).toBe(10)
    expect(fetchMock).toHaveBeenCalledWith('http://p/v1/compress', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as {
      config: { mode: string }
      messages: Array<{ tool_call_id: string }>
    }
    expect(body.config.mode).toBe('ccr')
    expect(body.messages[0]!.tool_call_id).toBe('c1')
  })

  it('compressToolMessage throws on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    await expect(new HeadroomClient('http://p').compressToolMessage({ toolCallId: 'c', text: 't', model: 'm' })).rejects.toThrow(/500/)
  })

  it('retrieveHash returns the payload and throws on misses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ original_content: 'orig' }), { status: 200 })))
    expect((await new HeadroomClient('http://p').retrieveHash('abc123')).original_content).toBe('orig')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })))
    await expect(new HeadroomClient('http://p').retrieveHash('abc123')).rejects.toThrow(/404/)
  })
})

describe('model tools', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'hb-tools-'))
    const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'ccr.json'), logger: quiet })
    store.init()
    const counters = newCounters()
    const responses: Array<Record<string, unknown> | Error> = []
    const client = {
      async retrieveHash() {
        const r = responses.shift()
        if (r instanceof Error) throw r
        return r ?? {}
      },
    }
    return { dir, store, counters, client, responses }
  }

  it('headroom_retrieve: invalid hash, local hit, proxy paths', async () => {
    const { dir, store, client, responses } = setup()
    const tool = retrieveTool(store, () => client as never) as unknown as {
      execute(args: Record<string, unknown>): Promise<Record<string, unknown>>
      output: { render(a: unknown, v: unknown): Array<{ type: string; text: string }> }
    }
    expect((await tool.execute({ hash: 'not-a-hash!' })).found).toBe(false)
    store.put({ hash: 'aabbccdd', toolName: 'bash', callId: 'c', sessionId: 's', strategy: 'x', charsBefore: 10, charsAfter: 2, originalText: 'the original' })
    const hit = await tool.execute({ hash: 'AABBCCDD' })
    expect(hit).toMatchObject({ found: true, source: 'local', content: 'the original', toolName: 'bash' })
    responses.push({ original_content: 'proxy original' })
    const ph = await tool.execute({ hash: 'deadbeef' })
    expect(ph).toMatchObject({ found: true, source: 'proxy', content: 'proxy original' })
    responses.push({})
    expect((await tool.execute({ hash: 'deadbeef' })).detail).toMatch(/no content/)
    responses.push(new Error('proxy down'))
    expect((await tool.execute({ hash: 'deadbeef' })).detail).toMatch(/proxy down/)
    // renders
    expect(tool.output.render(null, hit)[0]!.text).toContain('the original')
    expect(tool.output.render(null, { id: 'x', found: false })[0]!.text).toContain('no original stored')
    rmSync(dir, { recursive: true, force: true })
  })

  it('headroom_stats: execute and render', async () => {
    const { dir, store, counters } = setup()
    const tool = retrieveStatsTool(() => resolveConfig({ mode: 'live' }), store, counters) as unknown as {
      execute(args: Record<string, unknown>, ctx: never): Promise<Record<string, unknown>>
      output: { render(a: unknown, v: unknown): Array<{ type: string; text: string }> }
    }
    counters.attempts = 3; counters.adopted = 1; counters.savedChars = 50
    await expect(tool.execute({}, {} as never)).resolves.toMatchObject({ mode: 'live', attempts: 3, adopted: 1, savedChars: 50 })
    expect(tool.output.render(null, { mode: 'audit', attempts: 0, failures: 0, adopted: 0, savedChars: 0, ledgerEntries: 0 })[0]!.text).toContain('mode=audit')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('config source + settings wiring', () => {
  it('createConfigSource resolves and re-resolves raw layers', () => {
    const source = createConfigSource(undefined)
    expect(source.get().mode).toBe('audit')
    source.setRaw({ mode: 'live' })
    expect(source.get().mode).toBe('live')
    expect(() =>{  source.setRaw({ minChars: -5 }) }).toThrow()
    expect(source.get().mode).toBe('live') // last good retained
  })

  it('installSettings wires setSource/onChange through the settings seam', () => {
    const source = createConfigSource(undefined)
    let injectCb: ((sctx: unknown) => void) | undefined
    let watcher: (() => void) | undefined
    const ctx = {
      inject(_deps: string[], cb: (sctx: unknown) => void) { injectCb = cb },
      fiber: { state: 0 },
    } as never
    const scope = {
      get: () => ({ mode: 'live' }),
      watch: (fn: () => void) => { watcher = fn },
    }
    let disposer: (() => void) | undefined
    const sctx = {
      settings: { register: (_ns: string, _schema: unknown, opts: { base: unknown }) => { expect(opts.base).toBeDefined(); return scope } },
      effect(fn: () => unknown) { disposer = fn() as () => void },
    }
    installSettings(ctx, source, { mode: 'audit' })
    expect(injectCb).toBeDefined()
    injectCb!(sctx)
    expect(source.get().mode).toBe('live') // onChange re-resolved from the scope
    expect(watcher).toBeDefined()
    disposer!() // detach: fall back to the composition entry and re-notify
    expect(source.get().mode).toBe('audit')
  })
})

describe('installApi routes', () => {
  interface DriveBody {
    ok?: boolean
    error?: string
    healthy?: boolean
    mode?: string
    enabled?: boolean
    baseUrl?: string
    entries?: Array<{ toolName?: string; originalText?: string }>
  }
  interface DriveResult {
    code: number | undefined
    body: DriveBody | null
  }
  function drive(
    handler: (req: unknown, res: unknown) => void | Promise<void>,
    method: string,
    url: string,
  ): Promise<DriveResult> {
    const res = { writeHead: vi.fn(), end: vi.fn() }
    const req = { method, url }
    return Promise.resolve(handler(req, res)).then(() => ({
      code: res.writeHead.mock.calls[0]?.[0] as number | undefined,
      body: res.end.mock.calls[0]?.[0]
        ? JSON.parse(res.end.mock.calls[0][0] as string) as DriveBody
        : null,
    }))
  }

  it('serves stats, ledger, health and 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-api-'))
    const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'ccr.json'), logger: quiet })
    store.init()
    store.put({ hash: '0123456789abcdef', toolName: 'bash', callId: 'c', sessionId: 's', strategy: 'x', charsBefore: 100, charsAfter: 10, originalText: 'o' })
    const counters = newCounters()
    let route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> } | undefined
    const ctx = {
      effect(fn: () => void) { fn() },
      webServer: { register: (r: typeof route) => { route = r } },
    } as never
    const source = createConfigSource({ mode: 'live', baseUrl: 'http://p' })
    const client = { health: vi.fn(async () => true) }
    installApi(ctx, source, store, counters, () => client as never)
    expect(route?.path).toBe('/headroom-bridge/api')
    const stats = await drive(route!.handler, 'GET', '/headroom-bridge/api/stats')
    expect(stats.code).toBe(200)
    expect(stats.body).toMatchObject({ ok: true, mode: 'live', enabled: true, baseUrl: 'http://p' })
    const recent = await drive(route!.handler, 'GET', '/headroom-bridge/api/ledger/recent?limit=5')
    expect(recent.body!.entries!.length).toBe(1)
    expect(recent.body!.entries![0]!.toolName).toBe('bash')
    const clamped = await drive(route!.handler, 'GET', '/headroom-bridge/api/ledger/recent?limit=99')
    expect(clamped.body!.entries!.length).toBe(1)
    const floor = await drive(route!.handler, 'GET', '/headroom-bridge/api/ledger/recent?limit=0')
    expect(floor.body!.entries!.length).toBe(1)
    const health = await drive(route!.handler, 'GET', '/headroom-bridge/api/health')
    expect(health.body).toMatchObject({ ok: true, healthy: true })
    const nf = await drive(route!.handler, 'POST', '/headroom-bridge/api/stats')
    expect(nf.code).toBe(404)
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports 500 when a handler throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-api2-'))
    const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'ccr.json'), logger: quiet })
    store.init()
    let route: { handler: (req: unknown, res: unknown) => void | Promise<void> } | undefined
    const ctx = { effect(fn: () => void) { fn() }, webServer: { register: (r: typeof route) => { route = r } } } as never
    const source = createConfigSource(undefined)
    const client = { health: vi.fn(async () => { throw new Error('boom') }) }
    installApi(ctx, source, store, newCounters(), () => client as never)
    const out = await drive(route!.handler, 'GET', '/headroom-bridge/api/health')
    expect(out.code).toBe(500)
    expect(out.body!.error).toMatch(/boom/)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('apply', () => {
  it('disabled config skips every effect', () => {
    const registered: unknown[] = []
    const ctx = {
      effect(fn: () => void) { fn() },
      logger: quiet,
      tools: { register: (t: unknown) => { registered.push(t) } },
      webServer: { register: () => {} },
      on: () => () => {},
      inject: () => {},
    } as never
    apply(ctx, { enabled: false })
    expect(registered.length).toBe(0)
  })

  it('armed config registers tools, routes and both arms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-apply-'))
    const registered: unknown[] = []
    const routes: unknown[] = []
    const listeners: string[] = []
    const disposers: Array<() => void> = []
    const ctx = {
      effect(fn: () => unknown) {
        const out = fn()
        if (typeof out === 'function') disposers.push(out as () => void)
      },
      logger: quiet,
      tools: { register: (t: unknown) => { registered.push(t) } },
      webServer: { register: (r: unknown) => { routes.push(r) } },
      on(ev: string) { listeners.push(ev); return () => {} },
      inject: () => {},
    } as never
    process.env.DSH_HOME = dir
    apply(ctx, { mode: 'live', minChars: 100, minSavingsRatio: 0.1 })
    expect(registered.length).toBe(2)
    expect(listeners).toEqual(expect.arrayContaining(['tools/post-execute', 'agent/pre-step']))
    expect(routes.length).toBe(1)
    expect(disposers.length).toBeGreaterThan(0)
    disposers.forEach((d) =>{  d() })
    delete process.env.DSH_HOME
    rmSync(dir, { recursive: true, force: true })
  })
})
