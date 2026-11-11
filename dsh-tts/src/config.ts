import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { ErrorCode, TtsError } from './errors.ts'

/** Voice Edge-TTS uses when neither config nor the call specifies one. */
export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'

/** Rate Edge-TTS uses when the call omits one. */
export const DEFAULT_RATE = '+0%'

/** Per-synthesis subprocess deadline. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** CLI name resolved through PATH unless overridden. */
export const DEFAULT_EDGE_TTS_BINARY = 'edge-tts'

/** Subdirectory of `DSH_HOME` that owns every generated audio file. */
export const OUTPUT_SUBDIR = 'tts-output'

/**
 * Config schema exposed to the DSH configuration layer. Defaults live here (not
 * in call sites) so the settings surface and runtime behaviour agree.
 */
export const Config = z.object({
  outputDir: z.string(),
  defaultVoice: z.string().default(DEFAULT_VOICE),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  edgeTtsBinary: z.string().default(DEFAULT_EDGE_TTS_BINARY),
})

/** Config accepted by {@link apply}; every field is optional and defaulted. */
export interface TtsConfig {
  outputDir?: string
  defaultVoice?: string
  timeoutMs?: number
  edgeTtsBinary?: string
}

/** Effective, path-resolved plugin settings. */
export interface ResolvedConfig {
  /** Harness home from `DSH_HOME`; empty when unset. */
  dshHome: string
  /** Absolute output root; empty when neither `outputDir` nor `DSH_HOME` is available. */
  outputDir: string
  defaultVoice: string
  timeoutMs: number
  edgeTtsBinary: string
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Resolve config defaults without touching the filesystem. A missing
 * `DSH_HOME` is not fatal here: explicit `outputDir` still works, and the
 * self-check needs to report the missing value instead of failing to load.
 */
export function resolveConfig(
  raw?: Partial<TtsConfig>,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const dshHome = nonEmpty(env.DSH_HOME) ?? ''
  const configuredDir = nonEmpty(raw?.outputDir)
  const outputDir = configuredDir
    ? resolve(configuredDir)
    : dshHome
      ? resolve(dshHome, OUTPUT_SUBDIR)
      : ''

  return {
    dshHome,
    outputDir,
    defaultVoice: nonEmpty(raw?.defaultVoice) ?? DEFAULT_VOICE,
    timeoutMs: raw?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    edgeTtsBinary: nonEmpty(raw?.edgeTtsBinary) ?? DEFAULT_EDGE_TTS_BINARY,
  }
}

/**
 * Validate the settings a synthesis actually needs. Kept separate from
 * {@link resolveConfig} so loading the plugin never fails at mount time.
 */
export function requireSynthesisConfig(config: ResolvedConfig): {
  outputDir: string
  timeoutMs: number
} {
  if (!config.outputDir) {
    throw new TtsError(
      ErrorCode.DshHomeNotSet,
      'No output directory is available: DSH_HOME is not set and `outputDir` is not configured.',
      'Set DSH_HOME in the DSH runtime, or set the plugin config field `outputDir`.',
    )
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new TtsError(
      ErrorCode.InvalidConfig,
      `Invalid config: timeoutMs must be a positive number, got ${JSON.stringify(config.timeoutMs)}.`,
      'Set `timeoutMs` to a positive millisecond value (default 30000).',
    )
  }
  return { outputDir: config.outputDir, timeoutMs: config.timeoutMs }
}
