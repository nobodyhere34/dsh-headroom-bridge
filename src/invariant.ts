/** Package-level runtime invariants enforced at adoption sites. @module */

import { LOG_TAG } from './config.js'

/**
 * A replacement may only ship when strictly smaller than the original.
 * @throws when the replacement would not shrink model-visible content.
 */
export function assertReplacementSmaller(originalChars: number, replacementChars: number): void {
  if (!(replacementChars > 0 && replacementChars < originalChars)) {
    throw new Error(LOG_TAG + ': replacement (' + replacementChars +
      ' chars) must be smaller than original (' + originalChars + ' chars)')
  }
}

/**
 * The CCR store must already hold an adopted hash (store-before-ship).
 * @param present - whether the lookup succeeded.
 * @param hash - adopted content hash.
 * @throws when an accepted replacement lacks its retrievable original.
 */
export function assertRetrievable(present: boolean, hash: string): void {
  if (!present) throw new Error(LOG_TAG + ': adopted replacement lost its retrievable original hash=' + hash)
}
