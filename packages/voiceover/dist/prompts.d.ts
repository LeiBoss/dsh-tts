/**
 * Prompt builders. One function per stage, each returning the exact strings the
 * model receives. The text is versioned by `PROMPT_VERSION` in `types.ts`:
 * bumping it invalidates the outline/script cache on purpose.
 *
 * Rules that matter and are easy to lose in a refactor:
 * - every prompt demands JSON only (no fences, no prose);
 * - the model never sees the whole book at once (block -> outline -> chapter);
 * - neighboring summaries are injected so cross-chapter references survive.
 */
import type { Outline } from './types.ts';
/** One prompt pair. */
export interface Prompt {
    system: string;
    user: string;
}
/** Stage P0a: find chapter boundaries inside one text block. */
export declare function chunkPrompt(input: {
    docTitle: string;
    blockId: string;
    blockIndex: number;
    blockTotal: number;
    startParagraph: number;
    blockText: string;
}): Prompt;
/** Stage P0b: merge block results into one coverage-complete outline. */
export declare function outlinePrompt(input: {
    docTitle: string;
    paragraphTotal: number;
    charTotal: number;
    blocks: unknown;
}): Prompt;
/** Stage P1: turn written prose into a spoken script without changing facts. */
export declare function adaptPrompt(input: {
    docTitle: string;
    chapterNo: number;
    chapterTotal: number;
    chapterTitle: string;
    prevSummary: string;
    nextSummary: string;
    style: string;
    text: string;
}): Prompt;
/** Stage P3: split the script into subtitle units (timing is computed later). */
export declare function subtitlePrompt(script: string): Prompt;
/** Stage P4: audit information fidelity, not style. */
export declare function auditPrompt(input: {
    source: string;
    script: string;
}): Prompt;
/** Stage P6: repair a structurally invalid JSON response without rewriting it. */
export declare function repairPrompt(input: {
    error: string;
    previous: string;
}): Prompt;
/** Coverage assertion used after planning; exported so tests can reuse it. */
export declare function coverageErrors(outline: Outline, paragraphTotal: number): string[];
//# sourceMappingURL=prompts.d.ts.map