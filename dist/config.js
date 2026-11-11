import { resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { ErrorCode, TtsError } from "./errors.js";
/** Voice Edge-TTS uses when neither config nor the call specifies one. */
export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
/** Rate Edge-TTS uses when the call omits one. */
export const DEFAULT_RATE = '+0%';
/** Per-synthesis subprocess deadline. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** CLI name resolved through PATH unless overridden. */
export const DEFAULT_EDGE_TTS_BINARY = 'edge-tts';
/** Subdirectory of `DSH_HOME` that owns every generated audio file. */
export const OUTPUT_SUBDIR = 'tts-output';
/** Target characters per chunk, and the one-shot threshold. */
export const DEFAULT_CHUNK_SIZE = 1_200;
/** Long texts are chunked by default. */
export const DEFAULT_CHUNKING_ENABLED = true;
/** Engines the fallback chain understands, in default priority order. */
export const DEFAULT_FALLBACK_ORDER = [
    'edge-tts',
    'sapi',
    'speechSynthesis',
];
/** Fallback is enabled unless configured otherwise. */
export const DEFAULT_FALLBACK_ENABLED = true;
/** Narrow an arbitrary config string to a known engine. */
export function isTtsEngine(value) {
    return DEFAULT_FALLBACK_ORDER.includes(value);
}
/**
 * Config schema exposed to the DSH configuration layer. Defaults live here (not
 * in call sites) so the settings surface and runtime behaviour agree.
 */
export const Config = z.object({
    outputDir: z.string(),
    defaultVoice: z.string().default(DEFAULT_VOICE),
    timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
    edgeTtsBinary: z.string().default(DEFAULT_EDGE_TTS_BINARY),
    chunkSize: z.number().default(DEFAULT_CHUNK_SIZE),
    chunkingEnabled: z.boolean().default(DEFAULT_CHUNKING_ENABLED),
    fallbackEnabled: z.boolean().default(DEFAULT_FALLBACK_ENABLED),
    fallbackOrder: z.array(z.string()).default([...DEFAULT_FALLBACK_ORDER]),
});
function nonEmpty(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
/**
 * Resolve config defaults without touching the filesystem. A missing
 * `DSH_HOME` is not fatal here: explicit `outputDir` still works, and the
 * self-check needs to report the missing value instead of failing to load.
 */
export function resolveConfig(raw, env = process.env) {
    const dshHome = nonEmpty(env.DSH_HOME) ?? '';
    const configuredDir = nonEmpty(raw?.outputDir);
    const outputDir = configuredDir
        ? resolve(configuredDir)
        : dshHome
            ? resolve(dshHome, OUTPUT_SUBDIR)
            : '';
    return {
        dshHome,
        outputDir,
        defaultVoice: nonEmpty(raw?.defaultVoice) ?? DEFAULT_VOICE,
        timeoutMs: raw?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        edgeTtsBinary: nonEmpty(raw?.edgeTtsBinary) ?? DEFAULT_EDGE_TTS_BINARY,
        chunkSize: raw?.chunkSize ?? DEFAULT_CHUNK_SIZE,
        chunkingEnabled: raw?.chunkingEnabled ?? DEFAULT_CHUNKING_ENABLED,
        fallbackEnabled: raw?.fallbackEnabled ?? DEFAULT_FALLBACK_ENABLED,
        fallbackOrder: raw?.fallbackOrder === undefined
            ? [...DEFAULT_FALLBACK_ORDER]
            : raw.fallbackOrder.filter(isTtsEngine),
    };
}
/**
 * Validate the settings a synthesis actually needs. Kept separate from
 * {@link resolveConfig} so loading the plugin never fails at mount time.
 */
export function requireSynthesisConfig(config) {
    if (!config.outputDir) {
        throw new TtsError(ErrorCode.DshHomeNotSet, 'No output directory is available: DSH_HOME is not set and `outputDir` is not configured.', 'Set DSH_HOME in the DSH runtime, or set the plugin config field `outputDir`.');
    }
    if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
        throw new TtsError(ErrorCode.InvalidConfig, `Invalid config: timeoutMs must be a positive number, got ${JSON.stringify(config.timeoutMs)}.`, 'Set `timeoutMs` to a positive millisecond value (default 30000).');
    }
    if (config.chunkingEnabled &&
        (!Number.isInteger(config.chunkSize) || config.chunkSize <= 0)) {
        throw new TtsError(ErrorCode.InvalidConfig, `Invalid config: chunkSize must be a positive integer, got ${JSON.stringify(config.chunkSize)}.`, 'Set `chunkSize` to a positive character count (default 1200), or disable chunking.');
    }
    return {
        outputDir: config.outputDir,
        timeoutMs: config.timeoutMs,
        chunkSize: config.chunkSize,
        chunkingEnabled: config.chunkingEnabled,
        fallbackEnabled: config.fallbackEnabled,
        fallbackOrder: config.fallbackOrder,
    };
}
//# sourceMappingURL=config.js.map