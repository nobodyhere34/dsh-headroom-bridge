import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installArmA } from '../src/arm-a.ts'
import { resolveConfig } from '../src/config.ts'
import { CcrStore } from '../src/store.ts'
import { newCounters } from '../src/stats.ts'

const quiet = { info() {}, warn() {}, debug() {} }

type Decision = {
  kind: string
  content?: Array<{ type: string; text: string }>
  [key: string]: unknown
}

function setup() {
  const captured: Array<{ ev: string; fn: (exec: unknown, result: unknown, next: () => Promise<Decision>) => Promise<Decision> }> = []
  const ctx = {
    on(ev: string, fn: never) { captured.push({ ev, fn }); return () => {} },
    logger: quiet,
  } as never
  const dir = mkdtempSync(join(tmpdir(), 'hb-arma-'))
  const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'ccr.json'), logger: quiet })
  store.init()
  const counters = newCounters()
  const cfg = resolveConfig({ mode: 'live', minChars: 100, minSavingsRatio: 0.1 })
  const responses: Array<Record<string, unknown> | Error> = []
  const client = {
    async compressToolMessage() {
      const r = responses.shift()
      if (r instanceof Error) throw r
      if (!r) throw new Error('no mock response')
      return r
    },
  }
  installArmA(ctx, () => cfg, store, () => client as never, counters)
  return { captured, store, counters, client, responses, dir }
}

const goodResponse = {
  messages: [{ content: 'compressed' }],
  tokens_before: 1000, tokens_after: 200, transforms_applied: ['router:smart_crusher:0.2'], ccr_hashes: [],
}

const exec = (over: Record<string, unknown> = {}) => ({
  callId: 'call_x', name: 'bash', arguments: {}, agent: { options: { model: 'deepseek-chat' }, id: 's1' }, ...over,
})

function postExecuteEntry(
  captured: Array<{ ev: string; fn: (exec: unknown, result: unknown, next: () => Promise<Decision>) => Promise<Decision> }>,
) {
  return captured.filter(c => c.ev === 'tools/post-execute')[0]!
}

it('armA adopts a profitable result with marker and ledger entry', async () => {
  const { captured, store, counters, responses, dir } = setup()
  responses.push(goodResponse)
  const entry = postExecuteEntry(captured)
  const result = { isError: false, content: [{ type: 'text', text: 'x'.repeat(2000) }] }
  const decision = await entry.fn(exec(), result, async () => ({ kind: 'accept' }))

  expect(decision.kind).toBe('accept')
  expect(decision.content![0]!.text.includes('[headroom-bridge:'),
    'adopted replacement has marker').toBeTruthy()
  expect(counters.adopted).toBe(1)
  expect(store.stats().entries).toBe(1)
  rmSync(dir, { recursive: true, force: true })
})

it('armA keeps the original decision below the savings gate', async () => {
  const { captured, store, responses, dir } = setup()
  responses.push({ messages: [{ content: 'y'.repeat(1990) }], tokens_before: 1000, tokens_after: 990 })
  const entry = postExecuteEntry(captured)
  const result = { isError: false, content: [{ type: 'text', text: 'y'.repeat(2000) }] }
  const downstream = { kind: 'accept' }
  const decision = await entry.fn(exec(), result, async () => downstream)
  expect(decision).toEqual(downstream)
  expect(store.stats().entries).toBe(0)
  rmSync(dir, { recursive: true, force: true })
})

it('armA passes through value-replacement decisions untouched', async () => {
  const { captured, responses, dir } = setup()
  responses.push(goodResponse)
  const entry = postExecuteEntry(captured)
  const result = { isError: false, content: [] }
  const downstream = { kind: 'accept', value: { replaced: true } }
  const decision = await entry.fn(exec(), result, async () => downstream)
  expect(decision).toEqual(downstream)
  rmSync(dir, { recursive: true, force: true })
})

it('armA fail-opens when the proxy throws', async () => {
  const { captured, store, counters, responses, dir } = setup()
  responses.push(new Error('connection refused'))
  const entry = postExecuteEntry(captured)
  const result = { isError: false, content: [{ type: 'text', text: 'z'.repeat(2000) }] }
  const downstream = { kind: 'accept' }
  const decision = await entry.fn(exec(), result, async () => downstream)
  expect(decision).toEqual(downstream)
  expect(counters.failures).toBe(1)
  expect(store.stats().entries).toBe(0)
  rmSync(dir, { recursive: true, force: true })
})

it('armA respects excluded tools', async () => {
  const { captured, store, responses, dir } = setup()
  responses.push(goodResponse)
  const entry = postExecuteEntry(captured)
  const result = { isError: false, content: [{ type: 'text', text: 'w'.repeat(2000) }] }
  const downstream = { kind: 'accept' }
  const decision = await entry.fn(exec({ name: 'read' }), result, async () => downstream)
  expect(decision).toEqual(downstream)
  expect(store.stats().entries).toBe(0)
  rmSync(dir, { recursive: true, force: true })
})
