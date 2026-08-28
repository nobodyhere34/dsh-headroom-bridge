/**
 * Minimal HTTP client for a local Headroom compression proxy.
 *
 * Wire contract matches the official headroom-ai SDK surface this integration
 * depends on: POST /v1/compress, POST /v1/retrieve, GET /health. Failures
 * throw; callers decide fail-open behavior per site.
 * @module
 */

import { LOG_TAG } from './config.js'

/** Subset of /v1/compress responses consumed by the bridge. */
export interface CompressResponse {
  messages: Array<{ role?: unknown; content?: unknown }>
  tokens_before: number
  tokens_after: number
  compression_ratio?: number
  transforms_applied?: string[]
  ccr_hashes?: string[]
}

/** Extract the first message's textual content when shaped correctly. */
export function compressedContentOf(response: CompressResponse): string | undefined {
  const first = response.messages[0]
  if (first === null || typeof first !== 'object') return undefined
  const content = (first as Record<string, unknown>).content
  return typeof content === 'string' && content.trim().length > 0 ? content : undefined
}

/** Proxy identity fields reported alongside any retrieval result. */
export interface RetrieveResponse {
  original_content?: unknown
}

/** Thin fetch-based proxy adapter with hard timeouts. */
export class HeadroomClient {
  constructor(readonly baseUrl: string, private timeoutMs = 30_000) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(this.baseUrl + path, { ...init, signal: AbortSignal.timeout(this.timeoutMs) })
  }

  /** Whether /health answers OK right now. */
  async health(timeoutMs = 2_000): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl + '/health', { signal: AbortSignal.timeout(timeoutMs) })
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * Compress one OpenAI-style tool message under CCR mode.
   * @throws Error describing status/body on any non-2xx or transport failure.
   */
  async compressToolMessage(input: {
    toolCallId: string
    text: string
    model: string
    timeoutMs?: number
  }): Promise<CompressResponse> {
    const body = JSON.stringify({
      messages: [{ role: 'tool', tool_call_id: input.toolCallId, content: input.text }],
      model: input.model,
      config: { mode: 'ccr' },
    })
    const previous = this.timeoutMs
    if (input.timeoutMs !== undefined) this.timeoutMs = input.timeoutMs
    try {
      const res = await this.request('/v1/compress', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(LOG_TAG + ': /v1/compress failed HTTP ' + res.status + ' ' + detail.slice(0, 200))
      }
      return await res.json() as CompressResponse
    } finally {
      this.timeoutMs = previous
    }
  }

  /**
   * Retrieve one original from the proxy CCR store by hash.
   * @throws Error describing status/body on transport failure or miss detail.
   */
  async retrieveHash(hash: string): Promise<RetrieveResponse> {
    const res = await this.request('/v1/retrieve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error('/v1/retrieve HTTP ' + res.status + ' ' + detail.slice(0, 160))
    }
    return await res.json() as RetrieveResponse
  }
}
