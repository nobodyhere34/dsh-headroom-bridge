import { expect, it } from 'vitest'
import { evaluateGates } from '../src/protect.ts'
import { globToRegExp } from '../src/util.ts'

const base = {
  enabled: true,
  toolName: 'run_code',
  isError: false,
  protectErrorOutputs: true,
  text: 'x'.repeat(2000),
  minChars: 500,
  excludeToolRe: [globToRegExp('read'), globToRegExp('grep'), globToRegExp('web_*')],
  protectPathRe: [globToRegExp('*.ts'), globToRegExp('*.json')],
  args: {},
}

it('gate passes an eligible candidate', () => {
  expect(evaluateGates(base)).toBe(null)
})

it('disabled and own-tool gates', () => {
  expect(evaluateGates({ ...base, enabled: false })).toBe('disabled')
  expect(evaluateGates({ ...base, toolName: 'headroom_retrieve' })).toBe('own-tool')
})

it('excluded tools never compress', () => {
  expect(evaluateGates({ ...base, toolName: 'read' })).toBe('excluded-tool')
  expect(evaluateGates({ ...base, toolName: 'web_search' })).toBe('excluded-tool')
  expect(evaluateGates({ ...base, toolName: 'grep' })).toBe('excluded-tool')
})

it('error outputs protected when protectErrorOutputs on, allowed when off', () => {
  expect(evaluateGates({ ...base, isError: true })).toBe('error-output')
  expect(evaluateGates({ ...base, isError: true, protectErrorOutputs: false })).toBe(null)
})

it('short and non-plain outputs skipped', () => {
  expect(evaluateGates({ ...base, text: 'short' })).toBe('too-short')
  expect(evaluateGates({ ...base, text: undefined })).toBe('non-plain-text')
})

it('already-compressed content is pinned', () => {
  const t = 'x'.repeat(600) + '\n\n[headroom-bridge: 5000->900 chars offloaded. ...]'
  expect(evaluateGates({ ...base, text: t })).toBe('already-compressed')
})

it('path-shaped args protecting source globs', () => {
  expect(evaluateGates({ ...base, args: { file_path: '/a/b/app.ts' } })).toBe('protected-path')
  expect(evaluateGates({ ...base, args: { path: 'config.json' } })).toBe('protected-path')
  expect(evaluateGates({ ...base, args: { path: '/a/b/app.ts' }, protectPathRe: [] })).toBe(null)
  expect(evaluateGates({ ...base, args: { query: 'search anything' } })).toBe(null)
})

it('strong error hints protect unflagged output within the ceiling', () => {
  const trace = 'Traceback (most recent call last):\n  File "/app/x.py", line 1\n' + 'z'.repeat(4000)
  expect(evaluateGates({ ...base, text: trace })).toBe('error-output')
  const long = trace + 'z'.repeat(9000)
  expect(evaluateGates({ ...base, text: long })).toBe(null)
})
