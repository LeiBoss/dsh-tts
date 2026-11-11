import { type SpawnFunction, type SynthesizedAudio } from './edge-tts.ts';
/** Pause between chunk subprocesses so Edge-TTS is not rate-limited. */
export declare const DEFAULT_INTER_CHUNK_DELAY_MS = 200;
export interface ChunkedSynthesisOptions {
    voice: string;
    rate: string;
    binary: string;
    outputDir: string;
    /** Cache key of the full original text. */
    hash: string;
    timeoutMs: number;
    chunkSize: number;
    signal?: AbortSignal;
    spawnImpl?: SpawnFunction;
    now?: Date;
    /** Injectable sleep, used by tests to avoid real delays. */
    delay?: (ms: number) => Promise<void>;
    interChunkDelayMs?: number;
}
/**
 * Synthesize `text` chunk by chunk and return one concatenated MP3. Callers
 * only use this above the chunk threshold; calling it with one chunk simply
 * delegates to the one-shot path.
 */
export declare function synthesizeChunked(text: string, options: ChunkedSynthesisOptions): Promise<SynthesizedAudio>;
//# sourceMappingURL=chunked-tts.d.ts.map