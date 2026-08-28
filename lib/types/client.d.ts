/**
 * Minimal HTTP client for a local Headroom compression proxy.
 *
 * Wire contract matches the official headroom-ai SDK surface this integration
 * depends on: POST /v1/compress, POST /v1/retrieve, GET /health. Failures
 * throw; callers decide fail-open behavior per site.
 * @module
 */
/** Subset of /v1/compress responses consumed by the bridge. */
export interface CompressResponse {
    messages: Array<{
        role?: unknown;
        content?: unknown;
    }>;
    tokens_before: number;
    tokens_after: number;
    compression_ratio?: number;
    transforms_applied?: string[];
    ccr_hashes?: string[];
}
/** Extract the first message's textual content when shaped correctly. */
export declare function compressedContentOf(response: CompressResponse): string | undefined;
/** Proxy identity fields reported alongside any retrieval result. */
export interface RetrieveResponse {
    original_content?: unknown;
}
/** Thin fetch-based proxy adapter with hard timeouts. */
export declare class HeadroomClient {
    readonly baseUrl: string;
    private timeoutMs;
    constructor(baseUrl: string, timeoutMs?: number);
    private request;
    /** Whether /health answers OK right now. */
    health(timeoutMs?: number): Promise<boolean>;
    /**
     * Compress one OpenAI-style tool message under CCR mode.
     * @throws Error describing status/body on any non-2xx or transport failure.
     */
    compressToolMessage(input: {
        toolCallId: string;
        text: string;
        model: string;
        timeoutMs?: number;
    }): Promise<CompressResponse>;
    /**
     * Retrieve one original from the proxy CCR store by hash.
     * @throws Error describing status/body on transport failure or miss detail.
     */
    retrieveHash(hash: string): Promise<RetrieveResponse>;
}
