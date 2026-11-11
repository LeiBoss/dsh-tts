/**
 * Subtitle construction: unit splitting (rule-based fallback when the model is
 * unavailable), timing alignment (word boundaries when available, proportional
 * otherwise), and SRT serialization.
 *
 * Two invariants the rest of the system relies on:
 * - units are screen-sized (<= 2 lines of <= 18 chars), not sentence-sized;
 * - timing is monotonic, clamped to the audio, and never claims `exact` unless
 *   word offsets were actually available.
 */
import type { WordTiming } from './types.ts';
/** One subtitle screen. `\n` separates the two allowed lines. */
export interface SubtitleUnit {
    text: string;
}
/** A unit with resolved timing. */
export interface TimedUnit {
    text: string;
    startMs: number;
    endMs: number;
}
/** Minimum time a screen stays visible. */
export declare const MIN_UNIT_MS = 800;
/** Gap between consecutive screens. */
export declare const MIN_GAP_MS = 50;
/** Characters per line before wrapping. */
export declare const MAX_LINE_CHARS = 18;
/** Characters per screen across both lines. */
export declare const MAX_UNIT_CHARS: number;
/** Count characters that carry timing weight (letters, digits, CJK). */
export declare function spokenLength(text: string): number;
/**
 * Rule-based splitter used when no model is available. It is deliberately
 * conservative: a sentence that fits becomes one screen, otherwise it is split
 * at commas, and finally hard-split at the character limit.
 */
export declare function splitUnitsFallback(text: string): SubtitleUnit[];
/**
 * Assign start/end to every unit. With word timings the result is `exact`;
 * without them it is proportional to spoken length and must be labelled
 * `estimated` by the caller.
 */
export declare function alignUnits(units: readonly SubtitleUnit[], durationMs: number, words?: readonly WordTiming[]): {
    units: TimedUnit[];
    quality: 'exact' | 'estimated';
};
/** Render an SRT document (1-based indices, blank line after each cue). */
export declare function formatSrt(units: readonly TimedUnit[]): string;
//# sourceMappingURL=subtitle.d.ts.map