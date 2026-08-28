/**
 * Arm B: reclaim OLD oversized tool results at the next step boundary.
 *
 * Arm A compresses NEW results before materialization; Arm B backstops the
 * rare misses (proxy unreachable at the time, a transient skip, or an
 * exactly-once attempt before an operator flipped the mode). It walks the
 * current surface inside agent/pre-step and shadow-replaces any
 * over-threshold tool-result node that the protection gates allow, following
 * the shared shadow-price protocol: a log-only compaction/prune metering
 * event immediately followed by a tool/result surface replace citing the
 * shadowed node, so the original stays in the session log and replay/fork
 * reconstructs both the compressed view and the verbatim text.
 *
 * High threshold + small per-pass budget keep this a rare backstop, not a
 * hot-path rewrite of already-sent history.
 * @module
 */
import { freezeMessage } from '@deepseek-ai/dsh-llm';
import { LOG_TAG } from './config.js';
import { codePointLength, compileGlobs, contentHash, flattenPlainText } from './util.js';
import { appendMarker, renderMarker } from './marker.js';
import { evaluateGates } from './protect.js';
import { compressedContentOf } from './proxy-client.js';
import { assertReplacementSmaller, assertRetrievable } from './invariant.js';
/** Map a result source callId back to its logged tool identity. */
function toolCallOf(session, callId) {
    for (const event of session.events) {
        if (event.type !== 'tool/call' || event.data.callId !== callId)
            continue;
        let args;
        try {
            args = JSON.parse(event.data.arguments);
        }
        catch {
            args = undefined;
        }
        return { name: event.data.name, args };
    }
    return undefined;
}
/** The single result block of a tool-result message, when shaped as expected. */
function resultBlock(message) {
    const block = message.content[0];
    return block?.type === 'tool-result' ? block : undefined;
}
/**
 * Reclaim the first maxPerStep eligible candidates of one session.
 * Attempted seqs stay marked so later passes advance past low-yield nodes.
 */
async function reclaimPass(ctx, getConfig, store, getClient, counters, session, agent, signal, attempted) {
    const meter = ctx.get('tokenMeter');
    const excludeToolRe = compileGlobs(getConfig().excludeTools);
    const protectPathRe = compileGlobs(getConfig().protectPathGlobs);
    const candidates = [];
    for (const seq of [...session.surface.nodes]) {
        if (candidates.length >= getConfig().armB.maxPerStep)
            break;
        const event = session.events[seq];
        if (event?.type !== 'tool/result')
            continue;
        if (attempted.has(seq))
            continue;
        const call = toolCallOf(session, event.data.message.source.callId);
        if (call === undefined)
            continue; // no tool identity: stay conservative
        const block = resultBlock(event.data.message);
        if (block === undefined)
            continue;
        const text = flattenPlainText(block.content);
        const skip = evaluateGates({
            enabled: true,
            toolName: call.name,
            isError: event.data.error !== undefined,
            protectErrorOutputs: getConfig().protectErrorOutputs,
            text,
            minChars: getConfig().armB.thresholdChars,
            excludeToolRe,
            protectPathRe,
            args: call.args,
        });
        if (skip !== null) {
            if (skip !== 'too-short')
                ctx.logger.debug(LOG_TAG + ': armB skip(' + skip + ') seq=' + seq);
            continue;
        }
        candidates.push({ seq, event, toolName: call.name, args: call.args });
    }
    for (const candidate of candidates) {
        if (signal.aborted)
            return;
        attempted.add(candidate.seq);
        counters.attempts++;
        const message = candidate.event.data.message;
        const block = resultBlock(message);
        if (block === undefined)
            continue;
        const text = flattenPlainText(block.content);
        if (text === undefined)
            continue;
        const originalChars = codePointLength(text);
        try {
            const response = await getClient().compressToolMessage({
                toolCallId: message.source.callId,
                text,
                model: agent.options.model ?? 'deepseek-chat',
                timeoutMs: getConfig().timeoutMs,
            });
            const compressed = compressedContentOf(response);
            if (compressed === undefined)
                continue;
            const compressedChars = codePointLength(compressed);
            const tokenRatio = response.tokens_before > 0
                ? (response.tokens_before - response.tokens_after) / response.tokens_before
                : 0;
            const charRatio = originalChars > 0 ? 1 - compressedChars / originalChars : 0;
            const savings = Math.max(tokenRatio, charRatio);
            const chain = Array.isArray(response.transforms_applied) ? response.transforms_applied.join('>') : '';
            const profitable = savings >= getConfig().armB.minSavingsRatio && compressedChars < originalChars;
            const pct = Math.round(savings * 100);
            if (!profitable) {
                ctx.logger.info(LOG_TAG + ': armB [audit] seq=' + candidate.seq + ' ' + candidate.toolName +
                    ' chars ' + originalChars + '->' + compressedChars + ' (-' + pct + '%) profitable=no');
                continue;
            }
            if (getConfig().mode !== 'live') {
                ctx.logger.info(LOG_TAG + ': armB [audit] seq=' + candidate.seq + ' ' + candidate.toolName +
                    ' chars ' + originalChars + '->' + compressedChars + ' (-' + pct + '%) mode=audit');
                continue;
            }
            if (meter === undefined) {
                ctx.logger.warn(LOG_TAG + ': armB skipped (no tokenMeter for shadow pricing) seq=' + candidate.seq);
                continue;
            }
            assertReplacementSmaller(originalChars, compressedChars);
            const hash = contentHash(text);
            store.put({
                hash,
                toolName: candidate.toolName,
                callId: message.source.callId,
                sessionId: String(agent.id),
                strategy: chain,
                charsBefore: originalChars,
                charsAfter: compressedChars,
                originalText: text,
            });
            assertRetrievable(store.get(hash) !== undefined, hash);
            const replacementText = appendMarker(compressed, renderMarker(hash, originalChars, compressedChars));
            const replacementMessage = freezeMessage({
                ...message,
                content: [{ ...block, content: [{ type: 'text', text: replacementText }] }],
            });
            // Shadow-price protocol: metering event and replacement appended
            // synchronously adjacent; the replacement cites its shadowed node.
            session.append('compaction/prune', {
                shadowedRange: { start: candidate.seq, end: candidate.seq },
                shadowedSeqs: [candidate.seq],
                shadowedTokenCount: meter.estimateMessage(message),
            });
            session.append('tool/result', { ...candidate.event.data, message: replacementMessage }, {
                surfaceOp: { op: 'replace', start: candidate.seq, end: candidate.seq },
                sourceEventSeqs: [candidate.seq],
            });
            counters.savedChars += originalChars - compressedChars;
            counters.adopted++;
            ctx.logger.info(LOG_TAG + ': armB [live] seq=' + candidate.seq + ' ' + candidate.toolName +
                ' chars ' + originalChars + '->' + compressedChars + ' (-' + pct + '%) hash=' + hash);
        }
        catch (error) {
            counters.failures++;
            ctx.logger.warn(LOG_TAG + ': armB pass failed (' + String(error) + ') seq=' + candidate.seq);
        }
    }
}
/**
 * Install the arm-B pre-step listener on one context.
 * @returns a disposer; Cordis also unwinds listeners on fiber disposal.
 */
export function installArmB(ctx, getConfig, store, getClient, counters) {
    const attempted = new WeakMap();
    const off = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
        try {
            if (!getConfig().armB.enabled)
                return next();
            let tried = attempted.get(agent.session);
            if (tried === undefined) {
                tried = new Set();
                attempted.set(agent.session, tried);
            }
            await reclaimPass(ctx, getConfig, store, getClient, counters, agent.session, agent, signal, tried);
        }
        catch (error) {
            ctx.logger.warn(LOG_TAG + ': armB listener failed (' + String(error) + ')');
        }
        return next();
    });
    return () => { off(); };
}
//# sourceMappingURL=arm-b.js.map