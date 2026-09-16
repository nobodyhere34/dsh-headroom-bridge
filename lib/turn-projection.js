/**
 * Headroom turn-data projection: scans durable `tool/result` events for the
 * bridge's retrieval marker and publishes the extracted accounting against
 * the closing Turn. This is the synchronous half of the trajectory chip -
 * the turn-tail chain selector is pure and may only read turn data, so the
 * marker detection must live in the event projection layer (exactly how
 * ui-deliverables claims its turn tails).
 * @module
 */
/** The bridge's own retrieval-marker shape (src/marker.ts on the host side). */
const MARKER_RE = /\[headroom-bridge: (\d+)->(\d+) chars offloaded\. Retrieve the exact original with headroom_retrieve hash=([0-9a-f]{12,24})\]/g;
function scanText(text) {
    const found = [];
    for (const match of text.matchAll(MARKER_RE)) {
        found.push({ before: Number(match[1]), after: Number(match[2]), hash: String(match[3]) });
    }
    return found;
}
/** Join every text block of a tool-result message. */
function resultText(content) {
    const parts = [];
    for (const block of content) {
        const b = block;
        if (!Array.isArray(b?.content))
            continue;
        for (const inner of b.content) {
            if (inner?.type === 'text' && typeof inner.text === 'string')
                parts.push(inner.text);
        }
    }
    return parts.join('\n');
}
/** Turn-local compression accumulator; it publishes no view Node. */
export const headroomTurnDefinition = {
    kind: 'headroom',
    match: (event) => {
        if (event.type === 'turn/start')
            return { id: String(event.data.turn), role: 'start' };
        if (event.type === 'tool/call')
            return { id: String(event.data.turn), role: 'update' };
        if (event.type === 'tool/result')
            return { id: String(event.data.turn), role: 'update' };
        return null;
    },
    start: (_context, match) => {
        if (match.event.type !== 'turn/start')
            throw new Error('headroom start requires turn/start');
        return { turn: match.event.data.turn, hits: [], names: new Map() };
    },
    update: (context, match) => {
        if (match.event.type === 'tool/call') {
            const callId = String(match.event.data.callId);
            const name = typeof match.event.data.name === 'string' ? match.event.data.name : '';
            if (name.length === 0 || context.state.names.get(callId) === name)
                return context.state;
            return { ...context.state, names: new Map(context.state.names).set(callId, name) };
        }
        if (match.event.type !== 'tool/result')
            return context.state;
        const message = match.event.data.message;
        if (!Array.isArray(message?.content))
            return context.state;
        const callId = String(message.source?.callId ?? '');
        const hits = [];
        for (const found of scanText(resultText(message.content))) {
            hits.push({
                hash: found.hash,
                charsBefore: found.before,
                charsAfter: found.after,
                callId,
                toolName: context.state.names.get(callId) ?? '',
                seq: Number(match.event.seq),
            });
        }
        if (hits.length === 0)
            return context.state;
        return { ...context.state, hits: [...context.state.hits, ...hits] };
    },
};
/**
 * Claim the turn-tail chain only when the closing turn carries compressions.
 * @param owner - Turn-tail owner currency for the closing assistant.
 * @returns the turn's hits as the component's match, or null to decline.
 */
export function selectHeadroom(owner) {
    const data = owner.turn.data.get('headroom');
    return data === undefined || data.hits.length === 0 ? null : data;
}
//# sourceMappingURL=turn-projection.js.map