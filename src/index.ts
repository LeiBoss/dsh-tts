/**
 * DSH tool plugin: text in, a durable audio file out.
 *
 * The plugin owns exactly one capability — Edge-TTS synthesis into
 * `$DSH_HOME/tts-output` — and exposes it through `tts_generate` plus a
 * side-effect-free `tts_self_check`. It deliberately implements no playback,
 * transcription, voice cloning, or multi-provider routing.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  AudioRoute,
  type AudioUrlProvider,
  type ConnectionFence,
  type HttpRouteRegistrar,
} from './audio-route.ts'
import {
  AUDIO_FORMAT,
  cacheKey,
  findCachedFile,
  readCacheMetadata,
  writeCacheMetadata,
} from './cache.ts'
import { synthesizeChunked } from './chunked-tts.ts'
import { ConcurrencyLimiter } from './concurrency.ts'
import {
  Config,
  DEFAULT_RATE,
  requireSynthesisConfig,
  resolveConfig,
  type ResolvedConfig,
  type TtsConfig,
} from './config.ts'
import {
  synthesize,
  type SpawnFunction,
  type SynthesizedAudio,
} from './edge-tts.ts'
import { ErrorCode, TtsError } from './errors.ts'
import { isFallbackEligible, runFallback } from './fallback.ts'
import type { SapiOptions } from './sapi-tts.ts'
import { selfCheck, type SelfCheckResult } from './self-check.ts'
import { AVAILABLE_VOICES } from './voices.ts'

export { Config } from './config.ts'
export type { TtsConfig } from './config.ts'
export { ErrorCode, TtsError } from './errors.ts'
export { cacheKey, findCachedFile } from './cache.ts'
export { runProcess, synthesize } from './edge-tts.ts'
export { selfCheck } from './self-check.ts'
export { AUDIO_ROUTE_PREFIX, AudioRoute } from './audio-route.ts'
export { DEFAULT_CHUNK_SIZE, splitText } from './chunker.ts'
export { synthesizeChunked } from './chunked-tts.ts'
export { ConcurrencyLimiter, type ConcurrencyLimits } from './concurrency.ts'
export { isFallbackEligible, runFallback } from './fallback.ts'
export { isSapiSupported, sapiRate, synthesizeSapi } from './sapi-tts.ts'
export { AVAILABLE_VOICES, VOICES, type VoiceInfo } from './voices.ts'

export const name = 'dsh-tts'

/** The registry must exist before `apply` runs. */
export const inject = ['tools']

/**
 * Edge-TTS voice names are `<lang>-<REGION>-<Name>Neural`, with an optional
 * lowercase sub-region segment (for example `zh-CN-liaoning-XiaobeiNeural`).
 */
const VOICE_PATTERN = /^[a-z]{2,3}-[A-Z]{2,3}(?:-[a-z0-9]+)?-[A-Za-z0-9]+Neural$/

/** Edge-TTS rates are signed percentages such as `+0%` or `-10%`. */
const RATE_PATTERN = /^[+-]\d{1,3}%$/

/** Edge-TTS pitches are signed frequencies such as `+10Hz` or `-20Hz`. */
const PITCH_PATTERN = /^[+-]\d{1,3}Hz$/

/** Edge-TTS volumes are signed percentages such as `+20%` or `-10%`. */
const VOLUME_PATTERN = /^[+-]\d{1,3}%$/

/** Pitch Edge-TTS uses when the call omits one. */
export const DEFAULT_PITCH = '+0Hz'

/** Volume Edge-TTS uses when the call omits one. */
export const DEFAULT_VOLUME = '+0%'

/** Injection points used by tests; production always uses the defaults. */
export interface TtsDependencies {
  spawnImpl?: SpawnFunction
  now?: () => Date
  /** Present when a web route was registered; enables `browserUrl`. */
  audioRoute?: AudioUrlProvider
  /** Override the pause between chunk subprocesses (tests use 0). */
  chunkDelayMs?: number
  /** Platform override, so non-Windows tests can exercise the SAPI branch. */
  platform?: NodeJS.Platform
  /** Injected SAPI implementation; defaults to the real PowerShell path. */
  sapiSynthesize?: (
    text: string,
    options: SapiOptions,
  ) => Promise<SynthesizedAudio>
  powershellBinary?: string
  ffmpegBinary?: string
  /** Inject a limiter to share one capacity pool across tool instances. */
  limiter?: ConcurrencyLimiter
  /** Debug sink for fallback timing; never receives call arguments. */
  log?: (message: string) => void
}

/**
 * Canonical tool value. Only the fields declared in `output.schema` may
 * appear; `browserUrl` is omitted when the host offers no web route and
 * `engine` is omitted when the default Edge-TTS path produced the file.
 */
function canonicalAudio(
  audio: SynthesizedAudio,
  audioRoute: AudioUrlProvider | undefined,
  engine?: string,
): AudioValue {
  const browserUrl = audioRoute?.urlFor(audio.filePath)
  return {
    filePath: audio.filePath,
    format: audio.format,
    ...(browserUrl === undefined ? {} : { browserUrl }),
    ...(engine === undefined ? {} : { engine }),
  }
}

/** Value produced when the host cannot synthesize but the client can speak. */
interface SpeechSynthesisValue {
  fallback: 'speechSynthesis'
  text: string
  voice: string
  rate: string
}

/** Canonical tool outputs; `filePath`/`format` exist only for real audio. */
type AudioValue = {
  filePath: string
  format: string
  browserUrl?: string
  engine?: string
}
type GenerateValue = AudioValue | SpeechSynthesisValue

function requireText(text: string): void {
  if (text.trim().length === 0) {
    throw new TtsError(
      ErrorCode.EmptyText,
      '`text` must be a non-empty string.',
      'Pass the text that should be spoken; whitespace-only input is rejected.',
    )
  }
}

function requireVoice(voice: string): void {
  if (!VOICE_PATTERN.test(voice)) {
    throw new TtsError(
      ErrorCode.InvalidVoice,
      `Invalid Edge-TTS voice ${JSON.stringify(voice)}.`,
      'Use a name such as `zh-CN-XiaoxiaoNeural`; run `edge-tts --list-voices` to list valid voices.',
    )
  }
}

function requireRate(rate: string): void {
  if (!RATE_PATTERN.test(rate)) {
    throw new TtsError(
      ErrorCode.InvalidRate,
      `Invalid Edge-TTS rate ${JSON.stringify(rate)}.`,
      'Use a signed percentage such as `+0%`, `-10%`, or `+25%`.',
    )
  }
}

function requirePitch(pitch: string): void {
  if (!PITCH_PATTERN.test(pitch)) {
    throw new TtsError(
      ErrorCode.InvalidPitch,
      `Invalid Edge-TTS pitch ${JSON.stringify(pitch)}.`,
      'Use a signed frequency such as `+0Hz`, `+10Hz`, or `-20Hz`.',
    )
  }
}

function requireVolume(volume: string): void {
  if (!VOLUME_PATTERN.test(volume)) {
    throw new TtsError(
      ErrorCode.InvalidVolume,
      `Invalid Edge-TTS volume ${JSON.stringify(volume)}.`,
      'Use a signed percentage such as `+0%`, `+20%`, or `-10%`.',
    )
  }
}

function generateDescription(): string {
  return [
    'Synthesize speech from text with Edge-TTS and save it as a durable audio file.',
    'Call this when the user asks for spoken output as a file: read this aloud, generate a voiceover, make an audio version of the text.',
    'Returns the absolute file path and audio format. The model cannot hear the audio; use the path directly.',
    'It does NOT play audio, transcribe audio, clone or modify a voice, post-process audio, or generate music.',
  ].join(' ')
}

function selfCheckDescription(): string {
  return [
    'Diagnose the local TTS runtime without synthesizing audio.',
    'Reports whether the edge-tts binary is available, whether the DSH sandbox permits creating the subprocess, and whether the output directory is writable.',
    'Call this after installation, or when tts_generate fails with EDGE_TTS_NOT_FOUND, SPAWN_EPERM, or OUTPUT_DIR_NOT_WRITABLE.',
  ].join(' ')
}

/**
 * Build both tool definitions from one resolved config. Exported so tests can
 * exercise the real `execute` bodies with an injected spawn implementation.
 */
export function createTtsTools(
  config: ResolvedConfig,
  deps: TtsDependencies = {},
): ToolDefinition[] {
  const limiter =
    deps.limiter ??
    new ConcurrencyLimiter({
      maxConcurrent: config.maxConcurrent,
      queueSize: config.queueSize,
      queueTimeoutMs: config.queueTimeoutMs,
    })
  const inFlight = new Map<string, MergeGroup>()

  type SynthesisOutcome =
    | { kind: 'audio'; audio: SynthesizedAudio; engine?: string }
    | { kind: 'speechSynthesis' }

  interface MergeGroup {
    promise: Promise<SynthesisOutcome>
    controller: AbortController
    waiters: number
    settled: boolean
  }

  /**
   * Wait for a shared synthesis with a per-caller abort. A caller that gives
   * up only removes itself; the underlying task is aborted when the last
   * waiter leaves.
   */
  const waitForGroup = (
    group: MergeGroup,
    signal: AbortSignal | undefined,
  ): Promise<SynthesisOutcome> =>
    new Promise<SynthesisOutcome>((resolve, reject) => {
      group.waiters += 1
      let done = false

      const finish = (settle: () => void): void => {
        if (done) return
        done = true
        signal?.removeEventListener('abort', onAbort)
        group.waiters -= 1
        if (group.waiters === 0 && !group.settled) group.controller.abort()
        settle()
      }
      const onAbort = (): void => {
        finish(() =>
          reject(
            new TtsError(
              ErrorCode.Aborted,
              'TTS synthesis was aborted while waiting for a shared request.',
            ),
          ),
        )
      }

      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      group.promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      )
    })

  const cachedEngine = async (
    filePath: string,
  ): Promise<string | undefined> => {
    const metadata = await readCacheMetadata(filePath)
    if (metadata === undefined || metadata.engine === 'edge-tts') {
      return undefined
    }
    return metadata.engine
  }

  const recordMetadata = async (
    audio: SynthesizedAudio,
    engine: string,
    settings: { voice: string; rate: string; pitch: string; volume: string },
  ): Promise<void> => {
    await writeCacheMetadata(audio.filePath, {
      engine,
      ...settings,
      createdAt: new Date().toISOString(),
    })
  }

  const renderOutcome = (
    outcome: SynthesisOutcome,
    speech: Omit<SpeechSynthesisValue, 'fallback'>,
  ): GenerateValue => {
    if (outcome.kind === 'speechSynthesis') {
      return { fallback: 'speechSynthesis', ...speech }
    }
    return canonicalAudio(outcome.audio, deps.audioRoute, outcome.engine)
  }
  const generate = defineTool({
    name: 'tts_generate',
    description: generateDescription(),
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'Text to speak. Must contain at least one non-whitespace character.',
      },
      voice: {
        type: 'string',
        description: `Edge-TTS voice name, for example zh-CN-XiaoxiaoNeural. Defaults to ${config.defaultVoice}.`,
      },
      rate: {
        type: 'string',
        description: `Speech rate as a signed percentage, for example +0% or -10%. Defaults to ${DEFAULT_RATE}.`,
      },
      pitch: {
        type: 'string',
        description: `Pitch adjustment as a signed frequency, for example +10Hz or -20Hz. Defaults to ${DEFAULT_PITCH}.`,
      },
      volume: {
        type: 'string',
        description: `Volume adjustment as a signed percentage, for example +20% or -10%. Defaults to ${DEFAULT_VOLUME}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description:
              'Absolute path of the generated audio file. Present unless `fallback` is `speechSynthesis`.',
          },
          format: {
            type: 'string',
            description:
              'Audio container format, for example mp3. Present unless `fallback` is `speechSynthesis`.',
          },
          browserUrl: {
            type: 'string',
            description:
              'Same-origin URL that plays this audio in the DSH Web UI; absent when no web route is available.',
          },
          engine: {
            type: 'string',
            description:
              'Engine that produced the audio when it was not the default Edge-TTS path, for example `sapi`.',
          },
          fallback: {
            type: 'string',
            description:
              '`speechSynthesis` when no host audio file was produced and the caller should speak `text` with the browser API.',
          },
          text: {
            type: 'string',
            description:
              'Original text, returned only when `fallback` is `speechSynthesis`.',
          },
          voice: {
            type: 'string',
            description:
              'Effective voice, returned only when `fallback` is `speechSynthesis`.',
          },
          rate: {
            type: 'string',
            description:
              'Effective rate, returned only when `fallback` is `speechSynthesis`.',
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text' as const,
          text:
            'fallback' in value
              ? `${ErrorCode.SpeechSynthesisRequired}: satisfied without a host audio file. Read the returned text with the browser speechSynthesis API. If a file was expected, install or repair edge-tts and retry.`
              : value.browserUrl
                ? `Generated audio: ${value.filePath} (${value.format})\nPlayback URL: ${value.browserUrl}`
                : `Generated audio: ${value.filePath} (${value.format})`,
        },
      ],
    },
    async execute(args, exec) {
      const text = args.text
      requireText(text)

      const voice = args.voice?.trim() || config.defaultVoice
      requireVoice(voice)

      const rate = args.rate?.trim() || DEFAULT_RATE
      requireRate(rate)

      const pitch = args.pitch?.trim() || DEFAULT_PITCH
      requirePitch(pitch)

      const volume = args.volume?.trim() || DEFAULT_VOLUME
      requireVolume(volume)

      const {
        outputDir,
        timeoutMs,
        totalTimeoutMs,
        chunkSize,
        chunkingEnabled,
        fallbackEnabled,
        fallbackOrder,
      } = requireSynthesisConfig(config)
      const hash = cacheKey(text, voice, rate)
      const settings = { voice, rate, pitch, volume }

      const cached = await findCachedFile(outputDir, hash)
      if (cached !== undefined) {
        return canonicalAudio(
          { filePath: cached, format: AUDIO_FORMAT },
          deps.audioRoute,
          await cachedEngine(cached),
        )
      }

      // Identical in-flight requests share one synthesis; they never consume
      // another slot. Different pitch/volume share the key by design, matching
      // the documented cache behaviour.
      const existing = inFlight.get(hash)
      if (existing !== undefined) {
        return renderOutcome(await waitForGroup(existing, exec.signal), {
          text,
          voice,
          rate,
        })
      }

      const controller = new AbortController()
      const task = limiter.run<SynthesisOutcome>(async () => {
        // A request that waited for a slot may find the file already produced.
        const ready = await findCachedFile(outputDir, hash)
        if (ready !== undefined) {
          return {
            kind: 'audio',
            audio: { filePath: ready, format: AUDIO_FORMAT },
            engine: await cachedEngine(ready),
          }
        }

        const primary = async (): Promise<SynthesizedAudio> =>
          chunkingEnabled && text.length > chunkSize
            ? await synthesizeChunked(text, {
                voice,
                rate,
                pitch,
                volume,
                binary: config.edgeTtsBinary,
                outputDir,
                hash,
                timeoutMs,
                totalTimeoutMs,
                chunkSize,
                signal: controller.signal,
                spawnImpl: deps.spawnImpl,
                now: deps.now?.(),
                interChunkDelayMs: deps.chunkDelayMs,
              })
            : await synthesize(text, {
                voice,
                rate,
                pitch,
                volume,
                binary: config.edgeTtsBinary,
                outputDir,
                hash,
                timeoutMs,
                signal: controller.signal,
                spawnImpl: deps.spawnImpl,
                now: deps.now?.(),
              })

        try {
          const audio = await primary()
          await recordMetadata(audio, 'edge-tts', settings)
          return { kind: 'audio', audio }
        } catch (error) {
          // Validation, config, cache, and abort errors never fall back.
          if (!fallbackEnabled || !isFallbackEligible(error)) throw error

          const started = Date.now()
          const outcome = await runFallback(
            {
              text,
              rate,
              outputDir,
              hash,
              timeoutMs,
              fallbackOrder,
              signal: controller.signal,
              now: deps.now?.(),
              primaryError: error,
            },
            {
              platform: deps.platform,
              spawnImpl: deps.spawnImpl,
              powershellBinary: deps.powershellBinary,
              ffmpegBinary: deps.ffmpegBinary,
              synthesizeSapiImpl: deps.sapiSynthesize,
            },
          )
          deps.log?.(
            `fallback engine=${outcome.engine} elapsedMs=${Date.now() - started}`,
          )

          if (outcome.kind === 'speechSynthesis') {
            return { kind: 'speechSynthesis' }
          }
          await recordMetadata(outcome.audio, outcome.engine, settings)
          return {
            kind: 'audio',
            audio: outcome.audio,
            engine: outcome.engine,
          }
        }
      }, controller.signal)

      const group: MergeGroup = {
        promise: task,
        controller,
        waiters: 0,
        settled: false,
      }
      task.then(
        () => {
          group.settled = true
          if (inFlight.get(hash) === group) inFlight.delete(hash)
        },
        () => {
          group.settled = true
          if (inFlight.get(hash) === group) inFlight.delete(hash)
        },
      )
      inFlight.set(hash, group)

      return renderOutcome(await waitForGroup(group, exec.signal), {
        text,
        voice,
        rate,
      })
    },
  })

  const check = defineTool({
    name: 'tts_self_check',
    description: selfCheckDescription(),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          edgeTtsAvailable: {
            type: 'boolean',
            required: true,
            description: 'Whether the edge-tts binary could be started.',
          },
          edgeTtsVersion: {
            type: 'string',
            description: 'Reported Edge-TTS version, when the CLI exposes one.',
          },
          spawnAllowed: {
            type: 'boolean',
            required: true,
            description: 'Whether the sandbox permits creating the subprocess.',
          },
          outputDirWritable: {
            type: 'boolean',
            required: true,
            description: 'Whether the effective output directory exists and is writable.',
          },
          dshHome: {
            type: 'string',
            required: true,
            description: 'Value of DSH_HOME, or an empty string when unset.',
          },
          availableVoices: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description:
              'Static list of documented voice names; no network query is performed.',
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text' as const, text: JSON.stringify(value, null, 2) },
      ],
    },
    async execute(_args, exec): Promise<SelfCheckResult & { availableVoices: string[] }> {
      const result = await selfCheck({
        config,
        signal: exec.signal,
        spawnImpl: deps.spawnImpl,
      })
      return { ...result, availableVoices: [...AVAILABLE_VOICES] }
    },
  })

  return [generate, check]
}

/**
 * Read an optional Cordis service without requiring a static dependency.
 */
function serviceOf<T>(ctx: Context, name: string): T | undefined {
  const getter = (ctx as unknown as { get?: (key: string) => unknown }).get
  return typeof getter === 'function'
    ? (getter.call(ctx, name) as T | undefined)
    : undefined
}

/**
 * Mount both tools. Registration is fiber-owned, so unloading the plugin
 * unregisters them without explicit cleanup.
 */
export function apply(ctx: Context, config?: Partial<TtsConfig>): void {
  const resolved = resolveConfig(config)
  const logger =
    typeof ctx.logger === 'function' ? ctx.logger('dsh-tts') : undefined
  const debug = (message: string): void => {
    logger?.debug(message)
  }
  const connection = serviceOf<ConnectionFence>(ctx, 'connection')
  const audioRoute = resolved.outputDir
    ? new AudioRoute({
        outputDir: resolved.outputDir,
        trustedHosts: resolved.trustedHosts,
        connection,
        debug,
      })
    : undefined

  // The Web host provides `webServer`. Older hosts exposed the same router as
  // `httpServer`; if neither exists (for example Electron over file://), the
  // plugin still works but returns no browserUrl.
  if (audioRoute) {
    const webServer = serviceOf<HttpRouteRegistrar>(ctx, 'webServer')
    const legacy =
      webServer === undefined
        ? serviceOf<HttpRouteRegistrar>(ctx, 'httpServer')
        : undefined
    const server = webServer ?? legacy

    if (server !== undefined) {
      ctx.effect(() => audioRoute.register(server))
    } else {
      ctx.inject(['webServer'], (webCtx) => {
        const late = (webCtx as unknown as { webServer?: HttpRouteRegistrar })
          .webServer
        if (!late) return
        webCtx.effect(() => audioRoute.register(late))
      })
    }
  }

  for (const tool of createTtsTools(resolved, { audioRoute, log: debug })) {
    ctx.tools.register(tool)
  }
}
