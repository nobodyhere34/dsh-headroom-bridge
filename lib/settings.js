/**
 * Mutable configuration source plus the settings-namespace wiring.

 * Arms read configuration through a getter so the web settings card can
 * hot-apply field changes without a fiber rebuild: installSettingsSection
 * hands us a thunk over the resolved settings scope, and onChange re-resolves
 * it into the same ResolvedConfig validation the loader entry uses.
 * @module
 */
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { resolveConfig, SettingsSchema } from './config.js';
/** Settings namespace key shared with the web card. */
export const HEADROOM_NS = settingsNamespace('headroom');
/** Build a mutable source from the composition entry config. */
export function createConfigSource(initial) {
    let raw = initial ?? {};
    let cfg = resolveConfig(raw);
    return {
        get: () => cfg,
        setRaw(next) {
            cfg = resolveConfig(next);
        },
    };
}
/**
 * Mount the headroom settings namespace. While a settings provider exists the
 * composition entry acts as the base layer and user edits override it; without
 * one the entry stays authoritative. Throwing validation surfaces as a write
 * refusal rather than a crash.
 * @param ctx - plugin context.
 * @param source - mutable configuration source to refresh on changes.
 * @param entry - composition entry config used as the settings base layer.
 */
export function installSettings(ctx, source, entry) {
    let current = () => entry ?? {};
    installSettingsSection(ctx, HEADROOM_NS, SettingsSchema, entry ?? {}, {
        setSource: (thunk) => {
            current = thunk;
        },
        onChange: () => {
            source.setRaw(current());
        },
    });
}
//# sourceMappingURL=settings.js.map