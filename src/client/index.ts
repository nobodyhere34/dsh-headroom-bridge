/**
 * dsh-headroom-bridge web card: the settings.plugin.item contribution under
 * the 'headroom' namespace, in the Plugins section's configurable tab. The
 * card renders the same disclosure chrome and staged-field form the shipped
 * Shell / Agent loop / Web search cards use, plus live bridge stats and the
 * recent compression ledger fetched from the Host /headroom-bridge/api routes.
 * @module @deepseek-ai/dsh-headroom-bridge/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings surface's Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { HEADROOM_NS, HeadroomCardController } from './headroom-card-controller.ts'
import { HeadroomCard } from './HeadroomCard.tsx'
import { en, zh } from './locales.ts'

/** Dictionary namespace owned by this package's card. */
const NS = 'settings.plugins.headroom'

/** Required services: the slot registry, the locale plugin, and the settings scope. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Mount the headroom settings card.
 * @param ctx - client context with the slots, locale, and settingsScope services.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), '@deepseek-ai/dsh-headroom-bridge: card dictionaries')

  const headroom = new HeadroomCardController(ctx.settingsScope.bind({ namespace: HEADROOM_NS }))

  ctx.effect(() => ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register({
      name: 'settings.plugin.item',
      key: HEADROOM_NS,
      locale: NS,
      inject: () => headroom.inject(),
    }, HeadroomCard),
  ), '@deepseek-ai/dsh-headroom-bridge: settings card')
}
