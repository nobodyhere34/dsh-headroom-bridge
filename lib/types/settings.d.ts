/**
 * Mutable configuration source plus the settings-namespace wiring.

 * Arms read configuration through a getter so the web settings card can
 * hot-apply field changes without a fiber rebuild: installSection
 * hands us a thunk over the resolved settings scope, and onChange re-resolves
 * it into the same ResolvedConfig validation the loader entry uses.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config as RawConfig, ResolvedConfig } from './config.js';
/** Settings namespace key shared with the web card. */
export declare const HEADROOM_NS = "headroom";
/**
 * Mutable configuration source: arms read get() for the current resolved
 * view; the settings card replaces the raw layer through setRaw().
 */
export interface ConfigSource {
    /** Current resolved, validated configuration. */
    get(): ResolvedConfig;
    /** Replace the raw layer and re-resolve (throws on invalid input). */
    setRaw(next: RawConfig): void;
}
/** Build a mutable source from the composition entry config. */
export declare function createConfigSource(initial: RawConfig | undefined): ConfigSource;
/**
 * Mount the headroom settings namespace. While a settings provider exists the
 * composition entry acts as the base layer and user edits override it; without
 * one the entry stays authoritative. Throwing validation surfaces as a write
 * refusal rather than a crash.
 * @param ctx - plugin context.
 * @param source - mutable configuration source to refresh on changes.
 * @param entry - composition entry config used as the settings base layer.
 */
export declare function installSettings(ctx: Context, source: ConfigSource, entry: RawConfig | undefined): void;
