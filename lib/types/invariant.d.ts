/** Package-level runtime invariants enforced at adoption sites. @module */
/**
 * A replacement may only ship when strictly smaller than the original.
 * @throws when the replacement would not shrink model-visible content.
 */
export declare function assertReplacementSmaller(originalChars: number, replacementChars: number): void;
/**
 * The CCR store must already hold an adopted hash (store-before-ship).
 * @param present - whether the lookup succeeded.
 * @param hash - adopted content hash.
 * @throws when an accepted replacement lacks its retrievable original.
 */
export declare function assertRetrievable(present: boolean, hash: string): void;
