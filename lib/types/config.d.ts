/**
 * Bridge configuration: schema, defaults, and load-time resolution.
 *
 * Every deployment-varying choice is a validated field changeable from
 * cordis.yml / the injector entry config; nothing is silently defaulted
 * inside the hot path. Resolution happens once in apply() and throws on
 * invalid input (misconfiguration fails loud at load).
 * @module
 */
import z from 'schemastery';
/** Compression behavior modes. */
export type BridgeMode = 
/** Observe and log potential savings; never touch model-visible content. */
'audit'
/** Replace accepted tool-result content with compressed text + retrieval marker. */
 | 'live';
/** Arm-B reclaim policy (old oversized results at step boundary). */
export interface ArmBConfig {
    /** Total switch for the pre-step reclaim pass. */
    enabled: boolean;
    /** Reclaim tool-result text above this many Unicode characters. */
    thresholdChars: number;
    /** Replace only when the reclaim saves at least this fraction of tokens. */
    minSavingsRatio: number;
    /** Most nodes reclaimed in one pre-step pass. */
    maxPerStep: number;
}
/** Local CCR (original-text) store settings. */
export interface CcrConfig {
    /** Persist originals beside the session log for retrieval. */
    enabled: boolean;
    /** Fresh window: while inside it the model can still retrieve originals. */
    ttlMs: number;
    /** Hard ceiling on ledger row count (metadata rows included). */
    maxEntries: number;
    /** Byte budget for live originals; overflow demotes oldest-last-seen. */
    maxBytes: number;
    /** Rolling audit rows kept (kept/failed attempts, no originals). */
    auditKeep: number;
    /** Retention pass interval in milliseconds. */
    gcIntervalMs: number;
    /** Store file override; empty resolves to `<DSH_HOME>/storages/<pkg>-ccr.db`. */
    path: string;
}
/** Resolved, immutable configuration consumed by arms and tools. */
export interface ResolvedConfig {
    readonly enabled: boolean;
    readonly mode: BridgeMode;
    readonly baseUrl: string;
    /** Per-request HTTP budget in milliseconds. */
    readonly timeoutMs: number;
    /** Compress only text at least this many Unicode characters long. */
    readonly minChars: number;
    /** Replace only when the response saves at least this fraction of tokens. */
    readonly minSavingsRatio: number;
    /** Tool-name globs never compressed (plus bridge-owned tools, always). */
    readonly excludeTools: readonly string[];
    /** Skip failed results regardless of other gates. */
    readonly protectErrorOutputs: boolean;
    /** Path-argument globs (source/config files) whose results stay verbatim. */
    readonly protectPathGlobs: readonly string[];
    /** Concurrent proxy calls allowed before additional candidates skip. */
    readonly maxInflight: number;
    /** Step-boundary reclaim of old oversized results. */
    readonly armB: ArmBConfig;
    readonly ccr: CcrConfig;
}
/** Package identity used for loader naming and storage paths. */
export declare const PKG_NAME = "@nobodyhere34/dsh-headroom-bridge";
/** Log prefix used across modules. */
export declare const LOG_TAG = "headroom-bridge";
/** Tools owned by this package - their outputs are never compressed. */
export declare const OWN_TOOL_NAMES: ReadonlySet<string>;
/** Raw configuration shape accepted from composition layers. */
export interface Config {
    enabled?: boolean;
    mode?: 'audit' | 'live';
    baseUrl?: string;
    timeoutMs?: number;
    minChars?: number;
    minSavingsRatio?: number;
    excludeTools?: string[];
    protectErrorOutputs?: boolean;
    protectPathGlobs?: string[];
    maxInflight?: number;
    armB?: Partial<ArmBConfig>;
    ccr?: Partial<CcrConfig>;
}
/** Validate one mode value. */
export declare function modeOf(value: unknown): BridgeMode;
/**
 * Resolve raw configuration into the immutable runtime view.
 * @param raw - partial config from the plugin entry.
 * @returns frozen resolved config.
 * @throws when any provided field violates its declared contract.
 */
export declare function resolveConfig(raw: Config | undefined): ResolvedConfig;
/**
 * Schemastery face for the settings namespace: mirrors the raw Config shape
 * so the web card and installSection validate the same fields the
 * loader entry and resolveConfig do. Object keys are optional by schemastery
 * convention; resolution happens in resolveConfig.
 */
export declare const SettingsSchema: z<Config>;
