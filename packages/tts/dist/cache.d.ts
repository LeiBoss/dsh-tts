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
 * Diagnostic record stored next to a finished MP3. It never participates in
 * cache lookup; it only lets a later cache hit report which engine produced
 * the file (for example `sapi` after a fallback).
 */
export interface CacheMetadata {
    engine: string;
    voice: string;
    rate: string;
    pitch: string;
    volume: string;
    createdAt: string;
    /**
     * Word timings the backend reported. Persisted so a later cache hit keeps
     * exact subtitle timing instead of silently degrading to an estimate.
     */
    words?: {
        text: string;
        offsetMs: number;
        durationMs: number;
    }[];
}
/** Sidecar path for one audio file. */
export declare function metadataPath(filePath: string): string;
/** Best-effort metadata write; diagnostics must never fail synthesis. */
export declare function writeCacheMetadata(filePath: string, metadata: CacheMetadata): Promise<void>;
/** Read a sidecar, treating missing, unreadable, or malformed data as absent. */
export declare function readCacheMetadata(filePath: string): Promise<CacheMetadata | undefined>;
/**
 * Find an existing non-empty file for `hash`, newest date bucket first. Only
 * files carrying the exact key prefix and a positive size qualify, so a
 * partial or unrelated file never satisfies the cache. The `.mp3.json`
 * sidecars and the `.audio-route-secret` file never match this filter.
 */
export declare function findCachedFile(outputDir: string, hash: string): Promise<string | undefined>;
//# sourceMappingURL=cache.d.ts.map