import { expect, it } from 'vitest'
import { resolveConfig, modeOf } from '../src/config.ts'

it('resolveConfig applies defaults for an empty input', () => {
  const c = resolveConfig(undefined)
  expect(c.enabled).toBe(true)
  expect(c.mode).toBe('audit')
  expect(c.baseUrl).toBe('http://127.0.0.1:8787')
  expect(c.minChars).toBe(500)
  expect(c.minSavingsRatio).toBe(0.15)
  expect(c.maxInflight).toBe(2)
  expect(c.excludeTools.includes('read')).toBeTruthy()
  expect(c.armB.enabled).toBeTruthy()
  expect(c.armB.thresholdChars).toBe(16384)
  expect(c.armB.minSavingsRatio).toBe(0.3)
  expect(c.armB.maxPerStep).toBe(2)
  expect(c.ccr.enabled).toBeTruthy()
})

it('resolveConfig honors overrides', () => {
  const c = resolveConfig({
    mode: 'live',
    baseUrl: 'http://127.0.0.1:9000',
    minChars: 1000,
    armB: { enabled: false, thresholdChars: 30000 },
  })
  expect(c.mode).toBe('live')
  expect(c.baseUrl).toBe('http://127.0.0.1:9000')
  expect(c.minChars).toBe(1000)
  expect(c.armB.enabled).toBe(false)
  expect(c.armB.thresholdChars).toBe(30000)
  expect(c.armB.minSavingsRatio).toBe(0.3)
})

it('invalid fields fail loud', () => {
  expect(() => resolveConfig({ minChars: -1 })).toThrow()
  expect(() => resolveConfig({ minChars: 0 })).toThrow()
  expect(() => resolveConfig({ minSavingsRatio: 1.5 })).toThrow()
  expect(() => resolveConfig({ excludeTools: 'read' as never })).toThrow()
  expect(() => resolveConfig({ maxInflight: 0 })).toThrow()
  expect(() => resolveConfig({ armB: { thresholdChars: 0 } })).toThrow()
  expect(() => resolveConfig({ ccr: { ttlMs: 0 } })).toThrow()
})

it('modeOf accepts audit and live only', () => {
  expect(modeOf('audit')).toBe('audit')
  expect(modeOf('live')).toBe('live')
  expect(() => modeOf('aggressive')).toThrow()
})
