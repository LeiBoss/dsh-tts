import { type SpawnFunction } from './edge-tts.ts';
export declare const DEFAULT_POWERSHELL_BINARY = "powershell.exe";
export declare const DEFAULT_FFMPEG_BINARY = "ffmpeg";
export interface SapiOptions {
    /** Edge-style rate such as `+0%`; mapped onto SAPI's -10..10 scale. */
    rate: string;
    outputDir: string;
    hash: string;
    timeoutMs: number;
    signal?: AbortSignal;
    spawnImpl?: SpawnFunction;
    now?: Date;
    platform?: NodeJS.Platform;
    powershellBinary?: string;
    ffmpegBinary?: string;
}
/** SAPI only exists on Windows; every other platform skips this engine. */
export declare function isSapiSupported(platform?: NodeJS.Platform): boolean;
/** Map `+25%` / `-10%` onto SAPI's integer -10..10 rate scale. */
export declare function sapiRate(rate: string): number;
/**
 * Synthesize `text` with the system voice. Produces the same dated `.mp3` cache
 * path as Edge-TTS, so a successful fallback is cached like any other result.
 */
export declare function synthesizeSapi(text: string, options: SapiOptions): Promise<{
    filePath: string;
    format: string;
}>;
//# sourceMappingURL=sapi-tts.d.ts.map