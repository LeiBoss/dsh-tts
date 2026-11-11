/**
 * DSH tool plugin: text in, a durable audio file out.
 *
 * The plugin owns exactly one capability — Edge-TTS synthesis into
 * `$DSH_HOME/tts-output` — and exposes it through `tts_generate` plus a
 * side-effect-free `tts_self_check`. It deliberately implements no playback,
 * transcription, voice cloning, or multi-provider routing.
 */
import type { Context } from '@deepseek-ai/cordis';
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { type AudioUrlProvider } from './audio-route.ts';
import { type ResolvedConfig, type TtsConfig } from './config.ts';
import { type SpawnFunction, type SynthesizedAudio } from './edge-tts.ts';
import type { SapiOptions } from './sapi-tts.ts';
export { Config } from './config.ts';
export type { TtsConfig } from './config.ts';
export { ErrorCode, TtsError } from './errors.ts';
export { cacheKey, findCachedFile } from './cache.ts';
export { runProcess, synthesize } from './edge-tts.ts';
export { selfCheck } from './self-check.ts';
export { AUDIO_ROUTE_PREFIX, AudioRoute } from './audio-route.ts';
export { DEFAULT_CHUNK_SIZE, splitText } from './chunker.ts';
export { synthesizeChunked } from './chunked-tts.ts';
export { isFallbackEligible, runFallback } from './fallback.ts';
export { isSapiSupported, sapiRate, synthesizeSapi } from './sapi-tts.ts';
export declare const name = "dsh-tts";
/** The registry must exist before `apply` runs. */
export declare const inject: string[];
/** Injection points used by tests; production always uses the defaults. */
export interface TtsDependencies {
    spawnImpl?: SpawnFunction;
    now?: () => Date;
    /** Present when a web route was registered; enables `browserUrl`. */
    audioRoute?: AudioUrlProvider;
    /** Override the pause between chunk subprocesses (tests use 0). */
    chunkDelayMs?: number;
    /** Platform override, so non-Windows tests can exercise the SAPI branch. */
    platform?: NodeJS.Platform;
    /** Injected SAPI implementation; defaults to the real PowerShell path. */
    sapiSynthesize?: (text: string, options: SapiOptions) => Promise<SynthesizedAudio>;
    powershellBinary?: string;
    ffmpegBinary?: string;
}
/**
 * Build both tool definitions from one resolved config. Exported so tests can
 * exercise the real `execute` bodies with an injected spawn implementation.
 */
export declare function createTtsTools(config: ResolvedConfig, deps?: TtsDependencies): ToolDefinition[];
/**
 * Mount both tools. Registration is fiber-owned, so unloading the plugin
 * unregisters them without explicit cleanup.
 */
export declare function apply(ctx: Context, config?: Partial<TtsConfig>): void;
//# sourceMappingURL=index.d.ts.map