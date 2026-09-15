import { expect, it } from 'vitest'
import {
  globToRegExp, matchesAny, codePointLength, contentHash, flattenPlainText,
} from '../src/util.ts'
import { renderMarker, appendMarker, isAlreadyCompressed, MARKER_PREFIX } from '../src/marker.ts'

it('globToRegExp anchors and expands wildcards', () => {
  expect(matchesAny('read', [globToRegExp('read')])).toBeTruthy()
  expect(matchesAny('web_search', [globToRegExp('web_*')])).toBeTruthy()
  expect(matchesAny('src/deep/nested/x.ts', [globToRegExp('**/*.ts')])).toBeTruthy()
  expect(!matchesAny('run_code', [globToRegExp('read'), globToRegExp('grep')])).toBeTruthy()
  expect(!matchesAny('foo/bar', [globToRegExp('*.ts')])).toBeTruthy()
})

it('codePointLength counts Unicode code points', () => {
  expect(codePointLength('abc')).toBe(3)
  expect(codePointLength('中文')).toBe(2)
  expect(codePointLength('😀')).toBe(1)
  expect(codePointLength('emoji')).toBe(5)
})

it('contentHash is stable and truncated', () => {
  const h = contentHash('same payload')
  expect(h).toBe(contentHash('same payload'))
  expect(h.length).toBe(24)
  expect(contentHash('a')).not.toBe(contentHash('b'))
})

it('flattenPlainText requires all-text blocks', () => {
  const joined = 'a' + '\n\n' + 'b'
  expect(flattenPlainText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe(joined)
  expect(flattenPlainText([])).toBe('')
  expect(flattenPlainText([{ type: 'image', data: 1 } as never])).toBe(undefined)
  expect(flattenPlainText([{ type: 'text', text: 'a' }, { type: 'image' }])).toBe(undefined)
})

it('renderMarker embeds hash and accounting', () => {
  const m = renderMarker('0123456789abcdef01234567', 1000, 200)
  expect(m.startsWith(MARKER_PREFIX)).toBeTruthy()
  expect(m).toMatch(/1000->200 chars offloaded/)
  expect(m.includes('headroom_retrieve hash=0123456789abcdef01234567')).toBeTruthy()
})

it('appendMarker always separates content from marker with one blank line', () => {
  expect(appendMarker('line', 'M')).toBe('line' + '\n\n' + 'M')
  expect(appendMarker('line\n', 'M')).toBe('line' + '\n\n' + 'M')
})

it('isAlreadyCompressed pins every marker family', () => {
  expect(isAlreadyCompressed('x\n' + MARKER_PREFIX + ' 100->10 chars offloaded. ...]')).toBeTruthy()
  expect(isAlreadyCompressed('{"_ccr_dropped":"<<ccr:abcd1234 5_rows>>"}')).toBeTruthy()
  expect(isAlreadyCompressed('[N lines compressed to M. Retrieve more: hash=abc123]')).toBeTruthy()
  expect(isAlreadyCompressed('[config folded. Retrieve original: hash=xyz]')).toBeTruthy()
  expect(!isAlreadyCompressed('plain text without markers')).toBeTruthy()
})
