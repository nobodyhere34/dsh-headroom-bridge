import { test } from 'node:test'
import assert from 'node:assert'
import {
  globToRegExp, matchesAny, codePointLength, contentHash, flattenPlainText,
} from '../lib/util.js'
import { renderMarker, appendMarker, isAlreadyCompressed, MARKER_PREFIX } from '../lib/marker.js'

test('globToRegExp anchors and expands wildcards', () => {
  assert.ok(matchesAny('read', [globToRegExp('read')]))
  assert.ok(matchesAny('web_search', [globToRegExp('web_*')]))
  assert.ok(matchesAny('src/deep/nested/x.ts', [globToRegExp('**/*.ts')]))
  assert.ok(!matchesAny('run_code', [globToRegExp('read'), globToRegExp('grep')]))
  assert.ok(!matchesAny('foo/bar', [globToRegExp('*.ts')]))
})

test('codePointLength counts Unicode code points', () => {
  assert.equal(codePointLength('abc'), 3)
  assert.equal(codePointLength('中文'), 2)
  assert.equal(codePointLength('😀'), 1)
  assert.equal(codePointLength('emoji'), 5)
})

test('contentHash is stable and truncated', () => {
  const h = contentHash('same payload')
  assert.equal(h, contentHash('same payload'))
  assert.equal(h.length, 24)
  assert.notEqual(contentHash('a'), contentHash('b'))
})

test('flattenPlainText requires all-text blocks', () => {
  const joined = 'a' + '\n\n' + 'b'
  assert.equal(flattenPlainText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), joined)
  assert.equal(flattenPlainText([]), '')
  assert.equal(flattenPlainText([{ type: 'image', data: 1 }]), undefined)
  assert.equal(flattenPlainText([{ type: 'text', text: 'a' }, { type: 'image' }]), undefined)
})

test('renderMarker embeds hash and accounting', () => {
  const m = renderMarker('0123456789abcdef01234567', 1000, 200)
  assert.ok(m.startsWith(MARKER_PREFIX))
  assert.match(m, /1000->200 chars offloaded/)
  assert.ok(m.includes('headroom_retrieve hash=0123456789abcdef01234567'))
})

test('appendMarker always separates content from marker with one blank line', () => {
  assert.equal(appendMarker('line', 'M'), 'line' + '\n\n' + 'M')
  assert.equal(appendMarker('line\n', 'M'), 'line' + '\n\n' + 'M')
})

test('isAlreadyCompressed pins every marker family', () => {
  assert.ok(isAlreadyCompressed('x\n' + MARKER_PREFIX + ' 100->10 chars offloaded. ...]'))
  assert.ok(isAlreadyCompressed('{"_ccr_dropped":"<<ccr:abcd1234 5_rows>>"}'))
  assert.ok(isAlreadyCompressed('[N lines compressed to M. Retrieve more: hash=abc123]'))
  assert.ok(isAlreadyCompressed('[config folded. Retrieve original: hash=xyz]'))
  assert.ok(!isAlreadyCompressed('plain text without markers'))
})
