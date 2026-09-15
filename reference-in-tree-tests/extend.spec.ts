/**
 * Branch-completion coverage: the remaining gate, store, wire, and wiring
 * branches not exercised by the primary specs.
 */

import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installArmA } from '../src/arm-a.ts'
import { installArmB } from '../src/arm-b.ts'
import { resolveConfig } from '../src/config.ts'
import { CcrStore, defaultStorePath } from '../src/store.ts'
import { newCounters } from '../src/stats.ts'
import { compileGlobs, globToRegExp, matchesAny } from '../src/util.ts'
import { evaluateGates } from '../src/protect.ts'
import { apply as applyInvariant, assertReplacementSmaller, assertRetrievable } from '../src/invariant.ts'
import { HeadroomClient } from '../src/proxy-client.ts'
import { retrieveTool } from '../src/tools.ts'
import { installApi } from '../src/api.ts'
import { createConfigSource } from '../src/settings.ts'
import { Config } from '../src/index.ts'

const quiet = { info() {}, warn() {}, debug() {}, error() {} }

type Decision = {
  kind: string
  content?: Array<{ type: string; text: string }>
  [key: string]: unknown
}

describe('arm-a branch completion', () => {
  function setup(overrides: Record<string, unknown> = {}) {
    const captured: Array<{ ev: string; fn: (exec: unknown, result: unknown, next: () => Promise<Decision>) => Promise<Decision> }> = []
    const dir = mkdtempSync(join(tmpdir(), 'hb-ax-'))
    const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'ccr.json'), logger: quiet })
    store.init()
    const counters = newCounters()
    const responses: Array<Record<string, unknown>> = []
    const client = {
      async compressToolMessage() {
        const r = responses.shift()
        if (!r) return new Promise(() => {}) as never
        return r
      },
    }
    const cfg = resolveConfig({ mode: 'live', minChars: 100, minSavingsRatio: 0.1, maxInflight: 1, ...overrides })
    const mockCtx = {
      on(ev: string, fn: never) { captured.push({ ev, fn }); return () => {} },
      logger: quiet,
    } as never
    installArmA(mockCtx, () => cfg, store, () => client as never, counters)
    const entry = captured[0]!
    const big = (t: string) => ({ isError: false, content: [{ type: 'text', text: t }] })
    const exec = (over: Record<string, unknown> = {}) => ({ callId: 'c' + String(Math.random()), name: 'bash', arguments: {}, agent: { options: { model: 'm' }, id: 's' }, ...over })
    return { entry, store, counters, responses, big, exec, dir }
  }
  const good = { messages: [{ content: 'z' }], tokens_before: 100, tokens_after: 10, transforms_applied: [] }

  it('evicts the LRU callId past 512 entries', async () => {
    const { entry, responses, big, exec, dir } = setup()
    for (let i = 0; i < 513; i++) { responses.push(good) }
    for (let i = 0; i < 513; i++) {
      await entry.fn(exec({ callId: 'id' + String(i) }), big('x'.repeat(500)), async () => ({ kind: 'accept' }))
    }
    // the 513th insert evicted the oldest callId; a reused id is accepted again
    responses.push(good)
    await entry.fn(exec({ callId: 'id0' }), big('x'.repeat(500)), async () => ({ kind: 'accept' }))
    expect(responses.length).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it('skips under the inflight cap and counts a failure', async () => {
    const { entry, store, counters, big, exec, dir } = setup()
    const first = entry.fn(exec({ callId: 'cA' }), big('x'.repeat(500)), async () => ({ kind: 'accept' }))
    const second = await entry.fn(exec({ callId: 'cB' }), big('y'.repeat(500)), async () => ({ kind: 'accept' }))
    expect(second.kind).toBe('accept')
    expect(counters.failures).toBe(1)
    expect(store.stats().entries).toBe(0)
    void first
    rmSync(dir, { recursive: true, force: true })
  })

  it('unwraps tool_call names, passes non-accept and content-less decisions', async () => {
    const { entry, responses, big, dir } = setup()
    responses.push(good)
    const unwrapped = await entry.fn({ callId: 'c1', name: 'tool_call', arguments: { name: 'bash' }, agent: { options: { model: 'm' }, id: 's' } }, big('x'.repeat(500)), async () => ({ kind: 'accept' }))
    expect(unwrapped.kind).toBe('accept')
    expect(unwrapped.content![0]!.text).toContain('[headroom-bridge:')
    const blocked = await entry.fn({ callId: 'c2', name: 'bash', arguments: {} }, big('x'.repeat(500)), async () => ({ kind: 'block', feedback: [] }))
    expect(blocked).toEqual({ kind: 'block', feedback: [] })
    const noContent = await entry.fn({ callId: 'c3', name: 'bash', arguments: {} }, { isError: false, content: [] }, async () => ({ kind: 'accept' }))
    expect(noContent).toEqual({ kind: 'accept' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('uses fallback model/id without an agent and keeps unprofitable results', async () => {
    const { entry, responses, counters, big, dir } = setup()
    responses.push({ messages: [], tokens_before: 100, tokens_after: 90 })
    await entry.fn({ callId: 'c4', name: 'bash', arguments: {} }, big('x'.repeat(500)), async () => ({ kind: 'accept' }))
    expect(counters.failures).toBe(0)
    responses.push({ messages: [{ content: 'y'.repeat(490) }], tokens_before: 0, tokens_after: 0 })
    const out = await entry.fn({ callId: 'c5', name: 'bash', arguments: {} }, big('x'.repeat(500)), async () => ({ kind: 'accept' }))
    expect(out).toEqual({ kind: 'accept' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('audit mode logs and keeps the decision', async () => {
    const { entry, responses, store, big, exec, dir } = setup({ mode: 'audit' })
    responses.push(good)
    const out = await entry.fn(exec(), big('x'.repeat(500)), async () => ({ kind: 'accept' }))
    expect(out).toEqual({ kind: 'accept' })
    expect(store.stats().entries).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it('skips already-compressed output and passes additionalContexts through', async () => {
    const { entry, responses, store, dir } = setup()
    responses.push(good)
    const marked = 'x'.repeat(600) + '\n\n[headroom-bridge: 5000->900 chars offloaded. ...]'
    const out = await entry.fn({ callId: 'c6', name: 'bash', arguments: {} }, { isError: false, content: [{ type: 'text', text: marked }] }, async () => ({ kind: 'accept', additionalContexts: [{ id: 'a' }] }))
    expect(out).toEqual({ kind: 'accept', additionalContexts: [{ id: 'a' }] })
    expect(store.stats().entries).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('arm-b branch completion', () => {
  function mkSession(
    toolName: string,
    bigText: string,
    extra: { isError?: boolean; blockType?: string; args?: string; callId?: string } = {},
  ) {
    const callId = extra.callId ?? 'call_b' + String(Math.random())
    const events: Array<Record<string, unknown>> = []
    events.push({ seq: 0, type: 'tool/call', data: { callId, name: toolName, arguments: extra.args ?? '{}' } })
    const message = {
      source: { callId },
      content: [{ type: extra.blockType ?? 'tool-result', toolCallId: callId, isError: extra.isError ?? false, content: [{ type: 'text', text: bigText }] }],
    }
    events.push({ seq: 1, type: 'tool/result', data: { turn: 1, step: 1, message } })
    return {
      events,
      surface: { nodes: [1] },
      append(type: string, data: unknown, opts: unknown) {
        const seq = events.length
        events.push({ seq, type, data, ...(opts as object) })
        return { seq }
      },
    }
  }
  function setup(overrides: Record<string, unknown> = {}, withMeter = true) {
    const captured: Array<{ ev: string; fn: (a: unknown, b: unknown) => Promise<unknown> }> = []
    const tokenMeter = { estimateMessage: (_m: unknown) => 42 }
    const ctx = {
      on(ev: string, fn: never) { captured.push({ ev, fn }); return () => {} },
      get(name: string) { return withMeter && name === 'tokenMeter' ? tokenMeter : undefined },
      logger: quiet,
    } as never
    const dir = mkdtempSync(join(tmpdir(), 'hb-bx-'))
    const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'ccr.json'), logger: quiet })
    store.init()
    const counters = newCounters()
    const cfg = resolveConfig({ mode: 'live', armB: { thresholdChars: 100, minSavingsRatio: 0.1, maxPerStep: 2 }, ...overrides })
    const responses: Array<Record<string, unknown>> = []
    const client = { async compressToolMessage() { const r = responses.shift(); if (!r) throw new Error('no mock'); return r } }
    installArmB(ctx, () => cfg, store, () => client as never, counters)
    return { entry: captured[0]!, store, counters, responses, dir }
  }
  const good = { messages: [{ content: 'cc' }], tokens_before: 100, tokens_after: 10, transforms_applied: [] }
  const run = async (entry: { fn: (a: unknown, b: unknown) => Promise<unknown> }, session: unknown) => {
    const agent = { session, options: { model: 'm' }, id: 's1' }
    return entry.fn({ agent, signal: new AbortController().signal }, async () => ({ kind: 'reject' }))
  }

  it('skips unidentifiable nodes, non-plain blocks, audit mode, and missing meter', async () => {
    const { entry, counters, dir } = setup()
    const orphan = mkSession('run_code', 'z'.repeat(5000), { callId: 'ghost' })
    ;(orphan.events[1] as { data: { message: { source: { callId: string } } } }).data.message.source.callId = 'ghost2'
    await run(entry, orphan)
    expect(counters.attempts).toBe(0)
    const image = mkSession('run_code', 'z'.repeat(5000), { blockType: 'image' })
    ;(image.events[1] as { data: { message: { content: Array<{ content?: unknown }> } } }).data.message.content[0]!.content = undefined
    await run(entry, image)
    expect(counters.attempts).toBe(0)
    rmSync(dir, { recursive: true, force: true })
    // audit mode: proxies but never appends
    const audit = setup({ mode: 'audit' })
    const audited = mkSession('run_code', 'z'.repeat(5000))
    audit.responses.push(good)
    await run(audit.entry, audited)
    expect(audit.counters.adopted).toBe(0)
    expect(audited.events.length).toBe(2)
    expect(audit.store.stats().entries).toBe(0)
    rmSync(audit.dir, { recursive: true, force: true })
    // missing token meter: skip before the shadow-price append
    const noMeter = setup({}, false)
    const nmSession = mkSession('run_code', 'z'.repeat(5000))
    noMeter.responses.push(good)
    await run(noMeter.entry, nmSession)
    expect(noMeter.counters.adopted).toBe(0)
    expect(nmSession.events.length).toBe(2)
    rmSync(noMeter.dir, { recursive: true, force: true })
  })

  it('armB disabled returns next immediately; proxy failure counts a failure', async () => {
    const { entry, dir } = setup({ armB: { enabled: false } })
    const session = mkSession('run_code', 'z'.repeat(5000))
    const next = vi.fn(async () => ({ kind: 'reject' }))
    await entry.fn({ agent: { session, options: { model: 'm' }, id: 's' }, signal: new AbortController().signal }, next)
    expect(next).toHaveBeenCalled()
    rmSync(dir, { recursive: true, force: true })
    // proxy throws -> fail-open with a counter bump
    const fail = setup()
    const fs = mkSession('run_code', 'z'.repeat(5000))
    // client throws when responses are empty
    await run(fail.entry, fs)
    expect(fail.counters.failures).toBe(1)
    expect(fs.events.length).toBe(2)
    rmSync(fail.dir, { recursive: true, force: true })
  })
})

describe('store branch completion', () => {
  const entry = (text: string) => ({ hash: text.slice(0, 24), toolName: 'bash', callId: 'c', sessionId: 's', strategy: 'x', charsBefore: 100, charsAfter: 10, originalText: text })

  it('rejects unusable persisted records and honors relative explicit paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-sx-'))
    const path = join(dir, 'ccr.json')
    writeFileSync(path, JSON.stringify({ version: 1, entries: [{ hash: '', originalText: 'x', toolName: 't', callId: 'c', storedAt: 1, expiresAt: Date.now() + 9999 }] }))
    const s = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path, logger: quiet })
    s.init()
    expect(s.stats().entries).toBe(0)
    expect(defaultStorePath('relative/ccr.json').endsWith('storages/dsh-headroom-bridge-ccr.json')).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('disabled stores skip persistence; repeated puts debounce once; dispose idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-sy-'))
    const path = join(dir, 'ccr.json')
    const off = new CcrStore({ enabled: false, ttlMs: 60000, maxEntries: 10, path, logger: quiet })
    off.init()
    off.put(entry('one'))
    expect(off.stats().writes).toBe(0)
    const on = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 2, path, logger: quiet })
    on.init()
    on.put(entry('a')); on.put(entry('b')); on.put(entry('c')); on.put(entry('d'))
    expect(on.stats().writes).toBe(4)
    on.dispose()
    on.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('flush and dispose degrade gracefully on write failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-sz-'))
    const path = join(dir, 'ccr.json')
    const s = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path, logger: quiet })
    s.init()
    s.put(entry('x'))
    mkdirSync(path)
    s.flush()
    const d = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'dccr.json'), logger: quiet })
    d.init()
    d.put(entry('y'))
    mkdirSync(join(dir, 'dccr.json'))
    d.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('config/util/protect branch completion', () => {
  it('rejects malformed field values', () => {
    expect(() => resolveConfig({ minChars: 0.5 })).toThrow()
    expect(() => resolveConfig({ baseUrl: '  ' })).toThrow()
    expect(() => resolveConfig({ excludeTools: ['read', 42] as never })).toThrow()
    expect(() => resolveConfig({ excludeTools: ['read', ''] })).toThrow()
    expect(() => resolveConfig({ ccr: { path: 123 as never } })).not.toThrow()
  })

  it('globToRegExp handles ? wildcards, escapes, and plain strings; compileGlobs maps', () => {
    expect(matchesAny('a1b', compileGlobs(['a?b']))).toBe(true)
    expect(matchesAny('a.b', compileGlobs(['a.b']))).toBe(true)
    expect(matchesAny('a1b/c', compileGlobs(['a?b']))).toBe(false)
    expect(compileGlobs(['x'])[0]!.test('x')).toBe(true)
  })

  it('protect: non-string path values, array args, basename-only misses', () => {
    const base = { enabled: true, toolName: 'run_code', isError: false, protectErrorOutputs: true, text: 'x'.repeat(2000), minChars: 500, excludeToolRe: [], protectPathRe: [globToRegExp('*.json')], args: {} }
    expect(evaluateGates({ ...base, args: { path: 42, files: ['/a/b.ts', 7] } })).toBe(null)
    expect(evaluateGates({ ...base, args: { src: 'src/app.ts' } })).toBe(null)
    expect(evaluateGates({ ...base, args: { path: 'data.json' } })).toBe('protected-path')
  })
})

describe('invariant companion and assertions', () => {
  it('assertions throw on violations and companion registers', async () => {
    expect(() =>{  assertReplacementSmaller(10, 10) }).toThrow()
    expect(() =>{  assertReplacementSmaller(10, 20) }).toThrow()
    expect(() =>{  assertRetrievable(false, 'h') }).toThrow()
    const registered: Array<[string, unknown]> = []
    const disposer = vi.fn()
    const ctx = { invariants: { register: (n: string, i: unknown) => { registered.push([n, i]); return disposer } } }
    const out = await applyInvariant(ctx as never)
    expect(registered[0]![0]).toBe('@deepseek-ai/dsh-headroom-bridge')
    expect(typeof registered[0]![1]).toBe('function')
    expect(out).toBe(disposer)
  })
})

describe('wire failure branches', () => {
  it('compress/retrieve non-ok with a rejecting text() body', async () => {
    const bad = { ok: false, status: 500, text: async () => { throw new Error('body fail') } }
    vi.stubGlobal('fetch', vi.fn(async () => bad))
    await expect(new HeadroomClient('http://p').compressToolMessage({ toolCallId: 'c', text: 't', model: 'm' })).rejects.toThrow(/500/)
    await expect(new HeadroomClient('http://p').retrieveHash('abc')).rejects.toThrow(/500/)
    vi.unstubAllGlobals()
  })

  it('retrieve render covers partial accounting fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-tx-'))
    const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'ccr.json'), logger: quiet })
    store.init()
    const tool = retrieveTool(store, () => ({ retrieveHash: async () => ({}) }) as never) as unknown as {
      output: { render(a: unknown, v: unknown): Array<{ type: string; text: string }> }
    }
    const withTool = tool.output.render(null, { id: 'h', found: true, content: 'x', toolName: 'bash' })
    expect(withTool[0]!.text).toContain('via bash')
    const withChars = tool.output.render(null, { id: 'h', found: true, content: 'x', charsBefore: 10, charsAfter: 2 })
    expect(withChars[0]!.text).toContain('(10->2 chars)')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('api 404 paths and index Config face', () => {
  it('GET with a wrong pathname 404s at every branch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-ax2-'))
    const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'ccr.json'), logger: quiet })
    store.init()
    let route: { handler: (req: unknown, res: unknown) => void | Promise<void> } | undefined
    const ctx = { effect(fn: () => void) { fn() }, webServer: { register: (r: typeof route) => { route = r } } } as never
    installApi(ctx, createConfigSource(undefined), store, newCounters(), () => ({ health: async () => true }) as never)
    for (const url of ['/headroom-bridge/api/statsx', '/headroom-bridge/api/foo']) {
      const res = { writeHead: vi.fn(), end: vi.fn() }
      await route!.handler({ method: 'GET', url }, res)
      expect(res.writeHead.mock.calls[0]![0]).toBe(404)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('ledger/recent without a limit param uses the default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-ay-'))
    const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'ccr.json'), logger: quiet })
    store.init()
    let route: { handler: (req: unknown, res: unknown) => void | Promise<void> } | undefined
    const ctx = { effect(fn: () => void) { fn() }, webServer: { register: (r: typeof route) => { route = r } } } as never
    installApi(ctx, createConfigSource(undefined), store, newCounters(), () => ({ health: async () => true }) as never)
    const res = { writeHead: vi.fn(), end: vi.fn() }
    await route!.handler({ method: 'GET', url: '/headroom-bridge/api/ledger/recent' }, res)
    expect(res.writeHead.mock.calls[0]![0]).toBe(200)
    rmSync(dir, { recursive: true, force: true })
  })

  it('Config ~standard validate returns value or issues', () => {
    const face = Config['~standard'] as { validate(v: unknown): { value?: unknown; issues?: Array<{ message: string }> } }
    expect(face.validate({ mode: 'live' }).value).toBeDefined()
    const bad = face.validate({ minChars: -1 })
    expect(bad.issues?.[0]?.message).toMatch(/minChars/)
    const thrown = face.validate(Object.defineProperty({}, 'armB', { get() { throw 'boom-not-error' } }))
    expect(thrown.issues?.[0]?.message).toBe('boom-not-error')
  })
})
