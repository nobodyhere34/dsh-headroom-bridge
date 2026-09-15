/** Host-side protection gates evaluated before any proxy call. @module */
import { matchesAny } from './util.js';
import { isAlreadyCompressed } from './marker.js';
/** Strings above this size keep only the whole/basename check, never token scan. */
export const TOKEN_SCAN_MAX_CHARS = 16_384;
const TOKEN_SCAN_MAX_TOKENS = 1024;
const EMBEDDED_JSON_MAX_CHARS = 8_192;
function collectPathValues(value, seen, out) {
    if (typeof value === 'string') {
        out.push(value);
        // Tool bridges may pass nested arguments as a JSON string; parse back so
        // protected paths inside it are still seen (bounded, fail-open).
        const first = value.charCodeAt(0);
        if (value.length <= EMBEDDED_JSON_MAX_CHARS && (first === 123 || first === 91)) {
            try {
                collectPathValues(JSON.parse(value), seen, out);
            }
            catch {
                // not embedded JSON: the whole string is already a candidate
            }
        }
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
    for (const [, child] of Object.entries(value))
        collectPathValues(child, seen, out);
}
/** Basename of a POSIX/Windows-style path. */
function basename(p) {
    const norm = p.replace(/\\/g, '/');
    const idx = norm.lastIndexOf('/');
    return idx >= 0 ? norm.slice(idx + 1) : norm;
}
/**
 * Whole argument strings are useless as one path for shell commands (the
 * basename of `cat /a/b/x.json | head` is `head`), so each string is also
 * split into shell-word-ish tokens and every token is tried whole and by
 * basename. Oversized strings keep the whole/basename check only.
 */
const TOKEN_SPLIT_RE = /[\s|;&()<>\n]+/;
const TOKEN_LEAD_STRIP_RE = /^['"`([{,:]+/;
const TOKEN_TRAIL_STRIP_RE = /['"`)\]},;:]+$/;
/**
 * Whether any argument string (whole, basename, or any shell token thereof)
 * hits a protected glob. Errs toward protection: more matches means fewer
 * compressions, never wrong ones.
 */
export function argsHitProtectedPaths(args, globs) {
    if (globs.length === 0 || args === null || typeof args !== 'object')
        return false;
    const values = [];
    collectPathValues(args, new Set(), values);
    for (const value of values) {
        const normalized = value.replace(/\\/g, '/');
        if (matchesAny(normalized, globs))
            return true;
        const base = basename(normalized);
        if (base.length > 0 && base !== normalized && matchesAny(base, globs))
            return true;
        if (normalized.length > TOKEN_SCAN_MAX_CHARS)
            continue;
        const tokens = normalized.split(TOKEN_SPLIT_RE);
        const limit = Math.min(tokens.length, TOKEN_SCAN_MAX_TOKENS);
        for (let i = 0; i < limit; i++) {
            const token = tokens[i].replace(TOKEN_LEAD_STRIP_RE, '').replace(TOKEN_TRAIL_STRIP_RE, '');
            if (token.length === 0 || token === normalized)
                continue;
            if (matchesAny(token, globs))
                return true;
            const tokenBase = basename(token);
            if (tokenBase !== token && matchesAny(tokenBase, globs))
                return true;
        }
    }
    return false;
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