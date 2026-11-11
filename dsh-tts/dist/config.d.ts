import z from '@deepseek-ai/schemastery';
/** Voice Edge-TTS uses when neither config nor the call specifies one. */
export declare const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";
/** Rate Edge-TTS uses when the call omits one. */
export declare const DEFAULT_RATE = "+0%";
/** Per-synthesis subprocess deadline. */
export declare const DEFAULT_TIMEOUT_MS = 30000;
/** CLI name resolved through PATH unless overridden. */
export declare const DEFAULT_EDGE_TTS_BINARY = "edge-tts";
/** Subdirectory of `DSH_HOME` that owns every generated audio file. */
export declare const OUTPUT_SUBDIR = "tts-output";
/**
 * Config schema exposed to the DSH configuration layer. Defaults live here (not
 * in call sites) so the settings surface and runtime behaviour agree.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    outputDir: z<string, string, "plain">;
    defaultVoice: z<string, string, "defined">;
    timeoutMs: z<number, number, "defined">;
    edgeTtsBinary: z<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    outputDir: z<string, string, "plain">;
    defaultVoice: z<string, string, "defined">;
    timeoutMs: z<number, number, "defined">;
    edgeTtsBinary: z<string, string, "defined">;
}>>, "plain">;
/** Config accepted by {@link apply}; every field is optional and defaulted. */
export interface TtsConfig {
    outputDir?: string;
    defaultVoice?: string;
    timeoutMs?: number;
    edgeTtsBinary?: string;
}
/** Effective, path-resolved plugin settings. */
export interface ResolvedConfig {
    /** Harness home from `DSH_HOME`; empty when unset. */
    dshHome: string;
    /** Absolute output root; empty when neither `outputDir` nor `DSH_HOME` is available. */
    outputDir: string;
    defaultVoice: string;
    timeoutMs: number;
    edgeTtsBinary: string;
}
/**
 * Resolve config defaults without touching the filesystem. A missing
 * `DSH_HOME` is not fatal here: explicit `outputDir` still works, and the
 * self-check needs to report the missing value instead of failing to load.
 */
export declare function resolveConfig(raw?: Partial<TtsConfig>, env?: NodeJS.ProcessEnv): ResolvedConfig;
/**
 * Validate the settings a synthesis actually needs. Kept separate from
 * {@link resolveConfig} so loading the plugin never fails at mount time.
 */
export declare function requireSynthesisConfig(config: ResolvedConfig): {
    outputDir: string;
    timeoutMs: number;
};
//# sourceMappingURL=config.d.ts.map