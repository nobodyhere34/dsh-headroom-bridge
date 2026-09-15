/**
 * Bridge configuration: schema, defaults, and load-time resolution.
 *
 * Every deployment-varying choice is a validated field changeable from
 * cordis.yml / the injector entry config; nothing is silently defaulted
 * inside the hot path. Resolution happens once in apply() and throws on
 * invalid input (misconfiguration fails loud at load).
 * @module
 */

import z from 'schemastery'

/** Compression behavior modes. */
export type BridgeMode =
  /** Observe and log potential savings; never touch model-visible content. */
  | 'audit'
  /** Replace accepted tool-result content with compressed text + retrieval marker. */
  | 'live'

/** Arm-B reclaim policy (old oversized results at step boundary). */
export interface ArmBConfig {
  /** Total switch for the pre-step reclaim pass. */
  enabled: boolean
  /** Reclaim tool-result text above this many Unicode characters. */
  thresholdChars: number
  /** Replace only when the reclaim saves at least this fraction of tokens. */
  minSavingsRatio: number
  /** Most nodes reclaimed in one pre-step pass. */
  maxPerStep: number
}
/** Local CCR (original-text) store settings. */
export interface CcrConfig {
  /** Persist originals beside the session log for retrieval. */
  enabled: boolean
  /** Entry time-to-live in milliseconds. */
  ttlMs: number
  /** Maximum entries before oldest-stored eviction. */
  maxEntries: number
  /** Store file override; empty resolves to `<DSH_HOME>/storages/<pkg>-ccr.json`. */
  path: string
}

/** Resolved, immutable configuration consumed by arms and tools. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly mode: BridgeMode
  readonly baseUrl: string
  /** Per-request HTTP budget in milliseconds. */
  readonly timeoutMs: number
  /** Compress only text at least this many Unicode characters long. */
  readonly minChars: number
  /** Replace only when the response saves at least this fraction of tokens. */
  readonly minSavingsRatio: number
  /** Tool-name globs never compressed (plus bridge-owned tools, always). */
  readonly excludeTools: readonly string[]
  /** Skip failed results regardless of other gates. */
  readonly protectErrorOutputs: boolean
  /** Path-argument globs (source/config files) whose results stay verbatim. */
  readonly protectPathGlobs: readonly string[]
  /** Concurrent proxy calls allowed before additional candidates skip. */
  readonly maxInflight: number
  /** Step-boundary reclaim of old oversized results. */
  readonly armB: ArmBConfig
  readonly ccr: CcrConfig
}

/** Package identity used for loader naming and storage paths. */
export const PKG_NAME = '@nobodyhere34/dsh-headroom-bridge'

/** Log prefix used across modules. */
export const LOG_TAG = 'headroom-bridge'

/** Tools owned by this package - their outputs are never compressed. */
export const OWN_TOOL_NAMES: ReadonlySet<string> = new Set(['headroom_retrieve'])

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
]

/**
 * Path arguments naming source or config artifacts mark results the model may
 * need byte-exact (patching); compression offloads would corrupt edits.
 */
const DEFAULT_PROTECT_PATH_GLOBS = [
  '*.js', '*.mjs', '*.cjs', '*.ts', '*.tsx', '*.jsx', '*.py', '*.pyi',
  '*.go', '*.rs', '*.java', '*.kt', '*.rb', '*.php', '*.cs', '*.c', '*.h',
  '*.cpp', '*.hpp', '*.sql', '*.json', '*.yml', '*.yaml', '*.toml', '*.lock',
]

const DEFAULT_CCR_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_CCR_MAX_ENTRIES = 2000

/** Raw configuration shape accepted from composition layers. */
export interface Config {
  enabled?: boolean
  mode?: 'audit' | 'live'
  baseUrl?: string
  timeoutMs?: number
  minChars?: number
  minSavingsRatio?: number
  excludeTools?: string[]
  protectErrorOutputs?: boolean
  protectPathGlobs?: string[]
  maxInflight?: number
  armB?: Partial<ArmBConfig>
  ccr?: Partial<CcrConfig>
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function positiveInt(value: unknown, fallback: number, label: string): number {
  const resolved = numOr(value, fallback)
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(LOG_TAG + ": " + label + " must be a positive safe integer, got " + String(value))
  }
  return resolved
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback
}

function nonEmptyString(value: unknown, fallback: string, label: string): string {
  const resolved = strOr(value, fallback)
  if (resolved.length === 0 || resolved.trim() !== resolved) {
    throw new Error(LOG_TAG + ": " + label + " must be a non-empty trimmed string")
  }
  return resolved
}

function ratio01(value: unknown, fallback: number, label: string): number {
  const resolved = numOr(value, fallback)
  if (resolved < 0 || resolved > 1) {
    throw new Error(LOG_TAG + ": " + label + " must lie within [0, 1]")
  }
  return resolved
}

function bool(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== "boolean") throw new Error(LOG_TAG + ": " + label + " must be boolean")
  return value
}

function stringArray(value: unknown, fallback: readonly string[], label: string): string[] {
  const resolved = value ?? [...fallback]
  if (!Array.isArray(resolved)) throw new Error(LOG_TAG + ": " + label + " must be an array of strings")
  return resolved.map((entry, i) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.trim() !== entry) {
      throw new Error(LOG_TAG + ": " + label + "[" + i + "] must be a non-empty trimmed string")
    }
    return entry
  })
}

/**
 * Protection lists must never be emptied: `[] ?? fallback` silently passes an
 * empty array through, which once disabled the whole read/path gates in the
 * field. Neutralizing a list means an unused placeholder name, not [].
 */
function stringArrayNonEmpty(value: unknown, fallback: readonly string[], label: string): string[] {
  const resolved = stringArray(value, fallback, label)
  if (resolved.length === 0) {
    throw new Error(LOG_TAG + ": " + label + " must keep at least one entry (neutralize with an unused placeholder instead of [])")
  }
  return resolved
}

/** Validate one mode value. */
export function modeOf(value: unknown): BridgeMode {
  if (value === undefined || value === null) return "audit"
  if (value === "audit" || value === "live") return value
  throw new Error(LOG_TAG + ": mode must be audit|live, got " + String(value))
}

/**
 * Resolve raw configuration into the immutable runtime view.
 * @param raw - partial config from the plugin entry.
 * @returns frozen resolved config.
 * @throws when any provided field violates its declared contract.
 */
export function resolveConfig(raw: Config | undefined): ResolvedConfig {
  const src = raw ?? {}
  const ccrRaw = src.ccr ?? {}
  const armBRaw = src.armB ?? {}
  return Object.freeze({
    enabled: bool(src.enabled, true, "enabled"),
    mode: modeOf(src.mode),
    baseUrl: nonEmptyString(src.baseUrl, "http://127.0.0.1:8787", "baseUrl"),
    timeoutMs: positiveInt(src.timeoutMs, 30_000, "timeoutMs"),
    minChars: positiveInt(src.minChars, 500, "minChars"),
    minSavingsRatio: ratio01(src.minSavingsRatio, 0.15, "minSavingsRatio"),
    excludeTools: Object.freeze(stringArrayNonEmpty(src.excludeTools, DEFAULT_EXCLUDE_TOOLS, "excludeTools")),
    protectErrorOutputs: bool(src.protectErrorOutputs, true, "protectErrorOutputs"),
    protectPathGlobs: Object.freeze(stringArrayNonEmpty(src.protectPathGlobs, DEFAULT_PROTECT_PATH_GLOBS, "protectPathGlobs")),
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
      path: typeof ccrRaw.path === 'string' ? ccrRaw.path : '',
    }),
  })
}

/**
 * Schemastery face for the settings namespace: mirrors the raw Config shape
 * so the web card and installSection validate the same fields the
 * loader entry and resolveConfig do. Object keys are optional by schemastery
 * convention; resolution happens in resolveConfig.
 */
export const SettingsSchema: z<Config> = z.object({
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
    path: z.string(),
  }),
})
