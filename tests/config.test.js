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

test('protection lists reject empty-array overrides', () => {
  assert.throws(() => resolveConfig({ excludeTools: [] }), /at least one entry/)
  assert.throws(() => resolveConfig({ protectPathGlobs: [] }), /at least one entry/)
  // a placeholder override remains legal
  assert.deepEqual(resolveConfig({ excludeTools: ['__none__'] }).excludeTools, ['__none__'])
})
