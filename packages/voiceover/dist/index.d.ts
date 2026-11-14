/**
 * DSH entry point: config, tools, and the two host adapters (model + engine).
 *
 * The heavy lifting lives in `pipeline.ts`, which knows nothing about cordis.
 * This file is the only place that touches the host, so the pipeline stays
 * testable without a running DSH.
 */
import type { Context } from '@deepseek-ai/cordis';
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { type StyleProfile } from './pipeline.ts';
export declare const name = "dsh-voiceover";
/** The tool registry must exist before `apply` runs. */
export declare const inject: string[];
/** Config schema exposed to the DSH settings layer. */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    outputDir: z<string, string, "plain">;
    defaultVoice: z<string, string, "defined">;
    defaultRate: z<string, string, "defined">;
    style: z<"lecture" | "news" | "story" | "docs", "lecture" | "news" | "story" | "docs", "defined">;
    auditSample: z<number, number, "defined">;
    llmBaseUrl: z<string, string, "plain">;
    llmApiKey: z<string, string, "plain">;
    llmModel: z<string, string, "defined">;
    trustedHosts: z<string[], string[], "plain">;
    chapterChars: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    outputDir: z<string, string, "plain">;
    defaultVoice: z<string, string, "defined">;
    defaultRate: z<string, string, "defined">;
    style: z<"lecture" | "news" | "story" | "docs", "lecture" | "news" | "story" | "docs", "defined">;
    auditSample: z<number, number, "defined">;
    llmBaseUrl: z<string, string, "plain">;
    llmApiKey: z<string, string, "plain">;
    llmModel: z<string, string, "defined">;
    trustedHosts: z<string[], string[], "plain">;
    chapterChars: z<number, number, "defined">;
}>>, "plain">;
/** Config accepted by {@link apply}. */
export interface VoiceoverConfig {
    outputDir?: string;
    defaultVoice?: string;
    defaultRate?: string;
    style?: StyleProfile;
    auditSample?: number;
    llmBaseUrl?: string;
    llmApiKey?: string;
    llmModel?: string;
    /** Extra Host names accepted by the audio route (reverse proxies). */
    trustedHosts?: string[];
    /** Target characters per chapter when planning without a model. */
    chapterChars?: number;
}
/** Tool definitions; separated so tests can inspect them without a host. */
export declare function createVoiceoverTools(ctx: Context, config: VoiceoverConfig, env?: NodeJS.ProcessEnv): ToolDefinition[];
/** Route prefix for per-chapter audio; distinct from the engine's own prefix. */
export declare const VOICEOVER_AUDIO_PREFIX = "/voiceover/audio";
/** Mount the tools. Registration is fiber-owned, so unloading cleans up. */
export declare function apply(ctx: Context, config?: VoiceoverConfig): void;
//# sourceMappingURL=index.d.ts.map