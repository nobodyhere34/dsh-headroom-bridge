/** Retrieval-marker rendering and already-compressed detection. @module */
/** Leading bracket form scanners key on. */
export declare const MARKER_PREFIX: string;
/**
 * Render the marker line appended after compressed content.
 * @param hash - local CCR hash resolving to the full original text.
 * @param charsBefore - original Unicode character count.
 * @param charsAfter - compressed Unicode character count.
 */
export declare function renderMarker(hash: string, charsBefore: number, charsAfter: number): string;
/** Join compressed text and its marker with one blank separator line. */
export declare function appendMarker(compressed: string, marker: string): string;
/** Any headroom CCR marker form: bridge own, row-drop sentinel, prose markers. */
export declare const ALREADY_COMPRESSED_RE: RegExp;
/** Whether text already carries a compression marker (never recompress). */
export declare function isAlreadyCompressed(text: string): boolean;
