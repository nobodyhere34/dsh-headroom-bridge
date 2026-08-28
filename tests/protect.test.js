import { test } from 'node:test'
import assert from 'node:assert'
import { evaluateGates } from '../lib/protect.js'
import { globToRegExp } from '../lib/util.js'

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

test('gate passes an eligible candidate', () => {
  assert.equal(evaluateGates(base), null)
})

test('disabled and own-tool gates', () => {
  assert.equal(evaluateGates({ ...base, enabled: false }), 'disabled')
  assert.equal(evaluateGates({ ...base, toolName: 'headroom_retrieve' }), 'own-tool')
})

test('excluded tools never compress', () => {
  assert.equal(evaluateGates({ ...base, toolName: 'read' }), 'excluded-tool')
  assert.equal(evaluateGates({ ...base, toolName: 'web_search' }), 'excluded-tool')
  assert.equal(evaluateGates({ ...base, toolName: 'grep' }), 'excluded-tool')
})

test('error outputs protected when protectErrorOutputs on, allowed when off', () => {
  assert.equal(evaluateGates({ ...base, isError: true }), 'error-output')
  assert.equal(evaluateGates({ ...base, isError: true, protectErrorOutputs: false }), null)
})

test('short and non-plain outputs skipped', () => {
  assert.equal(evaluateGates({ ...base, text: 'short' }), 'too-short')
  assert.equal(evaluateGates({ ...base, text: undefined }), 'non-plain-text')
})

test('already-compressed content is pinned', () => {
  const t = 'x'.repeat(600) + '\n\n[headroom-bridge: 5000->900 chars offloaded. ...]'
  assert.equal(evaluateGates({ ...base, text: t }), 'already-compressed')
})

test('path-shaped args protecting source globs', () => {
  assert.equal(evaluateGates({ ...base, args: { file_path: '/a/b/app.ts' } }), 'protected-path')
  assert.equal(evaluateGates({ ...base, args: { path: 'config.json' } }), 'protected-path')
  assert.equal(evaluateGates({ ...base, args: { path: '/a/b/app.ts' }, protectPathRe: [] }), null)
  assert.equal(evaluateGates({ ...base, args: { query: 'search anything' } }), null)
})

test('strong error hints protect unflagged output within the ceiling', () => {
  const trace = 'Traceback (most recent call last):\n  File \"/app/x.py\", line 1\n' + 'z'.repeat(4000)
  assert.equal(evaluateGates({ ...base, text: trace }), 'error-output')
  const long = trace + 'z'.repeat(9000)
  assert.equal(evaluateGates({ ...base, text: long }), null)
})
