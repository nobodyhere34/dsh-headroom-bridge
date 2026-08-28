/** Cross-arm cumulative counters surfaced through headroom_stats. @module */

/** Mutable counters handed to arms at registration time. */
export interface BridgeCounters {
  /** Gate-passing attempts (proxy called once per callId). */
  attempts: number
  /** Proxy answers that failed gates or transport (fail-open keeps original). */
  failures: number
  /** Adopted replacements (live mode). */
  adopted: number
  /** Unicode chars removed from model-visible content by adoptions. */
  savedChars: number
}

/** Fresh counter bundle. */
export function newCounters(): BridgeCounters {
  return { attempts: 0, failures: 0, adopted: 0, savedChars: 0 }
}
