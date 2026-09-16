import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CcrStore, defaultStorePath } from '../lib/store.js'
import { contentHash } from '../lib/util.js'

const quiet = { warn() {} }
const entry = (text, over = {}) => ({
  hash: contentHash(text), toolName: 'bash', callId: 'c', sessionId: 's',
  strategy: 'router:smart_crusher:1.0', charsBefore: 100, charsAfter: 10, originalText: text, ...over,
})
const mk = (dir, over = {}) => new CcrStore({
  enabled: true, ttlMs: 60000, maxEntries: 2000, maxBytes: 64 * 1024 * 1024, auditKeep: 100,
  path: join(dir, 'ccr.db'), logger: quiet, ...over,
})

test('store put/get roundtrip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const s = mk(dir)
  s.init()
  const e = entry('payload-1')
  s.put(e)
  assert.equal(s.get(e.hash).originalText, 'payload-1')
  assert.equal(s.get('missing'), undefined)
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('store persists to disk and reloads (SQLite is immediate)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const path = join(dir, 'ccr.db')
  {
    const s = mk(dir)
    s.init()
    s.put(entry('persist-me'))
    s.dispose()
  }
  {
    const s2 = mk(dir)
    s2.init()
    assert.notEqual(s2.get(contentHash('persist-me')), undefined)
    s2.dispose()
  }
  rmSync(dir, { recursive: true, force: true })
})

test('corrupt store file starts empty rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const path = join(dir, 'ccr.db')
  writeFileSync(path, 'not-a-sqlite-file{{{')
  const s = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, maxBytes: 1024, auditKeep: 10, path, logger: quiet })
  s.init()
  // open fails on a non-sqlite file -> store degrades to disabled, not a throw
  assert.equal(s.stats().entries, 0)
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('expired originals miss on read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const s = mk(dir, { ttlMs: 1 })
  s.init()
  const key = 'deadbeefdeadbeefdeadbeef'
  s.put({ ...entry('x'), hash: key })
  await new Promise((r) => setTimeout(r, 20))
  s.gc()
  assert.equal(s.get(key), undefined)
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('byte budget demotes oldest-last-seen, accounting survives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const s = mk(dir, { maxBytes: 40 })
  s.init()
  const a = entry('A'.repeat(30))
  const b = entry('B'.repeat(30))
  s.put(a)
  s.put(b)
  assert.ok(s.stats().bytesLive <= 40 || s.get(a.hash) || s.get(b.hash))
  // at least one demoted; both still browsable as metadata via activity()
  const demoted = (s.get(a.hash) === undefined ? 1 : 0) + (s.get(b.hash) === undefined ? 1 : 0)
  assert.ok(demoted >= 1, 'oldest demoted under budget')
  const act = s.activity(10)
  assert.ok(act.some((r) => r.hash === a.hash) && act.some((r) => r.hash === b.hash), 'metadata rows kept')
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('deleteSession cascades ledger and audit rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const s = mk(dir)
  s.init()
  s.put(entry('keep-me', { sessionId: 'gone' }))
  s.put(entry('stay-me', { sessionId: 'live' }))
  s.audit({ toolName: 'bash', callId: 'c', sessionId: 'gone', state: 'not-adopted', reason: 'mode-audit', charsBefore: 5, charsAfter: 3, strategy: '' })
  assert.equal(s.sessionIds().sort().join(','), 'gone,live')
  const removed = s.deleteSession('gone')
  assert.ok(removed >= 2, 'both the ledger row and the audit row removed')
  assert.equal(s.sessionIds().join(','), 'live')
  assert.equal(s.activity(10).some((r) => r.sessionId === 'gone'), false)
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('audit rows roll over auditKeep', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const s = mk(dir, { auditKeep: 3 })
  s.init()
  for (let i = 0; i < 6; i++) {
    s.audit({ toolName: 'bash', callId: 'c' + i, sessionId: 's', state: 'not-adopted', reason: 'r', charsBefore: 1, charsAfter: 1, strategy: '' })
  }
  const auditRows = s.activity(100).filter((r) => r.kind === 'audit')
  assert.equal(auditRows.length, 3)
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('inspect exposes metadata + original presence without counting a hit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const s = mk(dir)
  s.init()
  const e = entry('inspect-me', { sessionId: 'sX' })
  s.put(e)
  const found = s.inspect(e.hash)
  assert.equal(found.row.state, 'adopted')
  assert.equal(found.row.sessionId, 'sX')
  assert.equal(found.row.originalAvailable, true)
  assert.equal(found.originalText, 'inspect-me')
  assert.equal(s.stats().hits, 0)
  assert.equal(s.inspect('nope'), undefined)
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('legacy JSON ledger imports once and is parked aside', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const legacy = join(dir, 'dsh-headroom-bridge-ccr.json')
  const now = Date.now()
  writeFileSync(legacy, JSON.stringify({
    version: 1,
    entries: [
      { hash: contentHash('legacy-live'), toolName: 'bash', callId: 'c', sessionId: 's', strategy: 'x', charsBefore: 9, charsAfter: 3, originalText: 'legacy-live', storedAt: now, expiresAt: now + 60000 },
      { hash: contentHash('legacy-stale'), toolName: 'bash', callId: 'c', sessionId: 's', strategy: 'x', charsBefore: 9, charsAfter: 3, originalText: 'legacy-stale', storedAt: now, expiresAt: now - 1 },
    ],
  }))
  const s = mk(dir)
  s.init()
  assert.notEqual(s.get(contentHash('legacy-live')), undefined, 'live entry imported')
  assert.equal(s.get(contentHash('legacy-stale')), undefined, 'stale entry skipped')
  assert.ok(existsSync(legacy + '.imported'), 'legacy file parked aside')
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('defaultStorePath honors DSH_HOME', () => {
  process.env.DSH_HOME = '/tmp/hb-home-probe'
  const p = defaultStorePath('')
  assert.ok(p.startsWith('/tmp/hb-home-probe/storages/'))
  delete process.env.DSH_HOME
})

test('activity session filter pushes into the query', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const s = mk(dir)
  s.init()
  for (let i = 0; i < 30; i++) s.put(entry('global-' + i, { sessionId: 'other' }))
  const mine = entry('mine-1', { sessionId: 'mine' })
  s.put(mine)
  for (let i = 0; i < 30; i++) s.put(entry('global-late-' + i, { sessionId: 'other' }))
  // Global stream at a small cap would crowd 'mine' out entirely...
  assert.equal(s.activity(5).some((r) => r.sessionId === 'mine'), false)
  // ...but the filtered query returns it regardless of global pressure.
  const rows = s.activity(5, 'mine')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].hash, mine.hash)
  assert.equal(rows[0].sessionId, 'mine')
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})
