/**
 * Shared pure utilities: glob matching, text measurement, content hashing.
 * @module
 */

import { createHash } from 'node:crypto'

/** Compile one glob (* and ? wildcards) into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '[\\s\\S]*'; i++; continue }
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += '\\' + c
    } else {
      out += c
    }
  }
  return new RegExp('^' + out + '$')
}

/** Whether value matches any compiled glob. */
export function matchesAny(value: string, globs: readonly RegExp[]): boolean {
  return globs.some((re) => re.test(value))
}

/** Precompile a glob list once per resolution. */
export function compileGlobs(globs: readonly string[]): RegExp[] {
  return globs.map(globToRegExp)
}

/** Unicode code-point length of one string (surrogate-safe). */
export function codePointLength(text: string): number {
  return Array.from(text).length
}

/** Structural subset of dsh ContentBlock this package inspects. */
export interface ContentLike {
  type?: unknown
  text?: unknown
}

/**
 * Flatten all-text block arrays into one double-newline-joined string.
 * @returns the text, or undefined when any block is non-text.
 */
export function flattenPlainText(blocks: readonly ContentLike[]): string | undefined {
  let text = ''
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') return undefined
    text += (text.length > 0 ? '\n\n' : '') + block.text
  }
  return text
}

/** SHA-256 of one UTF-8 payload, truncated to chars lowercase hex characters. */
export function contentHash(payload: string, chars = 24): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, Math.max(4, chars))
}
