import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CcrStore, defaultStorePath } from '../lib/store.js'
import { contentHash } from '../lib/util.js'

const quiet = { warn() {} }
const entry = (text) => ({
  hash: contentHash(text), toolName: 'bash', callId: 'c', sessionId: 's',
  strategy: 'router:smart_crusher:1.0', charsBefore: 100, charsAfter: 10, originalText: text,
})

test('store put/get roundtrip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const path = join(dir, 'ccr.json')
  const s = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path, logger: quiet })
  s.init()
  const e = entry('payload-1')
  s.put(e)
  assert.equal(s.get(e.hash).originalText, 'payload-1')
  assert.equal(s.get('missing'), undefined)
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('store evicts oldest past maxEntries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const path = join(dir, 'ccr.json')
  const s = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 2, path, logger: quiet })
  s.init()
  const e1 = entry('one')
  const e2 = entry('two')
  const e3 = entry('three')
  s.put(e1); s.put(e2); s.put(e3)
  assert.equal(s.get(e1.hash), undefined)
  assert.notEqual(s.get(e2.hash), undefined)
  assert.notEqual(s.get(e3.hash), undefined)
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('store persists to disk and reloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const path = join(dir, 'ccr.json')
  {
    const s = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path, logger: quiet })
    s.init()
    s.put(entry('persist-me'))
    s.flush()
  }
  {
    const s2 = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path, logger: quiet })
    s2.init()
    assert.notEqual(s2.get(contentHash('persist-me')), undefined)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('corrupt store file starts empty rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const path = join(dir, 'ccr.json')
  writeFileSync(path, 'not-json{{{')
  const s = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path, logger: quiet })
  s.init()
  assert.equal(s.stats().entries, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('expired entries disappear on read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const path = join(dir, 'ccr.json')
  const s = new CcrStore({ enabled: true, ttlMs: 60_000, maxEntries: 10, path, logger: quiet })
  s.init()
  const key = 'deadbeefdeadbeefdeadbeef'
  s.put({ ...entry('x'), hash: key })
  const past = Date.now() - 1000
  s.map.set(key, { ...s.get(key), expiresAt: past })
  assert.equal(s.get(key), undefined)
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('defaultStorePath honors DSH_HOME', () => {
  process.env.DSH_HOME = '/tmp/hb-home-probe'
  const p = defaultStorePath('')
  assert.ok(p.startsWith('/tmp/hb-home-probe/storages/'))
  delete process.env.DSH_HOME
})
