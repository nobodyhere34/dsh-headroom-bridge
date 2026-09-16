/**
 * Headroom turn-data projection: scans durable `tool/result` events for the
 * bridge's retrieval marker and publishes the extracted accounting against
 * the closing Turn. This is the synchronous half of the trajectory chip -
 * the turn-tail chain selector is pure and may only read turn data, so the
 * marker detection must live in the event projection layer (exactly how
 * ui-deliverables claims its turn tails).
 * @module
 */

import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** One marker extracted from a tool result. */
export interface HeadroomHit {
  readonly hash: string
  readonly charsBefore: number
  readonly charsAfter: number
  readonly callId: string
  readonly toolName: string
  readonly seq: number
}

/** Immutable compression facts published against one Turn. */
export interface HeadroomTurnData {
  readonly hits: readonly HeadroomHit[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Headroom compressions attributed to this Turn. */
    headroom: HeadroomTurnData
  }
}

interface HeadroomState extends HeadroomTurnData {
  readonly turn: number
  readonly names: ReadonlyMap<string, string>
}

/** The bridge's own retrieval-marker shape (src/marker.ts on the host side). */
const MARKER_RE = /\[headroom-bridge: (\d+)->(\d+) chars offloaded\. Retrieve the exact original with headroom_retrieve hash=([0-9a-f]{12,24})\]/g

function scanText(text: string): Array<{ before: number; after: number; hash: string }> {
  const found: Array<{ before: number; after: number; hash: string }> = []
  for (const match of text.matchAll(MARKER_RE)) {
    found.push({ before: Number(match[1]), after: Number(match[2]), hash: String(match[3]) })
  }
  return found
}

/** Join every text block of a tool-result message. */
function resultText(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    const b = block as { content?: unknown }
    if (!Array.isArray(b?.content)) continue
    for (const inner of b.content as Array<{ type?: string; text?: string }>) {
      if (inner?.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
    }
  }
  return parts.join('\n')
}

/** Turn-local compression accumulator; it publishes no view Node. */
export const headroomTurnDefinition: ConversationNodeDefinition<HeadroomState> = {
  kind: 'headroom',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call') return { id: String(event.data.turn), role: 'update' }
    if (event.type === 'tool/result') return { id: String(event.data.turn), role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('headroom start requires turn/start')
    return { turn: match.event.data.turn, hits: [], names: new Map() }
  },
  update: (context, match) => {
    if (match.event.type === 'tool/call') {
      const callId = String(match.event.data.callId)
      const name = typeof match.event.data.name === 'string' ? match.event.data.name : ''
      if (name.length === 0 || context.state.names.get(callId) === name) return context.state
      return { ...context.state, names: new Map(context.state.names).set(callId, name) }
    }
    if (match.event.type !== 'tool/result') return context.state
    const message = match.event.data.message as {
      content?: unknown
      source?: { callId?: string }
    }
    if (!Array.isArray(message?.content)) return context.state
    const callId = String(message.source?.callId ?? '')
    const hits: HeadroomHit[] = []
    for (const found of scanText(resultText(message.content))) {
      hits.push({
        hash: found.hash,
        charsBefore: found.before,
        charsAfter: found.after,
        callId,
        toolName: context.state.names.get(callId) ?? '',
        seq: Number(match.event.seq),
      })
    }
    if (hits.length === 0) return context.state
    return { ...context.state, hits: [...context.state.hits, ...hits] }
  },
}

/**
 * Claim the turn-tail chain only when the closing turn carries compressions.
 * @param owner - Turn-tail owner currency for the closing assistant.
 * @returns the turn's hits as the component's match, or null to decline.
 */
export function selectHeadroom(owner: {
  turn: { data: { get: (kind: string) => HeadroomTurnData | undefined } }
}): HeadroomTurnData | null {
  const data = owner.turn.data.get('headroom')
  return data === undefined || data.hits.length === 0 ? null : data
}
