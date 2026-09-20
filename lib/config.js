/**
 * Bridge configuration: schema, defaults, and load-time resolution.
 *
 * Every deployment-varying choice is a validated field changeable from
 * cordis.yml / the injector entry config; nothing is silently defaulted
 * inside the hot path. Resolution happens once in apply() and throws on
 * invalid input (misconfiguration fails loud at load).
 * @module
 */
import z from '@deepseek-ai/schemastery';
/** Package identity used for loader naming and storage paths. */
export const PKG_NAME = '@nobodyhere34/dsh-headroom-bridge';
/** Log prefix used across modules. */
export const LOG_TAG = 'headroom-bridge';
/** Tools owned by this package - their outputs are never compressed. */
export const OWN_TOOL_NAMES = new Set(['headroom_retrieve']);
const DEFAULT_EXCLUDE_TOOLS = [
    'read',
    'glob',
    'grep',
    'edit',
    'write',
    'multiedit',
    'notebook_edit',
    'str_replace_editor',
    'web_search',
    'web_fetch',
    'view',
    'todo_write',
];
/**
 * Path arguments naming source or config artifacts mark results the model may
 * need byte-exact (patching); compression offloads would corrupt edits.
 */
const DEFAULT_PROTECT_PATH_GLOBS = [
    '*.js', '*.mjs', '*.cjs', '*.ts', '*.tsx', '*.jsx', '*.py', '*.pyi',
    '*.go', '*.rs', '*.java', '*.kt', '*.rb', '*.php', '*.cs', '*.c', '*.h',
    '*.cpp', '*.hpp', '*.sql', '*.json', '*.yml', '*.yaml', '*.toml', '*.lock',
];
const DEFAULT_CCR_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CCR_MAX_ENTRIES = 2000;
const DEFAULT_CCR_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_CCR_AUDIT_KEEP = 2000;
const DEFAULT_CCR_GC_INTERVAL_MS = 60 * 1000;
function numOr(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function positiveInt(value, fallback, label) {
    const resolved = numOr(value, fallback);
    if (!Number.isSafeInteger(resolved) || resolved < 1) {
        throw new Error(LOG_TAG + ": " + label + " must be a positive safe integer, got " + String(value));
    }
    return resolved;
}
function strOr(value, fallback) {
    return typeof value === "string" ? value : fallback;
}
function nonEmptyString(value, fallback, label) {
    const resolved = strOr(value, fallback);
    if (resolved.length === 0 || resolved.trim() !== resolved) {
        throw new Error(LOG_TAG + ": " + label + " must be a non-empty trimmed string");
    }
    return resolved;
}
function ratio01(value, fallback, label) {
    const resolved = numOr(value, fallback);
    if (resolved < 0 || resolved > 1) {
        throw new Error(LOG_TAG + ": " + label + " must lie within [0, 1]");
    }
    return resolved;
}
function bool(value, fallback, label) {
    if (value === undefined || value === null)
        return fallback;
    if (typeof value !== "boolean")
        throw new Error(LOG_TAG + ": " + label + " must be boolean");
    return value;
}
function stringArray(value, fallback, label) {
    const resolved = value ?? [...fallback];
    if (!Array.isArray(resolved))
        throw new Error(LOG_TAG + ": " + label + " must be an array of strings");
    return resolved.map((entry, i) => {
        if (typeof entry !== "string" || entry.length === 0 || entry.trim() !== entry) {
            throw new Error(LOG_TAG + ": " + label + "[" + i + "] must be a non-empty trimmed string");
        }
        return entry;
    });
}
/**
 * Protection lists must never run empty: an empty (or missing) list falls
 * back to the built-in default rather than disabling the gate. Emptying must
 * NOT throw either — schemastery materializes unset array fields as `[]` in
 * the resolved settings scope, so a throwing resolver poisons the very
 * settings-namespace install and drops the web card at every boot (the 0.1.2
 * regression). To neutralize a list, use an unused placeholder name.
 */
function stringArrayOrDefault(value, fallback, label) {
    const resolved = stringArray(value, fallback, label);
    return resolved.length === 0 ? [...fallback] : resolved;
}
/** Validate one mode value. */
export function modeOf(value) {
    if (value === undefined || value === null)
        return "audit";
    if (value === "audit" || value === "live")
        return value;
    throw new Error(LOG_TAG + ": mode must be audit|live, got " + String(value));
}
/**
 * Resolve raw configuration into the immutable runtime view.
 * @param raw - partial config from the plugin entry.
 * @returns frozen resolved config.
 * @throws when any provided field violates its declared contract.
 */
export function resolveConfig(raw) {
    const src = raw ?? {};
    const ccrRaw = src.ccr ?? {};
    const armBRaw = src.armB ?? {};
    return Object.freeze({
        enabled: bool(src.enabled, true, "enabled"),
        mode: modeOf(src.mode),
        baseUrl: nonEmptyString(src.baseUrl, "http://127.0.0.1:8787", "baseUrl"),
        timeoutMs: positiveInt(src.timeoutMs, 30_000, "timeoutMs"),
        minChars: positiveInt(src.minChars, 500, "minChars"),
        minSavingsRatio: ratio01(src.minSavingsRatio, 0.15, "minSavingsRatio"),
        excludeTools: Object.freeze(stringArrayOrDefault(src.excludeTools, DEFAULT_EXCLUDE_TOOLS, "excludeTools")),
        protectErrorOutputs: bool(src.protectErrorOutputs, true, "protectErrorOutputs"),
        protectPathGlobs: Object.freeze(stringArrayOrDefault(src.protectPathGlobs, DEFAULT_PROTECT_PATH_GLOBS, "protectPathGlobs")),
        maxInflight: positiveInt(src.maxInflight, 2, "maxInflight"),
        armB: Object.freeze({
            enabled: bool(armBRaw.enabled, true, 'armB.enabled'),
            thresholdChars: positiveInt(armBRaw.thresholdChars, 16_384, 'armB.thresholdChars'),
            minSavingsRatio: ratio01(armBRaw.minSavingsRatio, 0.3, 'armB.minSavingsRatio'),
            maxPerStep: positiveInt(armBRaw.maxPerStep, 2, 'armB.maxPerStep'),
        }),
        ccr: Object.freeze({
            enabled: bool(ccrRaw.enabled, true, 'ccr.enabled'),
            ttlMs: positiveInt(ccrRaw.ttlMs, DEFAULT_CCR_TTL_MS, 'ccr.ttlMs'),
            maxEntries: positiveInt(ccrRaw.maxEntries, DEFAULT_CCR_MAX_ENTRIES, 'ccr.maxEntries'),
            maxBytes: positiveInt(ccrRaw.maxBytes, DEFAULT_CCR_MAX_BYTES, 'ccr.maxBytes'),
            auditKeep: positiveInt(ccrRaw.auditKeep, DEFAULT_CCR_AUDIT_KEEP, 'ccr.auditKeep'),
            gcIntervalMs: positiveInt(ccrRaw.gcIntervalMs, DEFAULT_CCR_GC_INTERVAL_MS, 'ccr.gcIntervalMs'),
            path: typeof ccrRaw.path === 'string' ? ccrRaw.path : '',
        }),
    });
}
/**
 * Schemastery face for the settings namespace: mirrors the raw Config shape
 * so the web card and installSection validate the same fields the
 * loader entry and resolveConfig do. Object keys are optional by schemastery
 * convention; resolution happens in resolveConfig.
 */
export const SettingsSchema = z.object({
    enabled: z.boolean(),
    mode: z.union([z.const('audit'), z.const('live')]),
    baseUrl: z.string(),
    timeoutMs: z.number(),
    minChars: z.number(),
    minSavingsRatio: z.number(),
    excludeTools: z.array(z.string()),
    protectErrorOutputs: z.boolean(),
    protectPathGlobs: z.array(z.string()),
    maxInflight: z.number(),
    armB: z.object({
        enabled: z.boolean(),
        thresholdChars: z.number(),
        minSavingsRatio: z.number(),
        maxPerStep: z.number(),
    }),
    ccr: z.object({
        enabled: z.boolean(),
        ttlMs: z.number(),
        maxEntries: z.number(),
        maxBytes: z.number(),
        auditKeep: z.number(),
        gcIntervalMs: z.number(),
        path: z.string(),
    }),
});
//# sourceMappingURL=config.js.map