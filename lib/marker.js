/** Retrieval-marker rendering and already-compressed detection. @module */
import { LOG_TAG } from './config.js';
/** Leading bracket form scanners key on. */
export const MARKER_PREFIX = '[' + LOG_TAG + ':';
/**
 * Render the marker line appended after compressed content.
 * @param hash - local CCR hash resolving to the full original text.
 * @param charsBefore - original Unicode character count.
 * @param charsAfter - compressed Unicode character count.
 */
export function renderMarker(hash, charsBefore, charsAfter) {
    return MARKER_PREFIX + ' ' + charsBefore + '->' + charsAfter +
        ' chars offloaded. Retrieve the exact original with headroom_retrieve hash=' + hash + ']';
}
/** Join compressed text and its marker with one blank separator line. */
export function appendMarker(compressed, marker) {
    return compressed.endsWith('\n') ? compressed + '\n' + marker : compressed + '\n\n' + marker;
}
/** Any headroom CCR marker form: bridge own, row-drop sentinel, prose markers. */
export const ALREADY_COMPRESSED_RE = /\[headroom-bridge:|<<ccr:[0-9a-f]{6,}|Retrieve (?:more|original): hash=/i;
/** Whether text already carries a compression marker (never recompress). */
export function isAlreadyCompressed(text) {
    return ALREADY_COMPRESSED_RE.test(text);
}
//# sourceMappingURL=marker.js.map