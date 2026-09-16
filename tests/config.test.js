import { test } from 'node:test'
import assert from 'node:assert'
import { resolveConfig, modeOf } from '../lib/config.js'

test('resolveConfig applies defaults for an empty input', () => {
  const c = resolveConfig(undefined)
  assert.equal(c.enabled, true)
  assert.equal(c.mode, 'audit')
  assert.equal(c.baseUrl, 'http://127.0.0.1:8787')
  assert.equal(c.minChars, 500)
  assert.equal(c.minSavingsRatio, 0.15)
  assert.equal(c.maxInflight, 2)
  assert.ok(c.excludeTools.includes('read'))
  assert.ok(c.armB.enabled)
  assert.equal(c.armB.thresholdChars, 16384)
  assert.equal(c.armB.minSavingsRatio, 0.3)
  assert.equal(c.armB.maxPerStep, 2)
  assert.ok(c.ccr.enabled)
})

test('resolveConfig honors overrides', () => {
  const c = resolveConfig({
    mode: 'live',
    baseUrl: 'http://127.0.0.1:9000',
    minChars: 1000,
    armB: { enabled: false, thresholdChars: 30000 },
  })
  assert.equal(c.mode, 'live')
  assert.equal(c.baseUrl, 'http://127.0.0.1:9000')
  assert.equal(c.minChars, 1000)
  assert.equal(c.armB.enabled, false)
  assert.equal(c.armB.thresholdChars, 30000)
  assert.equal(c.armB.minSavingsRatio, 0.3)
})

test('invalid fields fail loud', () => {
  assert.throws(() => resolveConfig({ minChars: -1 }))
  assert.throws(() => resolveConfig({ minChars: 0 }))
  assert.throws(() => resolveConfig({ minSavingsRatio: 1.5 }))
  assert.throws(() => resolveConfig({ excludeTools: 'read' }))
  assert.throws(() => resolveConfig({ maxInflight: 0 }))
  assert.throws(() => resolveConfig({ armB: { thresholdChars: 0 } }))
  assert.throws(() => resolveConfig({ ccr: { ttlMs: 0 } }))
})

test('modeOf accepts audit and live only', () => {
  assert.equal(modeOf('audit'), 'audit')
  assert.equal(modeOf('live'), 'live')
  assert.throws(() => modeOf('aggressive'))
})

test('protection lists fall back to defaults on empty arrays', () => {
  // Regression (0.1.2): schemastery materializes unset arrays as [] in the
  // resolved settings scope; resolveConfig must not throw on [] or the
  // settings-namespace install dies and the web card is lost at every boot.
  const empty = resolveConfig({ excludeTools: [], protectPathGlobs: [] })
  assert.ok(empty.excludeTools.includes('read'))
  assert.ok(empty.protectPathGlobs.length > 0)
  // A materialized nested scope (the exact shape installSection onChange feeds)
  // resolves clean, including the user layer overrides.
  const scoped = resolveConfig({ enabled: true, protectErrorOutputs: true, mode: 'live', excludeTools: [], protectPathGlobs: [], armB: {}, ccr: {} })
  assert.equal(scoped.mode, 'live')
  assert.ok(scoped.excludeTools.includes('read'))
  // a placeholder override remains legal
  assert.deepEqual(resolveConfig({ excludeTools: ['__none__'] }).excludeTools, ['__none__'])
  // malformed entries still fail loud
  assert.throws(() => resolveConfig({ excludeTools: ['read', ''] }))
})
