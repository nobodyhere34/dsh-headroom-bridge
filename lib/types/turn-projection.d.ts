/**
 * Headroom turn-data projection: scans durable `tool/result` events for the
 * bridge's retrieval marker and publishes the extracted accounting against
 * the closing Turn. This is the synchronous half of the trajectory chip -
 * the turn-tail chain selector is pure and may only read turn data, so the
 * marker detection must live in the event projection layer (exactly how
 * ui-deliverables claims its turn tails).
 * @module
 */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client';
/** One marker extracted from a tool result. */
export interface HeadroomHit {
    readonly hash: string;
    readonly charsBefore: number;
    readonly charsAfter: number;
    readonly callId: string;
    readonly toolName: string;
    readonly seq: number;
}
/** Immutable compression facts published against one Turn. */
export interface HeadroomTurnData {
    readonly hits: readonly HeadroomHit[];
}
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
    interface ConversationTurnDataMap {
        /** Headroom compressions attributed to this Turn. */
        headroom: HeadroomTurnData;
    }
}
interface HeadroomState extends HeadroomTurnData {
    readonly turn: number;
    readonly names: ReadonlyMap<string, string>;
}
/** Turn-local compression accumulator; it publishes no view Node. */
export declare const headroomTurnDefinition: ConversationNodeDefinition<HeadroomState>;
/**
 * Claim the turn-tail chain only when the closing turn carries compressions.
 * @param owner - Turn-tail owner currency for the closing assistant.
 * @returns the turn's hits as the component's match, or null to decline.
 */
export declare function selectHeadroom(owner: {
    turn: {
        data: {
            get: (kind: string) => HeadroomTurnData | undefined;
        };
    };
}): HeadroomTurnData | null;
export {};
