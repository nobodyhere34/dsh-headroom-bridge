/**
 * Arm A: compress NEW tool results before they materialize.
 *
 * Ordered per docs/tool-execution-pipeline.md: listeners run inside the
 * tools/post-execute waterfall and MUST await next() first, so downstream
 * policy settles before we inspect what will ship. The acceptance chain is
 * RESEARCH-REPORT.md section 10.7: DSH-side protection gates, exactly-once
 * attempt per callId, inflight cap, proxy call under CCR mode, savings +
 * strict-shrink validation, then (live mode) store-before-ship adoption.
 * Every failure path keeps the original decision untouched (fail-open).
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.js'
import { LOG_TAG, OWN_TOOL_NAMES } from './config.js'
import { codePointLength, compileGlobs, contentHash, flattenPlainText } from './util.js'
import { appendMarker, renderMarker } from './marker.js'
import { evaluateGates } from './protect.js'
import { CcrStore } from './store.js'
import { HeadroomClient, compressedContentOf } from './proxy-client.js'
import { assertReplacementSmaller, assertRetrievable } from './invariant.js'
import type { BridgeCounters } from './stats.js'

/** Upper bound of distinct callIds tracked for exactly-once behavior. */
const ATTEMPT_LRU_MAX = 512

/** What an arm pass decided about one candidate. */
interface ArmOutcome {
  readonly replacementText: string
  readonly hash: string
  readonly charsBefore: number
  readonly charsAfter: number
}

/** Compiles config-backed matchers and owns arm state for one plugin fiber. */
class ArmAState {
  private excludeSource: readonly string[] | undefined
  private excludeToolRe: RegExp[] = []
  private protectSource: readonly string[] | undefined
  private protectPathRe: RegExp[] = []
  private readonly attempts = new Map<string, true>()
  private inflight = 0

  constructor(private readonly getConfig: () => ResolvedConfig) {}

  /**
   * Re-glob the config-backed matchers when a new resolution replaced the
   * arrays (resolveConfig freezes a fresh array per call, so identity change
   * marks a config edit; hot card/settings edits take effect on the next
   * candidate exactly like arm B).
   */
  refresh(cfg: ResolvedConfig): void {
    if (cfg.excludeTools !== this.excludeSource) {
      this.excludeSource = cfg.excludeTools
      this.excludeToolRe = compileGlobs(cfg.excludeTools)
    }
    if (cfg.protectPathGlobs !== this.protectSource) {
      this.protectSource = cfg.protectPathGlobs
      this.protectPathRe = compileGlobs(cfg.protectPathGlobs)
    }
  }

  get excludeToolReList(): readonly RegExp[] { return this.excludeToolRe }
  get protectPathReList(): readonly RegExp[] { return this.protectPathRe }

  /** Mark-and-check one callId: true on first sight, false afterwards. */
  firstAttempt(callId: string): boolean {
    if (this.attempts.has(callId)) return false
    if (this.attempts.size >= ATTEMPT_LRU_MAX) {
      const oldest = this.attempts.keys().next().value
      if (oldest !== undefined) this.attempts.delete(oldest)
    }
    this.attempts.set(callId, true)
    return true
  }

  /**
   * Run fn under one inflight slot.
   * @returns fn result, or undefined when every slot was busy.
   */
  async withSlot<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (this.inflight >= this.getConfig().maxInflight) return undefined
    this.inflight++
    try {
      return await fn()
    } finally {
      this.inflight--
    }
  }
}

/** Deferred-tool unwrap mirrors giter00-style tool_call bridging. */
function effectiveToolName(exec: ToolExecution): string {
  const args = exec.arguments as Record<string, unknown> | unknown
  if (exec.name === 'tool_call' && args !== null && typeof args === 'object') {
    const nested = args as Record<string, unknown>
    if (typeof nested.name === 'string' && nested.name.length > 0) return nested.name
  }
  return exec.name ?? ''
}

/**
 * One compression attempt against a gate-passing candidate.
 * @returns the adopted replacement descriptor, or a short keep-reason string.
 */
async function attemptCompress(
  ctx: Context,
  cfg: ResolvedConfig,
  state: ArmAState,
  store: CcrStore,
  client: HeadroomClient,
  counters: BridgeCounters,
  toolName: string,
  callId: string,
  sessionId: string,
  model: string,
  text: string,
): Promise<ArmOutcome | string> {
  const raw = await state.withSlot(() =>
    client.compressToolMessage({
      toolCallId: callId,
      text,
      model,
      timeoutMs: cfg.timeoutMs,
    }),
  )
  if (raw === undefined) return 'inflight-cap'
  const compressed = compressedContentOf(raw)
  if (compressed === undefined) return 'empty-response'

  const originalChars = codePointLength(text)
  const compressedChars = codePointLength(compressed)
  const tokenRatio = raw.tokens_before > 0
    ? (raw.tokens_before - raw.tokens_after) / raw.tokens_before
    : 0
  const charRatio = originalChars > 0 ? 1 - compressedChars / originalChars : 0
  const savings = Math.max(tokenRatio, charRatio)
  const profitable = savings >= cfg.minSavingsRatio && compressedChars < originalChars
  const chain = Array.isArray(raw.transforms_applied) ? raw.transforms_applied.join('>') : ''
  const pct = Math.round(savings * 100)
  const statsLine = 'chars ' + originalChars + '->' + compressedChars + ' (-' + pct + '%)' +
    ' strategy=' + (chain.length > 0 ? chain : 'none') +
    ' proxyCcr=' + (Array.isArray(raw.ccr_hashes) ? raw.ccr_hashes.length : 0)

  if (!profitable || cfg.mode === 'audit') {
    ctx.logger.info(LOG_TAG + ': [audit] ' + toolName + ' ' + statsLine +
      ' mode=' + cfg.mode + ' profitable=' + (profitable ? 'yes' : 'no'))
    return 'not-adopted'
  }

  assertReplacementSmaller(originalChars, compressedChars)
  const hash = contentHash(text)
  store.put({
    hash,
    toolName,
    callId,
    sessionId,
    strategy: chain,
    charsBefore: originalChars,
    charsAfter: compressedChars,
    originalText: text,
  })
  assertRetrievable(store.get(hash) !== undefined, hash)
  counters.savedChars += originalChars - compressedChars
  counters.adopted++
  ctx.logger.info(LOG_TAG + ': [live] ' + toolName + ' ' + statsLine + ' hash=' + hash)
  return {
    replacementText: appendMarker(compressed, renderMarker(hash, originalChars, compressedChars)),
    hash,
    charsBefore: originalChars,
    charsAfter: compressedChars,
  }
}

/**
 * Install the arm-A waterfall listener on one context.
 * @returns a disposer; Cordis also unwinds listeners on fiber disposal.
 */
export function installArmA(
  ctx: Context,
  getConfig: () => ResolvedConfig,
  store: CcrStore,
  getClient: () => HeadroomClient,
  counters: BridgeCounters,
): () => void {
  const state = new ArmAState(getConfig)

  const off = ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      const cfg = getConfig()
      state.refresh(cfg)
      if (decision.kind !== 'accept') return decision

      const toolName = effectiveToolName(exec)
      // value accepts carry rendered content only; compress that, keep canonical value
      const sourceBlocks = decision.content ?? result.content
      if (sourceBlocks === undefined || (Array.isArray(sourceBlocks) && sourceBlocks.length === 0)) return decision
      let text: string | undefined = flattenPlainText(sourceBlocks)
      const skip = evaluateGates({
        enabled: true,
        toolName,
        isError: result.isError,
        protectErrorOutputs: cfg.protectErrorOutputs,
        text,
        minChars: cfg.minChars,
        excludeToolRe: state.excludeToolReList,
        protectPathRe: state.protectPathReList,
        args: exec.arguments,
      })
      if (skip !== null) {
        if (OWN_TOOL_NAMES.has(toolName) || skip === 'already-compressed') {
          ctx.logger.debug(LOG_TAG + ': skip(' + skip + ') ' + toolName)
        }
        return decision
      }
      if (!state.firstAttempt(exec.callId)) return decision
      counters.attempts++
      if (text === undefined) return decision // unreachable past gates; narrows below

      const model = exec.agent?.options.model ?? 'deepseek-chat'
      const outcome = await attemptCompress(
        ctx, cfg, state, store, getClient(), counters,
        toolName, exec.callId, String(exec.agent?.id ?? ''), model, text,
      )
      if (typeof outcome === 'string') {
        if (outcome === 'inflight-cap') counters.failures++
        return decision
      }
      return {
        kind: 'accept' as const,
        content: [{ type: 'text', text: outcome.replacementText }],
        ...(decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {}),
      }
    } catch (error: unknown) {
      counters.failures++
      ctx.logger.warn(LOG_TAG + ': compression skipped (' + String(error) + ')')
      return decision
    }
  })

  return () => { off() }
}