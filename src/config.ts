import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_ENGINE_HEALTH,
  type EngineHealthConfig,
} from './engine-health.ts'
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

/** Target characters per chunk, and the one-shot threshold. */
export const DEFAULT_CHUNK_SIZE = 1_200

/** Long texts are chunked by default. */
export const DEFAULT_CHUNKING_ENABLED = true

/** Engines the fallback chain understands, in default priority order. */
export const DEFAULT_FALLBACK_ORDER = [
  'edge-tts',
  'sapi',
  'speechSynthesis',
] as const

/** Fallback is enabled unless configured otherwise. */
export const DEFAULT_FALLBACK_ENABLED = true

/** Syntheses allowed to run at the same time. */
export const DEFAULT_MAX_CONCURRENT = 2

/** Callers allowed to wait for a synthesis slot. */
export const DEFAULT_QUEUE_SIZE = 4

/** How long a caller may wait for a slot before TTS_BUSY. */
export const DEFAULT_QUEUE_TIMEOUT_MS = 10_000

/** Upper bound for one complete `tts_generate` call, across all chunks. */
export const DEFAULT_TOTAL_TIMEOUT_MS = 180_000

/** Extra Host names accepted by the audio route (reverse proxies). */
export const DEFAULT_TRUSTED_HOSTS: readonly string[] = []

/** One engine in the fallback chain. */
export type TtsEngine = (typeof DEFAULT_FALLBACK_ORDER)[number]

/** Narrow an arbitrary config string to a known engine. */
export function isTtsEngine(value: string): value is TtsEngine {
  return (DEFAULT_FALLBACK_ORDER as readonly string[]).includes(value)
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
  maxConcurrent: z.number().default(DEFAULT_MAX_CONCURRENT),
  queueSize: z.number().default(DEFAULT_QUEUE_SIZE),
  queueTimeoutMs: z.number().default(DEFAULT_QUEUE_TIMEOUT_MS),
  totalTimeoutMs: z.number().default(DEFAULT_TOTAL_TIMEOUT_MS),
  trustedHosts: z.array(z.string()).default([...DEFAULT_TRUSTED_HOSTS]),
  proxy: z.string(),
  engineHealth: z
    .object({
      enabled: z.boolean().default(DEFAULT_ENGINE_HEALTH.enabled),
      failureThreshold: z
        .number()
        .default(DEFAULT_ENGINE_HEALTH.failureThreshold),
      driftCooldownMs: z.number().default(DEFAULT_ENGINE_HEALTH.driftCooldownMs),
      transientCooldownMs: z
        .number()
        .default(DEFAULT_ENGINE_HEALTH.transientCooldownMs),
      maxCooldownMs: z.number().default(DEFAULT_ENGINE_HEALTH.maxCooldownMs),
    })
    .default({ ...DEFAULT_ENGINE_HEALTH }),
})

/** Config accepted by {@link apply}; every field is optional and defaulted. */
export interface TtsConfig {
  outputDir?: string
  defaultVoice?: string
  timeoutMs?: number
  edgeTtsBinary?: string
  chunkSize?: number
  chunkingEnabled?: boolean
  fallbackEnabled?: boolean
  fallbackOrder?: string[]
  maxConcurrent?: number
  queueSize?: number
  queueTimeoutMs?: number
  totalTimeoutMs?: number
  trustedHosts?: string[]
  /** HTTP proxy forwarded to edge-tts as `--proxy`; no env fallback. */
  proxy?: string
  /** Engine health state machine tunables; omitted fields use defaults. */
  engineHealth?: Partial<EngineHealthConfig>
}

/** Effective, path-resolved plugin settings. */
export interface ResolvedConfig {
  /** Harness home from `DSH_HOME`; empty when unset. */
  dshHome: string
  /** Absolute output root; falls back to `~/.dsh/tts-output`. */
  outputDir: string
  defaultVoice: string
  timeoutMs: number
  edgeTtsBinary: string
  chunkSize: number
  chunkingEnabled: boolean
  fallbackEnabled: boolean
  /** Unknown engine names are dropped; order is preserved. */
  fallbackOrder: TtsEngine[]
  maxConcurrent: number
  queueSize: number
  queueTimeoutMs: number
  totalTimeoutMs: number
  trustedHosts: string[]
  /** Undefined when unset; deliberately never read from the environment. */
  proxy?: string
  /** Fully resolved engine health settings. */
  engineHealth: EngineHealthConfig
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function resolveEngineHealth(
  raw?: Partial<EngineHealthConfig>,
): EngineHealthConfig {
  return {
    enabled: raw?.enabled ?? DEFAULT_ENGINE_HEALTH.enabled,
    failureThreshold:
      raw?.failureThreshold ?? DEFAULT_ENGINE_HEALTH.failureThreshold,
    driftCooldownMs:
      raw?.driftCooldownMs ?? DEFAULT_ENGINE_HEALTH.driftCooldownMs,
    transientCooldownMs:
      raw?.transientCooldownMs ?? DEFAULT_ENGINE_HEALTH.transientCooldownMs,
    maxCooldownMs: raw?.maxCooldownMs ?? DEFAULT_ENGINE_HEALTH.maxCooldownMs,
  }
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
      : join(homedir(), '.dsh', OUTPUT_SUBDIR)

  return {
    dshHome,
    outputDir,
    defaultVoice: nonEmpty(raw?.defaultVoice) ?? DEFAULT_VOICE,
    timeoutMs: raw?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    edgeTtsBinary: nonEmpty(raw?.edgeTtsBinary) ?? DEFAULT_EDGE_TTS_BINARY,
    chunkSize: raw?.chunkSize ?? DEFAULT_CHUNK_SIZE,
    chunkingEnabled: raw?.chunkingEnabled ?? DEFAULT_CHUNKING_ENABLED,
    fallbackEnabled: raw?.fallbackEnabled ?? DEFAULT_FALLBACK_ENABLED,
    fallbackOrder:
      raw?.fallbackOrder === undefined
        ? [...DEFAULT_FALLBACK_ORDER]
        : raw.fallbackOrder.filter(isTtsEngine),
    maxConcurrent: raw?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    queueSize: raw?.queueSize ?? DEFAULT_QUEUE_SIZE,
    queueTimeoutMs: raw?.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS,
    totalTimeoutMs: raw?.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
    trustedHosts: (raw?.trustedHosts ?? [...DEFAULT_TRUSTED_HOSTS])
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0),
    proxy: nonEmpty(raw?.proxy),
    engineHealth: resolveEngineHealth(raw?.engineHealth),
  }
}

/**
 * Validate the settings a synthesis actually needs. Kept separate from
 * {@link resolveConfig} so loading the plugin never fails at mount time.
 */
export function requireSynthesisConfig(config: ResolvedConfig): {
  outputDir: string
  timeoutMs: number
  chunkSize: number
  chunkingEnabled: boolean
  fallbackEnabled: boolean
  fallbackOrder: TtsEngine[]
  maxConcurrent: number
  queueSize: number
  queueTimeoutMs: number
  totalTimeoutMs: number
  trustedHosts: string[]
  proxy?: string
  engineHealth: EngineHealthConfig
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
  if (
    config.chunkingEnabled &&
    (!Number.isInteger(config.chunkSize) || config.chunkSize <= 0)
  ) {
    throw new TtsError(
      ErrorCode.InvalidConfig,
      `Invalid config: chunkSize must be a positive integer, got ${JSON.stringify(config.chunkSize)}.`,
      'Set `chunkSize` to a positive character count (default 1200), or disable chunking.',
    )
  }
  if (
    !Number.isInteger(config.maxConcurrent) ||
    config.maxConcurrent < 1
  ) {
    throw new TtsError(
      ErrorCode.InvalidConfig,
      `Invalid config: maxConcurrent must be a positive integer, got ${JSON.stringify(config.maxConcurrent)}.`,
      'Set `maxConcurrent` to at least 1 (default 2).',
    )
  }
  if (!Number.isInteger(config.queueSize) || config.queueSize < 0) {
    throw new TtsError(
      ErrorCode.InvalidConfig,
      `Invalid config: queueSize must be a non-negative integer, got ${JSON.stringify(config.queueSize)}.`,
      'Set `queueSize` to 0 or more (default 4).',
    )
  }
  if (!Number.isFinite(config.queueTimeoutMs) || config.queueTimeoutMs <= 0) {
    throw new TtsError(
      ErrorCode.InvalidConfig,
      `Invalid config: queueTimeoutMs must be a positive number, got ${JSON.stringify(config.queueTimeoutMs)}.`,
      'Set `queueTimeoutMs` to a positive millisecond value (default 10000).',
    )
  }
  if (!Number.isFinite(config.totalTimeoutMs) || config.totalTimeoutMs <= 0) {
    throw new TtsError(
      ErrorCode.InvalidConfig,
      `Invalid config: totalTimeoutMs must be a positive number, got ${JSON.stringify(config.totalTimeoutMs)}.`,
      'Set `totalTimeoutMs` to a positive millisecond value (default 180000).',
    )
  }
  const health = config.engineHealth
  if (!Number.isInteger(health.failureThreshold) || health.failureThreshold < 1) {
    throw new TtsError(
      ErrorCode.InvalidConfig,
      `Invalid config: engineHealth.failureThreshold must be a positive integer, got ${JSON.stringify(health.failureThreshold)}.`,
      'Set `engineHealth.failureThreshold` to at least 1 (default 3).',
    )
  }
  for (const [field, value] of [
    ['driftCooldownMs', health.driftCooldownMs],
    ['transientCooldownMs', health.transientCooldownMs],
    ['maxCooldownMs', health.maxCooldownMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TtsError(
        ErrorCode.InvalidConfig,
        `Invalid config: engineHealth.${field} must be a positive number, got ${JSON.stringify(value)}.`,
        `Set \`engineHealth.${field}\` to a positive millisecond value.`,
      )
    }
  }
  return {
    outputDir: config.outputDir,
    timeoutMs: config.timeoutMs,
    chunkSize: config.chunkSize,
    chunkingEnabled: config.chunkingEnabled,
    fallbackEnabled: config.fallbackEnabled,
    fallbackOrder: config.fallbackOrder,
    maxConcurrent: config.maxConcurrent,
    queueSize: config.queueSize,
    queueTimeoutMs: config.queueTimeoutMs,
    totalTimeoutMs: config.totalTimeoutMs,
    trustedHosts: config.trustedHosts,
    proxy: config.proxy,
    engineHealth: health,
  }
}
