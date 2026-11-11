/**
 * Fallback chain orchestration: Edge-TTS is the primary engine, and on an
 * eligible failure the configured chain is tried in order. SAPI is Windows-only;
 * the browser `speechSynthesis` entry produces a marker instead of a file (the
 * host cannot produce audio without an engine). A chain with no reachable
 * engine ends as `ALL_FALLBACKS_FAILED` listing every engine and reason.
 */
import type { TtsEngine } from './config.ts';
import type { SpawnFunction, SynthesizedAudio } from './edge-tts.ts';
import type { EngineHealthHooks, EngineHealthState } from './engine-health.ts';
import { TtsError } from './errors.ts';
import { type SapiOptions } from './sapi-tts.ts';
/** Whether a failed Edge-TTS attempt is worth retrying with another engine. */
export declare function isFallbackEligible(error: unknown): error is TtsError;
/** One engine that was skipped or failed, with a human-readable reason. */
export interface FallbackAttempt {
    engine: TtsEngine;
    reason: string;
}
/** Reason recorded when the health circuit skips an engine. */
export declare const SKIPPED_BY_HEALTH = "skipped: circuit open (cooldown)";
/** Either a produced file or a request for the client to speak the text. */
export type FallbackOutcome = {
    kind: 'audio';
    audio: SynthesizedAudio;
    engine: TtsEngine;
    /** Health of `engine` just before this attempt succeeded. */
    engineState: EngineHealthState;
    attempts: FallbackAttempt[];
} | {
    kind: 'speechSynthesis';
    engine: 'speechSynthesis';
    attempts: FallbackAttempt[];
};
export interface FallbackOptions {
    text: string;
    rate: string;
    outputDir: string;
    hash: string;
    timeoutMs: number;
    fallbackOrder: readonly TtsEngine[];
    signal?: AbortSignal;
    now?: Date;
    /** Error thrown by the primary Edge-TTS attempt, kept for the final message. */
    primaryError?: unknown;
    /** Why the primary attempt was not made, when its circuit was open. */
    primaryReason?: string;
    /**
     * Engines whose circuit is open. Skipping never reorders the chain; it only
     * removes an engine from this attempt.
     */
    skip?: ReadonlySet<TtsEngine>;
}
/** Injection points; production uses the real Windows/ffmpeg binaries. */
export interface FallbackDependencies {
    platform?: NodeJS.Platform;
    spawnImpl?: SpawnFunction;
    powershellBinary?: string;
    ffmpegBinary?: string;
    synthesizeSapiImpl?: (text: string, options: SapiOptions) => Promise<SynthesizedAudio>;
    /** Health hooks; omitted by direct callers that do not track engines. */
    health?: EngineHealthHooks;
}
/**
 * Run the configured engines after Edge-TTS already failed. `edge-tts` in
 * `fallbackOrder` marks the primary attempt rather than a retry.
 */
export declare function runFallback(options: FallbackOptions, deps?: FallbackDependencies): Promise<FallbackOutcome>;
//# sourceMappingURL=fallback.d.ts.map