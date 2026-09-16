/**
 * dsh-headroom-bridge web surfaces: the settings.plugin.item card under the
 * 'headroom' namespace (Plugins section's configurable tab) plus the
 * trajectory compression chip. The card renders the same disclosure chrome
 * and staged-field form the shipped cards use, with live stats and the recent
 * operations ledger from the Host /headroom-bridge/api routes. The chip is a
 * turn-tail chain entry elected by an event projection that scans durable
 * tool results for the retrieval marker.
 * @module @deepseek-ai/dsh-headroom-bridge/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings surface's Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ui-chat / ui-conversation Context merges (ctx.uiConversation)
// and the conversation.chat.turnTail slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the Session Controller Context merge (ctx.sessions) - the feed
// that tells the trajectory bubbles which session is on screen.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { HEADROOM_NS, HeadroomCardController } from './headroom-card-controller.ts'
import { HeadroomCard } from './HeadroomCard.tsx'
import { CompressChip } from './CompressChip.tsx'
import { installTrajectoryChip, driveTrajectoryView } from './trajectory-chip.ts'
import { headroomTurnDefinition, selectHeadroom } from '../turn-projection.ts'
import { en, zh } from './locales.ts'

/** Dictionary namespace owned by this package's card. */
const NS = 'settings.plugins.headroom'

/**
 * ui-conversation persists the per-session conversation store (whole value)
 * under this localStorage key, and session open restores the view from it
 * (activateView reads readConversationViewPreference). Pre-writing
 * view=trajectory + viewRequest{focus:callId} therefore lands the deep link
 * on the trajectory's official inspect-focus path (TrajectoryView consumes
 * viewRequest.focus as its anchor, expanding history to reach it).
 */
const CONVERSATION_STORE_KEY = 'dsh.conversation'

/** Required services: slots, locale, the settings scope, the conversation projection, and the session feed. */
export const inject = ['slots', 'locale', 'settingsScope', 'uiConversation', 'sessions']

/**
 * Ask the next open of one session to land on its trajectory view, focused
 * on a tool call when given. Pure preference pre-write (no DOM tricks); a
 * session whose view is already mounted keeps its live state - the
 * trajectory bubbles cover in-session navigation anyway.
 * @param sessionId - session to open.
 * @param callId - tool call to focus, when the source row knows one.
 * @returns nothing; storage failures silently degrade to open-only.
 */
function preferTrajectoryView(sessionId: string, callId?: string): void {
  try {
    const key = `${CONVERSATION_STORE_KEY}.${sessionId}`
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>
    saved.view = 'trajectory'
    saved.viewRequest = callId === undefined || callId === '' ? null : { view: 'trajectory', focus: callId }
    localStorage.setItem(key, JSON.stringify(saved))
  } catch {
    // private mode / quota: the deep link degrades to plain session open.
  }
}

/**
 * Mount the headroom settings card and the trajectory compression chip.
 * @param ctx - client context with the slots, locale, settingsScope and uiConversation services.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), '@deepseek-ai/dsh-headroom-bridge: card dictionaries')

  // Session deep-linking is a workspace-navigation capability; it is optional
  // (a deployment may mount no workspace UI), so it is resolved conditionally
  // rather than declared as a hard dependency. Activity rows carry callIds, so
  // the link pre-arms the trajectory view + inspect focus (see above).
  const nav = ctx.get('uiWorkspace') as { openSession?: (id: string) => void } | undefined
  const headroom = new HeadroomCardController(
    ctx.settingsScope.bind({ namespace: HEADROOM_NS }),
    nav?.openSession
      ? (id: string, callId?: string) => {
        preferTrajectoryView(id, callId)
        nav.openSession?.(id)
        // Cold path: the pre-write is hydrated by the store on first mount.
        // Warm path (session already mounted this run, store ignores the
        // preference): drive the DOM directly. Idempotent with the cold path -
        // once the view is on trajectory the tab is aria-selected and is not
        // re-clicked; the row focus composes with either route.
        driveTrajectoryView(callId)
      }
      : undefined,
  )

  ctx.effect(() => ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register({
      name: 'settings.plugin.item',
      key: HEADROOM_NS,
      locale: NS,
      inject: () => headroom.inject(),
    }, HeadroomCard),
  ), '@deepseek-ai/dsh-headroom-bridge: settings card')

  // Trajectory face: the projection accumulates per-turn compression facts
  // from durable events (arm A's materialized marker and arm B's surface
  // replace both carry one, attributed to the row's own turn); the chain
  // entry claims only turns that carry any, and at a deliberately low rank so
  // it never displaces another turn-tail (deliverables) on a turn that has both.
  ctx.effect(() => ctx.uiConversation.events.register(headroomTurnDefinition),
    '@deepseek-ai/dsh-headroom-bridge: turn projection')
  ctx.effect(() => ctx.slots.inject('conversation.chat.turnTail', () =>
    ctx.slots.register({
      name: 'conversation.chat.turnTail',
      // Chain election tries ascending priority first; deliverables registers
      // at the default 0, so a high rank keeps the headroom chip behind it.
      priority: 100,
      select: selectHeadroom,
      locale: NS,
    }, CompressChip),
  ), '@deepseek-ai/dsh-headroom-bridge: trajectory chip')

  // Trajectory-view bubbles: ui-trajectory offers no plugin extension point,
  // so this follows the ecosystem's direct-DOM precedent and attaches one
  // bubble per compressed tool row, matched by the callId the ledger stamped.
  const translate = ctx.locale.bind(NS)
  ctx.effect(() => installTrajectoryChip(ctx, (key, vars) => translate(key, vars)),
    '@deepseek-ai/dsh-headroom-bridge: trajectory bubbles')
}
