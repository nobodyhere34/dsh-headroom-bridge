/**
 * Shared pure utilities: glob matching, text measurement, content hashing.
 * @module
 */
/** Compile one glob (* and ? wildcards) into an anchored RegExp. */
export declare function globToRegExp(glob: string): RegExp;
/** Whether value matches any compiled glob. */
export declare function matchesAny(value: string, globs: readonly RegExp[]): boolean;
/** Precompile a glob list once per resolution. */
export declare function compileGlobs(globs: readonly string[]): RegExp[];
/** Unicode code-point length of one string (surrogate-safe). */
export declare function codePointLength(text: string): number;
/** Structural subset of dsh ContentBlock this package inspects. */
export interface ContentLike {
    type?: unknown;
    text?: unknown;
}
/**
 * Flatten all-text block arrays into one double-newline-joined string.
 * @returns the text, or undefined when any block is non-text.
 */
export declare function flattenPlainText(blocks: readonly ContentLike[]): string | undefined;
/** SHA-256 of one UTF-8 payload, truncated to chars lowercase hex characters. */
export declare function contentHash(payload: string, chars?: number): string;
