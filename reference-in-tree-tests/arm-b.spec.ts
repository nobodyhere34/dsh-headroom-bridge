import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installArmB } from '../src/arm-b.ts'
import { resolveConfig } from '../src/config.ts'
import { CcrStore } from '../src/store.ts'
import { newCounters } from '../src/stats.ts'

const quiet = { info() {}, warn() {}, debug() {} }

// Build a fake session whose surface holds one oversized tool result.
function mkSession(toolName: string, bigText: string) {
  const callId = 'call_test_001'
  const events: Array<Record<string, unknown>> = []
  events.push({ seq: 0, type: 'tool/call', data: { callId, name: toolName, arguments: '{}' } })
  const message = {
    source: { callId },
    content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: bigText }] }],
  }
  events.push({ seq: 1, type: 'tool/result', data: { turn: 1, step: 1, message } })
  return {
    events,
    surface: { nodes: [1] },
    append(type: string, data: unknown, opts: Record<string, unknown>) {
      const seq = events.length
      events.push({ seq, type, data, ...opts })
      return { seq }
    },
  }
}

function setup() {
  const captured: Array<{ ev: string; fn: (a: unknown, b: unknown) => Promise<unknown> }> = []
  const tokenMeter = { estimateMessage: (_m: unknown) => 42 }
  const ctx = {
    on(ev: string, fn: never) { captured.push({ ev, fn }); return () => {} },
    get(name: string) { return name === 'tokenMeter' ? tokenMeter : undefined },
    logger: quiet,
  } as never
  const dir = mkdtempSync(join(tmpdir(), 'hb-armb-'))
  const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'ccr.json'), logger: quiet })
  store.init()
  const counters = newCounters()
  const cfg = resolveConfig({ mode: 'live', armB: { thresholdChars: 100, minSavingsRatio: 0.1, maxPerStep: 2 } })
  const responses: Array<Record<string, unknown>> = []
  const client = {
    async compressToolMessage() {
      const r = responses.shift()
      if (!r) throw new Error('no mock response')
      return r
    },
  }
  installArmB(ctx, () => cfg, store, () => client as never, counters)
  return { captured, store, counters, client, responses, dir }
}

const goodResponse = {
  messages: [{ content: 'compressed-short' }],
  tokens_before: 1000, tokens_after: 100, transforms_applied: ['router:smart_crusher:0.1'], ccr_hashes: [],
}

it('armB adopts a high-yield oversized node via the shadow-price protocol', async () => {
  const { captured, store, counters, responses, dir } = setup()
  responses.push(goodResponse)
  const session = mkSession('run_code', 'z'.repeat(5000))
  const agent = { session, options: { model: 'deepseek-chat' }, id: 's1' }
  const entry = captured.filter(c => c.ev === 'agent/pre-step')[0]!
  expect(entry, 'pre-step listener registered').toBeTruthy()
  const signal = new AbortController().signal
  await entry.fn({ agent, signal }, async () => ({ kind: 'reject' }))

  expect(counters.adopted).toBe(1)
  // shadow-price protocol: metering event immediately before the replacement
  const prune = session.events[2] as {
    seq: number
    type: string
    data: { shadowedSeqs: number[]; shadowedRange: { start: number; end: number }; shadowedTokenCount: number }
  }
  const repl = session.events[3] as {
    seq: number
    type: string
    data: { message: { content: Array<{ content: Array<{ type: string; text: string }> }> } }
    surfaceOp: { op: string; start: number; end: number }
    sourceEventSeqs: number[]
  }
  expect(prune.type).toBe('compaction/prune')
  expect(prune.data.shadowedSeqs).toEqual([1])
  expect(prune.data.shadowedRange.start).toBe(1)
  expect(prune.data.shadowedTokenCount).toBe(42)
  expect(repl.type).toBe('tool/result')
  expect(repl.surfaceOp).toEqual({ op: 'replace', start: 1, end: 1 })
  expect(repl.sourceEventSeqs).toEqual([1])
  const c0 = repl.data.message.content[0]!
  const text = c0.content[0]!.text
  expect(text.includes('[headroom-bridge:'), 'replacement carries the retrieval marker').toBeTruthy()
  // original stays in the ledger
  expect(store.stats().entries).toBe(1)
  rmSync(dir, { recursive: true, force: true })
})

it('armB keeps the node when savings are below the gate', async () => {
  const { captured, store, counters, responses, dir } = setup()
  responses.push({ messages: [{ content: 'z'.repeat(4950) }], tokens_before: 1000, tokens_after: 990 })
  const session = mkSession('run_code', 'z'.repeat(5000))
  const agent = { session, options: { model: 'deepseek-chat' }, id: 's1' }
  const entry = captured.filter(c => c.ev === 'agent/pre-step')[0]!
  await entry.fn({ agent, signal: new AbortController().signal }, async () => ({ kind: 'reject' }))
  expect(counters.adopted).toBe(0)
  expect(session.events.length).toBe(2)
  expect(store.stats().entries).toBe(0)
  rmSync(dir, { recursive: true, force: true })
})

it('armB skips excluded tools and leaves surface untouched', async () => {
  const { captured, store, responses, dir } = setup()
  responses.push(goodResponse)
  const session = mkSession('read', 'y'.repeat(5000))
  const agent = { session, options: { model: 'deepseek-chat' }, id: 's1' }
  const entry = captured.filter(c => c.ev === 'agent/pre-step')[0]!
  await entry.fn({ agent, signal: new AbortController().signal }, async () => ({ kind: 'reject' }))
  expect(session.events.length).toBe(2)
  expect(store.stats().entries).toBe(0)
  rmSync(dir, { recursive: true, force: true })
})
