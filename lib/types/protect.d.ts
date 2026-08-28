/** Host-side protection gates evaluated before any proxy call. @module */
/** Why one tool result was left verbatim. */
export type SkipReason = 'disabled' | 'own-tool' | 'excluded-tool' | 'error-output' | 'non-plain-text' | 'too-short' | 'already-compressed' | 'protected-path' | 'inflight-cap' | 'duplicate-attempt';
/**
 * Whether any path-shaped argument hits a protected glob, compared against the
 * full value and its basename so bare names in path-typed args still match.
 */
export declare function argsHitProtectedPaths(args: unknown, globs: readonly RegExp[]): boolean;
/** Heuristic error protection ceiling in characters. */
export declare const FAILED_OUTPUT_MAX_CHARS = 8000;
/**
 * Full gate evaluation against one candidate result.
 * @returns null when the candidate proceeds, else the skip reason.
 */
export declare function evaluateGates(input: {
    enabled: boolean;
    toolName: string;
    isError: boolean;
    protectErrorOutputs: boolean;
    text: string | undefined;
    minChars: number;
    excludeToolRe: readonly RegExp[];
    protectPathRe: readonly RegExp[];
    args: unknown;
}): SkipReason | null;
