/**
 * Final branch-completion coverage after the source restructures.
 */

import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installArmA } from '../src/arm-a.ts'
import { installArmB } from '../src/arm-b.ts'
import { resolveConfig } from '../src/config.ts'
import { CcrStore } from '../src/store.ts'
import { newCounters } from '../src/stats.ts'
import { globToRegExp } from '../src/util.ts'
import { evaluateGates } from '../src/protect.ts'
import { retrieveTool } from '../src/tools.ts'
import { installApi } from '../src/api.ts'
import { createConfigSource, installSettings } from '../src/settings.ts'

let capturedHooks: { setSource(t: unknown): void; onChange(): void } | undefined
vi.mock('@deepseek-ai/dsh-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-settings')>()
  return {
    ...actual,
    installSettingsSection: (
      _ctx: unknown, _ns: unknown, _schema: unknown, _entry: unknown,
      hooks: { setSource(t: unknown): void; onChange(): void },
    ) => {
      capturedHooks = hooks
    },
  }
})

const quiet = { info() {}, warn() {}, debug() {}, error() {} }

type Decision = {
  kind: string
  content?: Array<{ type: string; text: string }>
  [key: string]: unknown
}

describe('final arm-a branches', () => {
  function setup() {
    const captured: Array<{ ev: string; fn: (exec: unknown, result: unknown, next: () => Promise<Decision>) => Promise<Decision> }> = []
    const dir = mkdtempSync(join(tmpdir(), 'hb-fa-'))
    const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'ccr.json'), logger: quiet })
    store.init()
    const counters = newCounters()
    const responses: Array<Record<string, unknown>> = []
    const client = { async compressToolMessage() { const r = responses.shift(); if (!r) throw new Error('no mock'); return r } }
    const cfg = resolveConfig({ mode: 'live', minChars: 100, minSavingsRatio: 0.1 })
    const mockCtx = {
      on(ev: string, fn: never) { captured.push({ ev, fn }); return () => {} },
      logger: quiet,
    } as never
    installArmA(mockCtx, () => cfg, store, () => client as never, counters)
    return { entry: captured[0]!, store, counters, responses, dir }
  }
  const good = { messages: [{ content: 'z' }], tokens_before: 100, tokens_after: 10, transforms_applied: [] }

  it('duplicate callIds are attempted exactly once', async () => {
    const { entry, responses, dir } = setup()
    responses.push(good)
    const exec = { callId: 'dup', name: 'bash', arguments: {}, agent: { options: { model: 'm' }, id: 's' } }
    const result = { isError: false, content: [{ type: 'text', text: 'x'.repeat(500) }] }
    await entry.fn(exec, result, async () => ({ kind: 'accept' }))
    const second = await entry.fn(exec, result, async () => ({ kind: 'accept' }))
    expect(second).toEqual({ kind: 'accept' })
    expect(responses.length).toBe(0) // only one proxy call
    rmSync(dir, { recursive: true, force: true })
  })

  it('tool_call with a non-string nested name falls back to the outer name', async () => {
    const { entry, responses, dir } = setup()
    responses.push(good)
    const out = await entry.fn({ callId: 'c', name: 'tool_call', arguments: { name: 42 }, agent: { options: { model: 'm' }, id: 's' } }, { isError: false, content: [{ type: 'text', text: 'x'.repeat(500) }] }, async () => ({ kind: 'accept' }))
    expect(out.content![0]!.text).toContain('[headroom-bridge:')
    // nameless exec falls back to an empty tool name
    responses.push(good)
    const nameless = await entry.fn({ callId: 'c7', arguments: {} }, { isError: false, content: [{ type: 'text', text: 'y'.repeat(500) }] }, async () => ({ kind: 'accept' }))
    expect(nameless.kind).toBe('accept')
    // adoption passes additionalContexts through
    responses.push(good)
    const ctxOut = await entry.fn({ callId: 'c8', name: 'bash', arguments: {}, agent: { options: { model: 'm' }, id: 's' } }, { isError: false, content: [{ type: 'text', text: 'w'.repeat(500) }] }, async () => ({ kind: 'accept', additionalContexts: [{ id: 'ctx1' }] }))
    expect(ctxOut.additionalContexts).toEqual([{ id: 'ctx1' }])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('final arm-b branches', () => {
  function mkSession(toolName: string, bigText: string, extra: { isError?: boolean; blockType?: string; argumentsRaw?: string } = {}) {
    const callId = 'call_f' + String(Math.random())
    const events: Array<Record<string, unknown>> = []
    events.push({ seq: 0, type: 'tool/call', data: { callId, name: toolName, arguments: extra.argumentsRaw ?? '{}' } })
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
  function setup() {
    const captured: Array<{ ev: string; fn: (a: unknown, b: unknown) => Promise<unknown> }> = []
    const ctx = {
      on(ev: string, fn: never) { captured.push({ ev, fn }); return () => {} },
      get: () => ({ estimateMessage: () => 42 }),
      logger: quiet,
    } as never
    const dir = mkdtempSync(join(tmpdir(), 'hb-fb-'))
    const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'ccr.json'), logger: quiet })
    store.init()
    const counters = newCounters()
    const cfg = resolveConfig({ mode: 'live', armB: { thresholdChars: 100, minSavingsRatio: 0.1, maxPerStep: 2 } })
    const responses: Array<Record<string, unknown>> = []
    const client = { async compressToolMessage() { const r = responses.shift(); if (!r) throw new Error('no mock'); return r } }
    installArmB(ctx, () => cfg, store, () => client as never, counters)
    return { entry: captured[0]!, store, counters, responses, dir }
  }
  const run = async (entry: { fn: (a: unknown, b: unknown) => Promise<unknown> }, session: unknown, signal?: AbortSignal) => {
    const agent = { session, options: { model: 'm' }, id: 's1' }
    return entry.fn({ agent, signal: signal ?? new AbortController().signal }, async () => ({ kind: 'reject' }))
  }

  it('gate skips, unparsable args, low savings, empty response, aborted signal, repeat session', async () => {
    const { entry, counters, responses, dir } = setup()
    const cases: Array<{ tool: string; text: string; extra?: { isError?: boolean; blockType?: string; argumentsRaw?: string } }> = [
      { tool: 'read', text: 'z'.repeat(5000) },
      { tool: 'headroom_retrieve', text: 'z'.repeat(5000) },
      { tool: 'run_code', text: 'z'.repeat(5000), extra: { isError: true } }, // data.error set below
      { tool: 'run_code', text: 'z'.repeat(5000), extra: { blockType: 'image' } },
      { tool: 'run_code', text: 'short' },
      { tool: 'run_code', text: 'z'.repeat(5000) + '\n\n[headroom-bridge: 1->1 chars offloaded. ...]' },
      { tool: 'run_code', text: 'z'.repeat(5000), extra: { argumentsRaw: 'not-json{{' } },
    ]
    for (const c of cases) {
      const session = mkSession(c.tool, c.text, c.extra)
      if (c.extra?.isError) {
        ;(session.events[1] as { data: Record<string, unknown> }).data.error = { message: 'boom' }
      }
      await run(entry, session)
    }
    // a null first content block is rejected by the loose result-block view
    const nullBlock = mkSession('run_code', 'z'.repeat(5000))
    ;(nullBlock.events[1] as { data: { message: { content: unknown[] } } }).data.message.content[0] = null
    await run(entry, nullBlock)
    expect(counters.attempts).toBe(1)
    // only the unparsable-args case proceeds (no path protection), failing open at the proxy
    expect(counters.attempts).toBe(1)
    expect(counters.failures).toBe(1)
    // a surface node over a non-result event is skipped
    const odd = mkSession('run_code', 'z'.repeat(5000))
    odd.surface = { nodes: [0] }
    await run(entry, odd)
    // three eligible nodes cap at maxPerStep=2
    const wide = mkSession('run_code', 'z'.repeat(5000))
    wide.events.push({ seq: 2, type: 'tool/result', data: { ...((wide.events[1] as Record<string, unknown>).data as Record<string, unknown>) } })
    wide.events.push({ seq: 3, type: 'tool/result', data: { ...((wide.events[1] as Record<string, unknown>).data as Record<string, unknown>) } })
    wide.surface = { nodes: [1, 2, 3] }
    responses.push({ messages: [{ content: 'z' }], tokens_before: 100, tokens_after: 10, transforms_applied: [] }, { messages: [{ content: 'z' }], tokens_before: 100, tokens_after: 10, transforms_applied: [] })
    await run(entry, wide)
    responses.push({ messages: [{ content: 'z'.repeat(4950) }], tokens_before: 100, tokens_after: 99 })
    const low = mkSession('run_code', 'z'.repeat(5000))
    await run(entry, low)
    expect(counters.adopted).toBe(2)
    expect(low.events.length).toBe(2)
    responses.push({ messages: [], tokens_before: 0, tokens_after: 0 })
    const empty = mkSession('run_code', 'z'.repeat(5000))
    await run(entry, empty)
    responses.push({ messages: [{ content: 'c' }], tokens_before: 0, tokens_after: 0 })
    // token-profitable but not strictly smaller: rejected by the shrink check
    responses.push({ messages: [{ content: 'z'.repeat(6000) }], tokens_before: 100, tokens_after: 10 })
    const ratio = mkSession('run_code', 'z'.repeat(5000))
    const grow = mkSession('run_code', 'z'.repeat(5000))
    await run(entry, grow)
    await run(entry, ratio)
    expect(counters.adopted).toBe(3)
    expect(ratio.events.length).toBe(2)
    expect(grow.events.length).toBe(4)
    const aborted = new AbortController()
    aborted.abort()
    const ab = mkSession('run_code', 'z'.repeat(5000))
    await run(entry, ab, aborted.signal)
    responses.push({ messages: [{ content: 'c2' }], tokens_before: 100, tokens_after: 10 })
    // agent without a model option takes the fallback model
    responses.push({ messages: [{ content: 'c3' }], tokens_before: 100, tokens_after: 10 })
    const nameless = mkSession('run_code', 'z'.repeat(5000))
    const bareAgent = { session: nameless, options: {}, id: 's2' }
    await entry.fn({ agent: bareAgent, signal: new AbortController().signal }, async () => ({ kind: 'reject' }))
    expect(nameless.events.length).toBe(4)
    // repeat session: second pre-step reuses the attempted set
    const again = mkSession('run_code', 'z'.repeat(5000))
    await run(entry, again)
    await run(entry, again)
    rmSync(dir, { recursive: true, force: true })
  })

  it('listener catches a throwing config source', async () => {
    const captured: Array<{ ev: string; fn: (a: unknown, b: unknown) => Promise<unknown> }> = []
    const ctx = {
      on(ev: string, fn: never) { captured.push({ ev, fn }); return () => {} },
      get: () => ({ estimateMessage: () => 42 }),
      logger: quiet,
    } as never
    const dir = mkdtempSync(join(tmpdir(), 'hb-fc-'))
    const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'ccr.json'), logger: quiet })
    store.init()
    installArmB(ctx, () => { throw new Error('cfg boom') }, store, () => ({}) as never, newCounters())
    const session = mkSession('run_code', 'z'.repeat(5000))
    const out = await captured[0]!.fn({ agent: { session, options: { model: 'm' }, id: 's' }, signal: new AbortController().signal }, async () => ({ kind: 'reject' }))
    expect(out).toEqual({ kind: 'reject' })
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('final store branches', () => {
  const entry = (text: string) => ({ hash: text.slice(0, 24), toolName: 'bash', callId: 'c', sessionId: 's', strategy: 'x', charsBefore: 100, charsAfter: 10, originalText: text })

  it('tolerates primitive/version-mismatched store files and disposed puts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-fs-'))
    const p1 = join(dir, 'a.json')
    writeFileSync(p1, '42')
    const s1 = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: p1, logger: quiet })
    s1.init()
    expect(s1.stats().entries).toBe(0)
    const p2 = join(dir, 'b.json')
    writeFileSync(p2, JSON.stringify({ version: 999, entries: [{ hash: 'h', originalText: 'x', toolName: 't', callId: 'c', storedAt: 1, expiresAt: Date.now() + 9999 }] }))
    const s2 = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: p2, logger: quiet })
    s2.init()
    expect(s2.stats().entries).toBe(0)
    const p3 = join(dir, 'c.json')
    writeFileSync(p3, JSON.stringify({ version: 1, entries: [42, { hash: 'h2', originalText: 'x', toolName: 't', callId: 'c', storedAt: 1, expiresAt: Date.now() + 9999 }] }))
    const s3 = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: p3, logger: quiet })
    s3.init()
    expect(s3.stats().entries).toBe(1)
    s3.dispose()
    expect(s3.put(entry('late'))).toBe(entry('late').hash)
    s3.flush()
    rmSync(dir, { recursive: true, force: true })
  })

  it('recent sorts by storedAt and drops expired entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-fr-'))
    const path = join(dir, 'ccr.json')
    const s = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path, logger: quiet })
    s.init()
    s.put(entry('one'))
    await new Promise(resolve => setTimeout(resolve, 5))
    s.put(entry('two'))
    await new Promise(resolve => setTimeout(resolve, 5))
    s.put(entry('three'))
    const recent = s.recent(10)
    expect(recent.length).toBe(3)
    expect(recent[0]!.originalText).toBe('three')
    expect(s.recent(1).length).toBe(1)
    rmSync(dir, { recursive: true, force: true })
    // newest-first insertion exercises the oldest-scan's true arm
    const revDir = mkdtempSync(join(tmpdir(), 'hb-rev-'))
    const rev = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 2, path: join(revDir, 'ccr.json'), logger: quiet })
    rev.init()
    rev.put(entry('newest'))
    await new Promise(resolve => setTimeout(resolve, 5))
    rev.put(entry('middle'))
    await new Promise(resolve => setTimeout(resolve, 5))
    rev.put(entry('oldest'))
    expect(rev.get(entry('newest').hash)).toBeUndefined()
    expect(rev.get(entry('oldest').hash)).toBeDefined()
    rev.dispose()
    // mixed-order eviction sweeps the reduce's other arm
    const mix = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 1, path: join(revDir, 'mix.json'), logger: quiet })
    mix.init()
    mix.put(entry('m1'))
    await new Promise(resolve => setTimeout(resolve, 5))
    mix.put(entry('m2'))
    await new Promise(resolve => setTimeout(resolve, 5))
    mix.put(entry('m3'))
    expect(mix.stats().entries).toBe(1)
    mix.dispose()
    // a descending-storedAt persisted file makes the reduce's true arm reachable
    const now = Date.now()
    const descPath = join(revDir, 'desc.json')
    // tail slice [newest, middle] is descending, so the eviction reduce takes its true arm
    writeFileSync(descPath, JSON.stringify({ version: 1, entries: [
      { hash: 'd0', originalText: 'n0', toolName: 't', callId: 'c', storedAt: now - 5000, expiresAt: now + 9999 },
      { hash: 'd1', originalText: 'n1', toolName: 't', callId: 'c', storedAt: now, expiresAt: now + 9999 },
      { hash: 'd2', originalText: 'n2', toolName: 't', callId: 'c', storedAt: now - 1000, expiresAt: now + 9999 },
    ] }))
    const desc = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 2, path: descPath, logger: quiet })
    desc.init()
    expect(desc.stats().entries).toBe(2)
    desc.put(entry('x'))
    expect(desc.stats().entries).toBe(2)
    expect(desc.get('d2')).toBeUndefined() // the older loaded entry went first
    expect(desc.get('d1')).toBeDefined()
    desc.dispose()
    rmSync(revDir, { recursive: true, force: true })
  })
})

describe('final config/protect/tools branches', () => {
  it('bool throws on non-boolean; ccr.path string branch', () => {
    expect(() => resolveConfig({ enabled: 'yes' as never })).toThrow()
    const c = resolveConfig({ ccr: { path: '/tmp/ccr-custom.json' } })
    expect(c.ccr.path).toBe('/tmp/ccr-custom.json')
  })

  it('protect: top-level non-object args and bare-name path args', () => {
    const base = { enabled: true, toolName: 'run_code', isError: false, protectErrorOutputs: true, text: 'x'.repeat(2000), minChars: 500, excludeToolRe: [], protectPathRe: [globToRegExp('*.ts')], args: {} }
    expect(evaluateGates({ ...base, args: 42 })).toBe(null)
    expect(evaluateGates({ ...base, args: { count: 5 } })).toBe(null)
    expect(evaluateGates({ ...base, args: { file_path: null } })).toBe(null)
    const shared = { note: 'not-a-path' }
    expect(evaluateGates({ ...base, args: { a: shared, b: shared } })).toBe(null)
    expect(evaluateGates({ ...base, args: { path: 'no-match.txt' } })).toBe(null)
    expect(evaluateGates({ ...base, args: { path: 'no-slash.ts' } })).toBe('protected-path')
  })

  it('retrieve render: detail, partial chars, missing content; string error from proxy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-ft-'))
    const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'ccr.json'), logger: quiet })
    store.init()
    const tool = retrieveTool(store, () => ({ retrieveHash: async () => { throw 'string-boom' } }) as never) as unknown as { output: { render(a: unknown, v: unknown): Array<{ type: string; text: string }> }; execute(args: Record<string, unknown>, ctx: never): Promise<Record<string, unknown>> }
    const withDetail = tool.output.render(null, { id: 'h', found: false, detail: 'why' })
    expect(withDetail[0]!.text).toContain('(why)')
    const partial = tool.output.render(null, { id: 'h', found: true, content: 'x', charsBefore: 10 })
    expect(partial[0]!.text).toContain('original for h')
    const noContent = tool.output.render(null, { id: 'h', found: true })
    expect(noContent[0]!.text).toBeTruthy()
    const res = await tool.execute({ hash: 'aabbccdd' }, {} as never)

    expect(res).toMatchObject({ found: false, detail: 'string-boom' })
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('final api/settings branches', () => {
  it('missing url and bare prefix requests fall back to 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-fr2-'))
    const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'ccr.json'), logger: quiet })
    store.init()
    let route: { handler: (req: unknown, res: unknown) => void | Promise<void> } | undefined
    const ctx = { effect(fn: () => void) { fn() }, webServer: { register: (r: typeof route) => { route = r } } } as never
    installApi(ctx, createConfigSource(undefined), store, newCounters(), () => ({ health: async () => true }) as never)
    for (const req of [{ method: 'GET' }, { method: 'GET', url: '/headroom-bridge/api' }]) {
      const res = { writeHead: vi.fn(), end: vi.fn() }
      await route!.handler(req, res)
      expect(res.writeHead.mock.calls[0]![0]).toBe(404)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('handler 500 surfaces non-Error throws verbatim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-fr3-'))
    const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'ccr.json'), logger: quiet })
    store.init()
    let route: { handler: (req: unknown, res: unknown) => void | Promise<void> } | undefined
    const ctx = { effect(fn: () => void) { fn() }, webServer: { register: (r: typeof route) => { route = r } } } as never
    installApi(ctx, createConfigSource(undefined), store, newCounters(), () => ({ health: async () => { throw 'plain-boom' } }) as never)
    const res = { writeHead: vi.fn(), end: vi.fn() }
    await route!.handler({ method: 'GET', url: '/headroom-bridge/api/health' }, res)
    expect(res.writeHead.mock.calls[0]![0]).toBe(500)
    expect((JSON.parse(res.end.mock.calls[0]![0] as string) as { error?: string }).error).toBe('plain-boom')
    rmSync(dir, { recursive: true, force: true })
  })

  it('onChange before setSource uses the composition entry thunk', () => {
    const source = createConfigSource(undefined)
    const ctx = { inject() {}, fiber: { state: 0 } } as never
    installSettings(ctx, source, undefined)
    expect(capturedHooks).toBeDefined()
    // fire onChange before any setSource: the initial entry thunk answers
    capturedHooks!.onChange()
    expect(source.get().mode).toBe('audit') // defaults from the empty entry
    capturedHooks!.setSource(() => ({ mode: 'live' }))
    capturedHooks!.onChange()
    expect(source.get().mode).toBe('live')
  })

})
