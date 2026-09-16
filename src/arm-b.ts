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

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// Type-only: the compaction/prune SessionEventMap merge + tokenMeter ctx merge.
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionEvent, ToolResultMessage, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ResolvedConfig } from './config.js'
import { LOG_TAG } from './config.js'
import { codePointLength, compileGlobs, contentHash, flattenPlainText } from './util.js'
import { appendMarker, renderMarker } from './marker.js'
import { evaluateGates } from './protect.js'
import { CcrStore } from './store.js'
import { HeadroomClient, compressedContentOf } from './proxy-client.js'
import { assertReplacementSmaller, assertRetrievable } from './invariant.js'
import type { BridgeCounters } from './stats.js'

/** One reclaim candidate: an over-threshold tool-result surface node. */
interface Candidate {
  readonly seq: SessionSeq
  readonly event: SessionEvent<'tool/result'>
  readonly toolName: string
  readonly args: unknown
}

/** Map a result source callId back to its logged tool identity. */
function toolCallOf(session: Session, callId: string): { name: string; args: unknown } | undefined {
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'tool/call' || event.data.callId !== callId) continue
    let args: unknown
    try {
      args = JSON.parse(event.data.arguments)
    } catch {
      args = undefined
    }
    return { name: event.data.name, args }
  }
  return undefined
}

/** The single result block of a tool-result message, when shaped as expected. */
function resultBlock(message: ToolResultMessage): Extract<ContentBlock, { type: 'tool-result' }> | undefined {
  const block = message.content[0]
  return block?.type === 'tool-result' ? block : undefined
}

/**
 * Reclaim the first maxPerStep eligible candidates of one session.
 * Attempted seqs stay marked so later passes advance past low-yield nodes.
 */
async function reclaimPass(
  ctx: Context,
  getConfig: () => ResolvedConfig,
  store: CcrStore,
  getClient: () => HeadroomClient,
  counters: BridgeCounters,
  session: Session,
  agent: Agent,
  signal: AbortSignal,
  attempted: Set<number>,
): Promise<void> {
  const meter = ctx.get('tokenMeter') as { estimateMessage(m: unknown): number } | undefined
  const excludeToolRe = compileGlobs(getConfig().excludeTools)
  const protectPathRe = compileGlobs(getConfig().protectPathGlobs)

  const candidates: Candidate[] = []
  for (const seq of [...session.surface.nodes]) {
    if (candidates.length >= getConfig().armB.maxPerStep) break
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/result') continue
    if (attempted.has(seq)) continue
    const call = toolCallOf(session, event.data.message.source.callId)
    if (call === undefined) continue // no tool identity: stay conservative
    const block = resultBlock(event.data.message)
    if (block === undefined) continue
    const text = flattenPlainText(block.content)
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
    })
    if (skip !== null) {
      if (skip !== 'too-short') ctx.logger.debug(LOG_TAG + ': armB skip(' + skip + ') seq=' + seq)
      continue
    }
    candidates.push({ seq, event, toolName: call.name, args: call.args })
  }

  for (const candidate of candidates) {
    if (signal.aborted) return
    attempted.add(candidate.seq)
    counters.attempts++
    const message = candidate.event.data.message
    const block = resultBlock(message)
    if (block === undefined) continue
    const text = flattenPlainText(block.content)
    if (text === undefined) continue
    const originalChars = codePointLength(text)
    try {
      const response = await getClient().compressToolMessage({
        toolCallId: message.source.callId,
        text,
        model: agent.options.model ?? 'deepseek-chat',
        timeoutMs: getConfig().timeoutMs,
      })
      const compressed = compressedContentOf(response)
      if (compressed === undefined) continue
      const compressedChars = codePointLength(compressed)
      const tokenRatio = response.tokens_before > 0
        ? (response.tokens_before - response.tokens_after) / response.tokens_before
        : 0
      const charRatio = originalChars > 0 ? 1 - compressedChars / originalChars : 0
      const savings = Math.max(tokenRatio, charRatio)
      const chain = Array.isArray(response.transforms_applied) ? response.transforms_applied.join('>') : ''
      const profitable = savings >= getConfig().armB.minSavingsRatio && compressedChars < originalChars
      const pct = Math.round(savings * 100)

      if (!profitable) {
        ctx.logger.info(LOG_TAG + ': armB [audit] seq=' + candidate.seq + ' ' + candidate.toolName +
          ' chars ' + originalChars + '->' + compressedChars + ' (-' + pct + '%) profitable=no')
        store.audit({
          toolName: candidate.toolName, callId: message.source.callId,
          sessionId: String(agent.session?.id ?? agent.id ?? ''), state: 'not-adopted',
          reason: 'armB-below-min-savings', charsBefore: originalChars, charsAfter: compressedChars, strategy: chain,
        })
        continue
      }
      if (getConfig().mode !== 'live') {
        ctx.logger.info(LOG_TAG + ': armB [audit] seq=' + candidate.seq + ' ' + candidate.toolName +
          ' chars ' + originalChars + '->' + compressedChars + ' (-' + pct + '%) mode=audit')
        store.audit({
          toolName: candidate.toolName, callId: message.source.callId,
          sessionId: String(agent.session?.id ?? agent.id ?? ''), state: 'not-adopted',
          reason: 'armB-mode-audit', charsBefore: originalChars, charsAfter: compressedChars, strategy: chain,
        })
        continue
      }
      if (meter === undefined) {
        ctx.logger.warn(LOG_TAG + ': armB skipped (no tokenMeter for shadow pricing) seq=' + candidate.seq)
        continue
      }

      assertReplacementSmaller(originalChars, compressedChars)
      const hash = contentHash(text)
      store.put({
        hash,
        toolName: candidate.toolName,
        callId: message.source.callId,
        sessionId: String(agent.session?.id ?? agent.id ?? ''),
        strategy: chain,
        charsBefore: originalChars,
        charsAfter: compressedChars,
        tokensBefore: response.tokens_before,
        tokensAfter: response.tokens_after,
        seq: candidate.seq,
        originalText: text,
      })
      assertRetrievable(store.get(hash) !== undefined, hash)
      const replacementText = appendMarker(compressed, renderMarker(hash, originalChars, compressedChars))
      const replacementMessage = freezeMessage<ToolResultMessage>({
        ...message,
        content: [{ ...block, content: [{ type: 'text', text: replacementText }] }],
      })
      // Shadow-price protocol: metering event and replacement appended
      // synchronously adjacent; the replacement cites its shadowed node.
      session.append('compaction/prune', {
        shadowedRange: { start: candidate.seq, end: candidate.seq },
        shadowedSeqs: [candidate.seq],
        shadowedTokenCount: meter.estimateMessage(message),
      })
      session.append('tool/result', { ...candidate.event.data, message: replacementMessage }, {
        surfaceOp: { op: 'replace', startSeq: candidate.seq, endSeq: candidate.seq },
        sourceEventSeqs: [candidate.seq],
      })
      counters.savedChars += originalChars - compressedChars
      counters.adopted++
      ctx.logger.info(LOG_TAG + ': armB [live] seq=' + candidate.seq + ' ' + candidate.toolName +
        ' chars ' + originalChars + '->' + compressedChars + ' (-' + pct + '%) hash=' + hash)
    } catch (error: unknown) {
      counters.failures++
      ctx.logger.warn(LOG_TAG + ': armB pass failed (' + String(error) + ') seq=' + candidate.seq)
    }
  }
}

/**
 * Install the arm-B pre-step listener on one context.
 * @returns a disposer; Cordis also unwinds listeners on fiber disposal.
 */
export function installArmB(
  ctx: Context,
  getConfig: () => ResolvedConfig,
  store: CcrStore,
  getClient: () => HeadroomClient,
  counters: BridgeCounters,
): () => void {
  const attempted = new WeakMap<Session, Set<number>>()

  const off = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    try {
      if (!getConfig().armB.enabled) return next()
      let tried = attempted.get(agent.session)
      if (tried === undefined) {
        tried = new Set<number>()
        attempted.set(agent.session, tried)
      }
      await reclaimPass(ctx, getConfig, store, getClient, counters, agent.session, agent, signal, tried)
    } catch (error: unknown) {
      ctx.logger.warn(LOG_TAG + ': armB listener failed (' + String(error) + ')')
    }
    return next()
  })

  return () => { off() }
}