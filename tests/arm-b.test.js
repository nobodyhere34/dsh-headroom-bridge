import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installArmB } from '../lib/arm-b.js'
import { resolveConfig } from '../lib/config.js'
import { CcrStore } from '../lib/store.js'
import { newCounters } from '../lib/stats.js'

const quiet = { info() {}, warn() {}, debug() {} }

// Build a fake session whose surface holds one oversized tool result.
function mkSession(toolName, bigText) {
  const callId = 'call_test_001'
  const events = []
  events.push({ seq: 0, type: 'tool/call', data: { callId, name: toolName, arguments: '{}' } })
  const message = {
    source: { callId },
    content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: bigText }] }],
  }
  events.push({ seq: 1, type: 'tool/result', data: { turn: 1, step: 1, message } })
  return {
    events,
    // rc.2 session seam: snapshotEvents() iterates the log, eventAt(seq)
    // random-accesses one node (numbers are fine for this fake — the real
    // SessionSeq is a branded number at runtime).
    snapshotEvents: () => events,
    eventAt: (seq) => events[seq],
    surface: { nodes: [1] },
    append(type, data, opts) {
      const seq = events.length
      events.push({ seq, type, data, ...opts })
      return { seq }
    },
  }
}

function setup(overrides = {}) {
  const captured = []
  const tokenMeter = { estimateMessage: (m) => 42 }
  const ctx = {
    on(ev, fn) { captured.push({ ev, fn }); return () => {} },
    get(name) { return name === 'tokenMeter' ? tokenMeter : undefined },
    logger: quiet,
  }
  const dir = mkdtempSync(join(tmpdir(), 'hb-armb-'))
  const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 2000, maxBytes: 64 * 1024 * 1024, auditKeep: 100, path: join(dir, 'ccr.db'), logger: quiet })
  store.init()
  const counters = newCounters()
  const cfg = resolveConfig({ mode: 'live', armB: { thresholdChars: 100, minSavingsRatio: 0.1, maxPerStep: 2 } })
  const responses = []
  const client = {
    async compressToolMessage() {
      const r = responses.shift()
      if (!r) throw new Error('no mock response')
      return r
    },
  }
  installArmB(ctx, () => cfg, store, () => client, counters)
  return { captured, store, counters, client, responses, dir }
}

const goodResponse = {
  messages: [{ content: 'compressed-short' }],
  tokens_before: 1000, tokens_after: 100, transforms_applied: ['router:smart_crusher:0.1'], ccr_hashes: [],
}

test('armB adopts a high-yield oversized node via the shadow-price protocol', async () => {
  const { captured, store, counters, responses, dir } = setup()
  responses.push(goodResponse)
  const session = mkSession('run_code', 'z'.repeat(5000))
  const agent = { session, options: { model: 'deepseek-chat' }, id: 's1' }
  const [entry] = captured.filter((c) => c.ev === 'agent/pre-step')
  assert.ok(entry, 'pre-step listener registered')
  const signal = new AbortController().signal
  await entry.fn({ agent, signal }, async () => ({ kind: 'reject' }))

  assert.equal(counters.adopted, 1)
  // shadow-price protocol: metering event immediately before the replacement
  const prune = session.events[2]
  const repl = session.events[3]
  assert.equal(prune.type, 'compaction/prune')
  assert.deepEqual(prune.data.shadowedSeqs, [1])
  assert.equal(prune.data.shadowedRange.start, 1)
  assert.equal(prune.data.shadowedTokenCount, 42)
  assert.equal(repl.type, 'tool/result')
  assert.deepEqual(repl.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 1 })
  assert.deepEqual(repl.sourceEventSeqs, [1])
  const c0 = repl.data.message.content[0]
  const text = c0.content[0].text
  assert.ok(text.includes('[headroom-bridge:'), 'replacement carries the retrieval marker')
  // original stays in the ledger
  assert.equal(store.stats().entries, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('armB keeps the node when savings are below the gate', async () => {
  const { captured, store, counters, responses, dir } = setup()
  responses.push({ messages: [{ content: 'z'.repeat(4950) }], tokens_before: 1000, tokens_after: 990 })
  const session = mkSession('run_code', 'z'.repeat(5000))
  const agent = { session, options: { model: 'deepseek-chat' }, id: 's1' }
  const [entry] = captured.filter((c) => c.ev === 'agent/pre-step')
  await entry.fn({ agent, signal: new AbortController().signal }, async () => ({ kind: 'reject' }))
  assert.equal(counters.adopted, 0)
  assert.equal(session.events.length, 2, 'no append when unprofitable')
  assert.equal(store.stats().entries, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('armB skips excluded tools and leaves surface untouched', async () => {
  const { captured, store, responses, dir } = setup()
  responses.push(goodResponse)
  const session = mkSession('read', 'y'.repeat(5000))
  const agent = { session, options: { model: 'deepseek-chat' }, id: 's1' }
  const [entry] = captured.filter((c) => c.ev === 'agent/pre-step')
  await entry.fn({ agent, signal: new AbortController().signal }, async () => ({ kind: 'reject' }))
  assert.equal(session.events.length, 2, 'read results stay verbatim')
  assert.equal(store.stats().entries, 0)
  rmSync(dir, { recursive: true, force: true })
})