import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installLifecycle } from '../lib/lifecycle.js'
import { CcrStore } from '../lib/store.js'
import { contentHash } from '../lib/util.js'

const quiet = { info() {}, warn() {} }

// Isolate trashRoot()/DSH_HOME lookups from the real ~/.dsh during tests.
const sandbox = mkdtempSync(join(tmpdir(), 'hb-home-'))
process.env.DSH_HOME = sandbox
process.on('exit', () => { delete process.env.DSH_HOME })

function mkStore(dir) {
  const s = new CcrStore({
    enabled: true, ttlMs: 60000, maxEntries: 2000, maxBytes: 64 * 1024 * 1024, auditKeep: 100,
    path: join(dir, 'ccr.db'), logger: quiet,
  })
  s.init()
  return s
}

function fakeCtx(listImpl) {
  const handlers = {}
  return {
    logger: quiet,
    on(ev, fn) { (handlers[ev] ??= []).push(fn); return () => {} },
    get(name) {
      if (name === 'sessionPersistence') return { list: async () => listImpl() }
      return undefined
    },
    emit(ev, ...args) { for (const fn of handlers[ev] ?? []) fn(...args) },
  }
}

const entry = (text, sessionId) => ({
  hash: contentHash(text), toolName: 'bash', callId: 'c', sessionId,
  strategy: 'x', charsBefore: 9, charsAfter: 3, originalText: text,
})

test('domain/changed cascades the trash snapshot on every event, first included', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-life-'))
  const store = mkStore(dir)
  store.put(entry('gone-data', 'gone'))
  store.put(entry('keep-data', 'keep'))
  const ctx = fakeCtx(() => [{ header: { id: 'gone' } }, { header: { id: 'keep' } }])
  installLifecycle(ctx, store, 60000)

  // The first event after load must cascade already (no baseline priming:
  // the restart-first-delete gap is closed; re-cascades are idempotent).
  ctx.emit('domain/changed', { domain: 'dsh_delete_session', table: '', key: '', operation: 'put', value: { entries: [{ sessionId: 'gone' }] } })
  assert.equal(store.sessionIds().includes('gone'), false, 'deleted session cascaded on the first event')
  assert.notEqual(store.get(contentHash('keep-data')), undefined, 'live session untouched')

  // A repeat event is a harmless idempotent no-op for the live session.
  ctx.emit('domain/changed', { domain: 'dsh_delete_session', table: '', key: '', operation: 'put', value: { entries: [{ sessionId: 'gone' }] } })
  assert.notEqual(store.get(contentHash('keep-data')), undefined, 'repeat event kept the live session')

  // other domains are ignored even when they list a trashed id
  ctx.emit('domain/changed', { domain: 'some_other', table: '', key: '', operation: 'put', value: { entries: [{ sessionId: 'keep' }] } })
  assert.notEqual(store.get(contentHash('keep-data')), undefined, 'foreign domain ignored')
  store.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('reconcile drops orphans not persisted and not trashed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-life-'))
  const store = mkStore(dir)
  store.put(entry('live-data', 'live'))
  store.put(entry('orphan-data', 'orphan'))
  // persistence now returns only 'live'; 'orphan' vanished without a domain event
  const ctx = fakeCtx(() => [{ header: { id: 'live' } }])
  installLifecycle(ctx, store, 60000)
  // reconcile runs on install; await one microtask drain + a short delay
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(store.sessionIds().includes('orphan'), false, 'orphan swept')
  assert.notEqual(store.get(contentHash('live-data')), undefined)
  store.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('compaction event runs a retention pass (demotes expired)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-life-'))
  const store = new CcrStore({
    enabled: true, ttlMs: 1, maxEntries: 2000, maxBytes: 64 * 1024 * 1024, auditKeep: 100,
    path: join(dir, 'ccr.db'), logger: quiet,
  })
  store.init()
  const e = entry('to-demote', 's')
  store.put(e)
  const ctx = fakeCtx(() => [{ header: { id: 's' } }])
  installLifecycle(ctx, store, 60000)
  await new Promise((r) => setTimeout(r, 20)) // let the 1ms window expire
  ctx.emit('session/event', { id: 's' }, { type: 'compaction/summary', shadowedRange: { start: 0, end: 5 }, shadowedSeqs: [], shadowedTokenCount: 0 })
  await new Promise((r) => setTimeout(r, 2100)) // debounce is 2s
  assert.equal(store.get(e.hash), undefined, 'compaction-triggered gc demoted the expired original')
  store.dispose()
  rmSync(dir, { recursive: true, force: true })
})
