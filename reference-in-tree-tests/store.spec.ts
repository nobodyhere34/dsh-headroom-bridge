import { expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CcrStore, defaultStorePath, type CcrEntry } from '../src/store.ts'
import { contentHash } from '../src/util.ts'

const quiet = { warn() {} }
const entry = (text: string) => ({
  hash: contentHash(text), toolName: 'bash', callId: 'c', sessionId: 's',
  strategy: 'router:smart_crusher:1.0', charsBefore: 100, charsAfter: 10, originalText: text,
})

it('store put/get roundtrip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const path = join(dir, 'ccr.json')
  const s = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path, logger: quiet })
  s.init()
  const e = entry('payload-1')
  s.put(e)
  expect(s.get(e.hash)!.originalText).toBe('payload-1')
  expect(s.get('missing')).toBe(undefined)
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})

it('store evicts oldest past maxEntries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const path = join(dir, 'ccr.json')
  const s = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 2, path, logger: quiet })
  s.init()
  const e1 = entry('one')
  const e2 = entry('two')
  const e3 = entry('three')
  s.put(e1); s.put(e2); s.put(e3)
  expect(s.get(e1.hash)).toBe(undefined)
  expect(s.get(e2.hash)).not.toBe(undefined)
  expect(s.get(e3.hash)).not.toBe(undefined)
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})

it('store persists to disk and reloads', () => {
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
    expect(s2.get(contentHash('persist-me'))).not.toBe(undefined)
  }
  rmSync(dir, { recursive: true, force: true })
})

it('corrupt store file starts empty rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const path = join(dir, 'ccr.json')
  writeFileSync(path, 'not-json{{{')
  const s = new CcrStore({ enabled: true, ttlMs: 60000, maxEntries: 10, path, logger: quiet })
  s.init()
  expect(s.stats().entries).toBe(0)
  rmSync(dir, { recursive: true, force: true })
})

it('expired entries disappear on read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-store-'))
  const path = join(dir, 'ccr.json')
  const s = new CcrStore({ enabled: true, ttlMs: 60_000, maxEntries: 10, path, logger: quiet })
  s.init()
  const key = 'deadbeefdeadbeefdeadbeef'
  s.put({ ...entry('x'), hash: key })
  const past = Date.now() - 1000
  ;(s as unknown as { map: Map<string, CcrEntry> }).map.set(key, { ...s.get(key)!, expiresAt: past })
  expect(s.get(key)).toBe(undefined)
  s.dispose()
  rmSync(dir, { recursive: true, force: true })
})

it('defaultStorePath honors DSH_HOME', () => {
  process.env.DSH_HOME = '/tmp/hb-home-probe'
  const p = defaultStorePath('')
  expect(p.startsWith('/tmp/hb-home-probe/storages/')).toBeTruthy()
  delete process.env.DSH_HOME
})
