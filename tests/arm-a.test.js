import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installArmA } from '../lib/arm-a.js'
import { resolveConfig } from '../lib/config.js'
import { CcrStore } from '../lib/store.js'
import { newCounters } from '../lib/stats.js'

const quiet = { info() {}, warn() {}, debug() {} }

function setup(overrides = {}) {
  const captured = []
  const ctx = {
    on(ev, fn) { captured.push({ ev, fn }); return () => {} },
    logger: quiet,
  }
  const dir = mkdtempSync(join(tmpdir(), 'hb-arma-'))
  const store = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path: join(dir, 'ccr.json'), logger: quiet })
  store.init()
  const counters = newCounters()
  const cfg = resolveConfig({ mode: 'live', minChars: 100, minSavingsRatio: 0.1 })
  const responses = []
  const client = {
    async compressToolMessage() {
      const r = responses.shift()
      if (r instanceof Error) throw r
      if (!r) throw new Error('no mock response')
      return r
    },
  }
  installArmA(ctx, () => cfg, store, () => client, counters)
  return { captured, store, counters, client, responses, dir }
}

const goodResponse = {
  messages: [{ content: 'compressed' }],
  tokens_before: 1000, tokens_after: 200, transforms_applied: ['router:smart_crusher:0.2'], ccr_hashes: [],
}

const exec = (over = {}) => ({
  callId: 'call_x', name: 'bash', arguments: {}, agent: { options: { model: 'deepseek-chat' }, id: 's1' }, ...over,
})

test('armA adopts a profitable result with marker and ledger entry', async () => {
  const { captured, store, counters, responses, dir } = setup()
  responses.push(goodResponse)
  const [entry] = captured.filter((c) => c.ev === 'tools/post-execute')
  const result = { isError: false, content: [{ type: 'text', text: 'x'.repeat(2000) }] }
  const decision = await entry.fn(exec(), result, async () => ({ kind: 'accept' }))

  assert.equal(decision.kind, 'accept')
  assert.ok(decision.content[0].text.includes('[headroom-bridge:'), 'adopted replacement has marker')
  assert.equal(counters.adopted, 1)
  assert.equal(store.stats().entries, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('armA keeps the original decision below the savings gate', async () => {
  const { captured, store, responses, dir } = setup()
  responses.push({ messages: [{ content: 'y'.repeat(1990) }], tokens_before: 1000, tokens_after: 990 })
  const [entry] = captured.filter((c) => c.ev === 'tools/post-execute')
  const result = { isError: false, content: [{ type: 'text', text: 'y'.repeat(2000) }] }
  const downstream = { kind: 'accept' }
  const decision = await entry.fn(exec(), result, async () => downstream)
  assert.deepEqual(decision, downstream)
  assert.equal(store.stats().entries, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('armA passes through value-replacement decisions untouched', async () => {
  const { captured, responses, dir } = setup()
  responses.push(goodResponse)
  const [entry] = captured.filter((c) => c.ev === 'tools/post-execute')
  const result = { isError: false, content: [] }
  const downstream = { kind: 'accept', value: { replaced: true } }
  const decision = await entry.fn(exec(), result, async () => downstream)
  assert.deepEqual(decision, downstream)
  rmSync(dir, { recursive: true, force: true })
})

test('armA fail-opens when the proxy throws', async () => {
  const { captured, store, counters, responses, dir } = setup()
  responses.push(new Error('connection refused'))
  const [entry] = captured.filter((c) => c.ev === 'tools/post-execute')
  const result = { isError: false, content: [{ type: 'text', text: 'z'.repeat(2000) }] }
  const downstream = { kind: 'accept' }
  const decision = await entry.fn(exec(), result, async () => downstream)
  assert.deepEqual(decision, downstream)
  assert.equal(counters.failures, 1)
  assert.equal(store.stats().entries, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('armA respects excluded tools', async () => {
  const { captured, store, responses, dir } = setup()
  responses.push(goodResponse)
  const [entry] = captured.filter((c) => c.ev === 'tools/post-execute')
  const result = { isError: false, content: [{ type: 'text', text: 'w'.repeat(2000) }] }
  const downstream = { kind: 'accept' }
  const decision = await entry.fn(exec({ name: 'read' }), result, async () => downstream)
  assert.deepEqual(decision, downstream)
  assert.equal(store.stats().entries, 0)
  rmSync(dir, { recursive: true, force: true })
})