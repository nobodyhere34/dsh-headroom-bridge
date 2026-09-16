/**
 * headroom_retrieve semantics: live originals redeem from the local ledger;
 * demoted rows answer honestly with retained lineage (and never round-trip
 * the proxy for a bridge-minted hash); unknown/invalid hashes fall through.
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CcrStore } from '../lib/store.js'
import { contentHash } from '../lib/util.js'
import { retrieveTool } from '../lib/tools.js'

const quiet = { warn() {}, info() {}, debug() {} }

function makeTool(store, client) {
  const cfg = { enabled: true, mode: 'live', ccrEnabled: true }
  const tool = retrieveTool({}, () => cfg, store, () => client)
  return tool
}

function newStore(dir) {
  return new CcrStore({ enabled: true, ttlMs: 60_000, maxEntries: 50, maxBytes: 64 * 1024 * 1024, auditKeep: 100, path: join(dir, 'ccr.db'), logger: quiet })
}

test('live original redeems from the local ledger with accounting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-tools-'))
  const store = newStore(dir)
  store.init()
  const text = 'the quick brown fox ' + 'x'.repeat(600)
  const hash = contentHash(text)
  store.put({ hash, toolName: 'bash', callId: 'c1', sessionId: 's1', strategy: 'router:text:0.5', charsBefore: 622, charsAfter: 300, tokensBefore: 100, tokensAfter: 50, originalText: text })
  const tool = makeTool(store, { retrieveHash: () => { throw new Error('proxy must not be called') } })
  const out = await tool.execute({ hash })
  assert.equal(out.found, true)
  assert.equal(out.source, 'local')
  assert.equal(out.content, text)
  store.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('demoted row answers with retained lineage and skips the proxy hop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-tools-'))
  // A ttl of 1ms makes the stored original expire on the next read path.
  const store = new CcrStore({ enabled: true, ttlMs: 1, maxEntries: 50, maxBytes: 64 * 1024 * 1024, auditKeep: 100, path: join(dir, 'ccr.db'), logger: quiet })
  store.init()
  const text = 'original body ' + 'y'.repeat(500)
  const hash = contentHash(text)
  store.put({ hash, toolName: 'grep', callId: 'c2', sessionId: 's2', strategy: 'router:smart_crusher:0.19', charsBefore: 514, charsAfter: 200, tokensBefore: 80, tokensAfter: 30, originalText: text })
  // Deterministic expiry: a same-millisecond gc/get would still see the row
  // as fresh; wait the 1ms ttl out before demoting.
  await new Promise((resolve) => setTimeout(resolve, 15))
  store.gc()
  let tool = makeTool(store, { retrieveHash: () => { throw new Error('proxy must not be called for bridge hashes') } })
  const out = await tool.execute({ hash })
  assert.equal(out.found, false)
  assert.match(out.detail ?? '', /demoted/)
  assert.match(out.detail ?? '', /grep 514->200 chars, router:smart_crusher:0\.19/)
  // Unknown-but-valid hashes still fall through to the proxy path.
  const miss = await tool.execute({ hash: 'abcdef123456abcdef123456' })
  assert.equal(miss.found, false)
  assert.match(miss.detail ?? '', /proxy must not be called/)
  store.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('invalid hash format is rejected before any store touch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-tools-'))
  const store = newStore(dir)
  store.init()
  const tool = makeTool(store, { retrieveHash: () => { throw new Error('unreachable') } })
  const out = await tool.execute({ hash: 'not-a-hash' })
  assert.equal(out.found, false)
  assert.equal(out.detail, 'invalid hash format')
  store.dispose()
  rmSync(dir, { recursive: true, force: true })
})
