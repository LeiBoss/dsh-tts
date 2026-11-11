/**
 * Fallback chain orchestration: Edge-TTS is the primary engine, and on an
 * eligible failure the configured chain is tried in order. SAPI is Windows-only;
 * the browser `speechSynthesis` entry produces a marker instead of a file (the
 * host cannot produce audio without an engine). A chain with no reachable
 * engine ends as `ALL_FALLBACKS_FAILED` listing every engine and reason.
 */
import type { TtsEngine } from './config.ts'
import type { SpawnFunction, SynthesizedAudio } from './edge-tts.ts'
import { ErrorCode, TtsError, type TtsErrorCode } from './errors.ts'
import {
  isSapiSupported,
  synthesizeSapi,
  type SapiOptions,
} from './sapi-tts.ts'

/** Codes that mean "the engine failed", not "the request is invalid". */
const FALLBACK_ELIGIBLE: ReadonlySet<string> = new Set<TtsErrorCode>([
  ErrorCode.EdgeTtsNotFound,
  ErrorCode.SpawnEperm,
  ErrorCode.SpawnFailed,
  ErrorCode.EdgeTtsFailed,
  ErrorCode.SynthesisTimeout,
  ErrorCode.EmptyAudio,
])

/** Whether a failed Edge-TTS attempt is worth retrying with another engine. */
export function isFallbackEligible(error: unknown): error is TtsError {
  return error instanceof TtsError && FALLBACK_ELIGIBLE.has(error.code)
}

/** One engine that was skipped or failed, with a human-readable reason. */
export interface FallbackAttempt {
  engine: TtsEngine
  reason: string
}

/** Either a produced file or a request for the client to speak the text. */
export type FallbackOutcome =
  | {
      kind: 'audio'
      audio: SynthesizedAudio
      engine: TtsEngine
      attempts: FallbackAttempt[]
    }
  | {
      kind: 'speechSynthesis'
      engine: 'speechSynthesis'
      attempts: FallbackAttempt[]
    }

export interface FallbackOptions {
  text: string
  rate: string
  outputDir: string
  hash: string
  timeoutMs: number
  fallbackOrder: readonly TtsEngine[]
  signal?: AbortSignal
  now?: Date
  /** Error thrown by the primary Edge-TTS attempt, kept for the final message. */
  primaryError?: unknown
}

/** Injection points; production uses the real Windows/ffmpeg binaries. */
export interface FallbackDependencies {
  platform?: NodeJS.Platform
  spawnImpl?: SpawnFunction
  powershellBinary?: string
  ffmpegBinary?: string
  synthesizeSapiImpl?: (
    text: string,
    options: SapiOptions,
  ) => Promise<SynthesizedAudio>
}

function describe(error: unknown): string {
  if (error instanceof TtsError) return `${error.code}: ${error.detail}`
  return error instanceof Error ? error.message : String(error)
}

function allFailed(
  order: readonly TtsEngine[],
  attempts: readonly FallbackAttempt[],
  primaryError: unknown,
): TtsError {
  const reasons = attempts
    .map((attempt) => `${attempt.engine} (${attempt.reason})`)
    .join('; ')
  return new TtsError(
    ErrorCode.AllFallbacksFailed,
    `All configured TTS fallbacks failed. Chain: ${order.join(' -> ')}. Tried: ${reasons}.`,
    'Install edge-tts and restore network access, or include `speechSynthesis` in `fallbackOrder`.',
    { cause: primaryError },
  )
}

/**
 * Run the configured engines after Edge-TTS already failed. `edge-tts` in
 * `fallbackOrder` marks the primary attempt rather than a retry.
 */
export async function runFallback(
  options: FallbackOptions,
  deps: FallbackDependencies = {},
): Promise<FallbackOutcome> {
  const platform = deps.platform ?? process.platform
  const sapiImpl = deps.synthesizeSapiImpl ?? synthesizeSapi
  const attempts: FallbackAttempt[] = [
    {
      engine: 'edge-tts',
      reason: `primary engine failed: ${describe(options.primaryError)}`,
    },
  ]

  // Local array narrowing keeps the literal union readable in the loop.
  const order: readonly TtsEngine[] = options.fallbackOrder

  for (const engine of order) {
    if (engine === 'edge-tts') continue

    if (engine === 'sapi') {
      if (!isSapiSupported(platform)) {
        attempts.push({ engine, reason: `skipped: SAPI is Windows-only (${platform})` })
        continue
      }
      try {
        const audio = await sapiImpl(options.text, {
          rate: options.rate,
          outputDir: options.outputDir,
          hash: options.hash,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          spawnImpl: deps.spawnImpl,
          now: options.now,
          platform,
          powershellBinary: deps.powershellBinary,
          ffmpegBinary: deps.ffmpegBinary,
        })
        attempts.push({ engine, reason: 'succeeded' })
        return { kind: 'audio', audio, engine, attempts }
      } catch (error) {
        if (error instanceof TtsError && error.code === ErrorCode.Aborted) throw error
        attempts.push({ engine, reason: describe(error) })
        continue
      }
    }

    if (engine === 'speechSynthesis') {
      return { kind: 'speechSynthesis', engine: 'speechSynthesis', attempts }
    }
  }

  throw allFailed(order, attempts, options.primaryError)
}
