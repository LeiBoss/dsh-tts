/** Audio container Edge-TTS writes. */
export declare const AUDIO_FORMAT = "mp3";
/**
 * Stable cache key for one synthesis request. The first 16 hex characters of
 * SHA-256 are enough to name a file while keeping names short.
 */
export declare function cacheKey(text: string, voice: string, rate: string): string;
/** Local-calendar `YYYY-MM-DD` bucket for a timestamp. */
export declare function dateDirName(date?: Date): string;
/**
 * Target path for a fresh synthesis: `<outputDir>/<date>/<hash>-<epochMs>.mp3`.
 * The timestamp keeps concurrent first-time syntheses from colliding.
 */
export declare function outputFilePath(outputDir: string, hash: string, date?: Date): string;
/**
 * Find an existing non-empty file for `hash`, newest date bucket first. Only
 * files carrying the exact key prefix and a positive size qualify, so a
 * partial or unrelated file never satisfies the cache.
 */
export declare function findCachedFile(outputDir: string, hash: string): Promise<string | undefined>;
//# sourceMappingURL=cache.d.ts.map