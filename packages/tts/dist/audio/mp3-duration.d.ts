/**
 * Pure-JS MP3 timing, so duration and subtitle alignment never depend on
 * ffmpeg or an external probe. Edge-TTS writes `audio-24khz-*` MPEG-2 Layer III
 * (576 samples per frame), but the parser covers MPEG-1/2/2.5 Layer III.
 *
 * Cache metadata and the manifest both promise a `timingQuality`, so a parse
 * failure must be reported as "unknown", never guessed here.
 */
/** Result of a successful frame-level parse. */
export interface Mp3Info {
    /** Total playable duration. */
    durationMs: number;
    /** Frames counted (or declared by a Xing/Info header). */
    frames: number;
    sampleRate: number;
}
/**
 * Measure an MP3 buffer by walking its frames. Returns undefined for anything
 * that is not a Layer III stream this parser understands, so callers can fall
 * back to an explicit "estimated" timing quality instead of silently lying.
 */
export declare function measureMp3(buffer: Buffer): Mp3Info | undefined;
//# sourceMappingURL=mp3-duration.d.ts.map