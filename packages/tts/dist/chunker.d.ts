/**
 * Pure text chunking for long synthesis requests.
 *
 * Splitting happens on code points, so a surrogate pair is never cut in half,
 * and the cut point prefers sentence punctuation, then newlines, then softer
 * separators such as commas and spaces. The module has no I/O and no
 * subprocess dependency, which keeps it directly testable.
 */
/** Target characters per chunk; also the one-shot threshold. */
export declare const DEFAULT_CHUNK_SIZE = 1200;
/** Count Unicode code points rather than UTF-16 code units. */
export declare function countCharacters(text: string): number;
/**
 * Split `text` into chunks of at most `chunkSize` characters, cutting at the
 * latest sentence boundary in each window when one exists. Whitespace at a
 * chunk edge is trimmed; otherwise every character is preserved.
 */
export declare function splitText(text: string, chunkSize?: number): string[];
//# sourceMappingURL=chunker.d.ts.map