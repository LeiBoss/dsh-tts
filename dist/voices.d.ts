/**
 * Static catalogue of Edge-TTS voices the plugin documents.
 *
 * The list is deliberately offline: `tts_self_check` must not query the
 * network, so it reports this constant instead of Edge-TTS's live catalogue.
 * Synthesis still accepts any voice name Edge-TTS understands; this catalogue
 * is metadata, not a whitelist.
 */
/** One documented voice. */
export interface VoiceInfo {
    name: string;
    gender: 'Female' | 'Male';
    locale: string;
    /** Short human-facing description used by the README. */
    description: string;
}
/** Voices surfaced by `tts_self_check` and documented in the README. */
export declare const VOICES: readonly VoiceInfo[];
/** Voice names only, in catalogue order. */
export declare const AVAILABLE_VOICES: readonly string[];
//# sourceMappingURL=voices.d.ts.map