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
  type HttpRouteRegistrar,
} from './audio-route.ts'
import { AUDIO_FORMAT, cacheKey, findCachedFile } from './cache.ts'
import { synthesizeChunked } from './chunked-tts.ts'
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
): { filePath: string; format: string; browserUrl?: string; engine?: string } {
  const browserUrl = audioRoute?.urlFor(audio.filePath)
  return {
    filePath: audio.filePath,
    format: audio.format,
    ...(browserUrl === undefined ? {} : { browserUrl }),
    ...(engine === undefined ? {} : { engine }),
  }
}

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
            required: true,
            description: 'Absolute path of the generated audio file.',
          },
          format: {
            type: 'string',
            required: true,
            description: 'Audio container format, for example mp3.',
          },
          durationMs: {
            type: 'number',
            description: 'Duration in milliseconds, when known.',
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
              '`speechSynthesis` when no host audio file was produced and the caller should speak the text with the browser API.',
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text' as const,
          text:
            value.fallback === 'speechSynthesis'
              ? `${ErrorCode.SpeechSynthesisRequired}: no host audio file was produced. Use the browser speechSynthesis API to read the text.`
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
      const volume = args.volume?.trim() || DEFAULT_VOLUME

      const {
        outputDir,
        timeoutMs,
        chunkSize,
        chunkingEnabled,
        fallbackEnabled,
        fallbackOrder,
      } = requireSynthesisConfig(config)
      const hash = cacheKey(text, voice, rate)

      const cached = await findCachedFile(outputDir, hash)
      if (cached !== undefined) {
        return canonicalAudio(
          { filePath: cached, format: AUDIO_FORMAT },
          deps.audioRoute,
        )
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
              chunkSize,
              signal: exec.signal,
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
              signal: exec.signal,
              spawnImpl: deps.spawnImpl,
              now: deps.now?.(),
            })

      let audio: SynthesizedAudio
      try {
        audio = await primary()
      } catch (error) {
        // Validation, config, cache, and abort errors never fall back.
        if (!fallbackEnabled || !isFallbackEligible(error)) throw error

        const outcome = await runFallback(
          {
            text,
            rate,
            outputDir,
            hash,
            timeoutMs,
            fallbackOrder,
            signal: exec.signal,
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

        if (outcome.kind === 'speechSynthesis') {
          return {
            filePath: '',
            format: '',
            engine: outcome.engine,
            fallback: outcome.engine,
          }
        }
        return canonicalAudio(outcome.audio, deps.audioRoute, outcome.engine)
      }

      return canonicalAudio(audio, deps.audioRoute)
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
 * Mount both tools. Registration is fiber-owned, so unloading the plugin
 * unregisters them without explicit cleanup.
 */
export function apply(ctx: Context, config?: Partial<TtsConfig>): void {
  const resolved = resolveConfig(config)
  const audioRoute = resolved.outputDir
    ? new AudioRoute({ outputDir: resolved.outputDir })
    : undefined

  // Optional dependency: non-Web runtimes (for example Electron over file://)
  // never provide `httpServer`, and the plugin still works without browserUrl.
  if (audioRoute) {
    ctx.inject(['httpServer'], (webCtx) => {
      const server = (webCtx as unknown as { httpServer?: HttpRouteRegistrar })
        .httpServer
      if (!server) return
      webCtx.effect(() => audioRoute.register(server))
    })
  }

  for (const tool of createTtsTools(resolved, { audioRoute })) {
    ctx.tools.register(tool)
  }
}
