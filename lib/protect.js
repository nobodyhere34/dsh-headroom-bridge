/** Host-side protection gates evaluated before any proxy call. @module */
import { matchesAny } from './util.js';
import { isAlreadyCompressed } from './marker.js';
/** Argument keys whose values may carry file paths. */
const PATH_ARG_KEYS = new Set([
    'path', 'file_path', 'filePath', 'file', 'filename', 'old_path', 'new_path',
    'src', 'source', 'target', 'dest', 'destination', 'directory', 'dir',
    'root', 'cwd', 'folder', 'notebook_path',
]);
function collectPathValues(value, seen, out) {
    if (typeof value === 'string') {
        if (value.includes('/') || value.includes('\\'))
            out.push(value);
        return;
    }
    if (value === null || typeof value !== 'object')
        return;
    if (seen.has(value))
        return;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value)
            collectPathValues(item, seen, out);
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        collectPathValues(child, seen, out);
        if (PATH_ARG_KEYS.has(key) && typeof child === 'string')
            out.push(child);
    }
}
/** Basename of a POSIX/Windows-style path. */
function basename(p) {
    const norm = p.replace(/\\/g, '/');
    const idx = norm.lastIndexOf('/');
    return idx >= 0 ? norm.slice(idx + 1) : norm;
}
/**
 * Whether any path-shaped argument hits a protected glob, compared against the
 * full value and its basename so bare names in path-typed args still match.
 */
export function argsHitProtectedPaths(args, globs) {
    if (globs.length === 0 || args === null || typeof args !== 'object')
        return false;
    const values = [];
    collectPathValues(args, new Set(), values);
    return values.some((value) => {
        const normalized = value.replace(/\\/g, '/');
        if (matchesAny(normalized, globs))
            return true;
        const base = basename(normalized);
        return base.length > 0 && base !== normalized && matchesAny(base, globs);
    });
}
/**
 * Strong failure markers protect plausible-error prose even when the dispatch
 * was not flagged isError; applies within FAILED_OUTPUT_MAX_CHARS per the
 * research matrix (section 10.4).
 */
const ERROR_HINT_RE = /(?:traceback \(most recent call last\)|uncaught (?:exception|error)|segmentation fault|fatal error|error: |exception: |panicked at)/i;
/** Heuristic error protection ceiling in characters. */
export const FAILED_OUTPUT_MAX_CHARS = 8_000;
/**
 * Full gate evaluation against one candidate result.
 * @returns null when the candidate proceeds, else the skip reason.
 */
export function evaluateGates(input) {
    if (!input.enabled)
        return 'disabled';
    if (input.toolName === 'headroom_retrieve')
        return 'own-tool';
    if (matchesAny(input.toolName, input.excludeToolRe))
        return 'excluded-tool';
    if (input.isError && input.protectErrorOutputs)
        return 'error-output';
    if (input.text === undefined)
        return 'non-plain-text';
    if (input.protectErrorOutputs && input.text.length <= FAILED_OUTPUT_MAX_CHARS &&
        ERROR_HINT_RE.test(input.text))
        return 'error-output';
    if (Array.from(input.text).length < input.minChars)
        return 'too-short';
    if (isAlreadyCompressed(input.text))
        return 'already-compressed';
    if (argsHitProtectedPaths(input.args, input.protectPathRe))
        return 'protected-path';
    return null;
}
//# sourceMappingURL=protect.js.map