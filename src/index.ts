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
import { AUDIO_FORMAT, cacheKey, findCachedFile } from './cache.ts'
import {
  Config,
  DEFAULT_RATE,
  requireSynthesisConfig,
  resolveConfig,
  type ResolvedConfig,
  type TtsConfig,
} from './config.ts'
import { synthesize, type SpawnFunction } from './edge-tts.ts'
import { ErrorCode, TtsError } from './errors.ts'
import { selfCheck, type SelfCheckResult } from './self-check.ts'

export { Config } from './config.ts'
export type { TtsConfig } from './config.ts'
export { ErrorCode, TtsError } from './errors.ts'
export { cacheKey, findCachedFile } from './cache.ts'
export { runProcess, synthesize } from './edge-tts.ts'
export { selfCheck } from './self-check.ts'

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

/** Injection points used by tests; production always uses the defaults. */
export interface TtsDependencies {
  spawnImpl?: SpawnFunction
  now?: () => Date
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
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text' as const,
          text: `Generated audio: ${value.filePath} (${value.format})`,
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

      const { outputDir, timeoutMs } = requireSynthesisConfig(config)
      const hash = cacheKey(text, voice, rate)

      const cached = await findCachedFile(outputDir, hash)
      if (cached !== undefined) {
        return { filePath: cached, format: AUDIO_FORMAT }
      }

      const audio = await synthesize(text, {
        voice,
        rate,
        binary: config.edgeTtsBinary,
        outputDir,
        hash,
        timeoutMs,
        signal: exec.signal,
        spawnImpl: deps.spawnImpl,
        now: deps.now?.(),
      })

      return { filePath: audio.filePath, format: audio.format }
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
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text' as const, text: JSON.stringify(value, null, 2) },
      ],
    },
    async execute(_args, exec): Promise<SelfCheckResult> {
      return selfCheck({
        config,
        signal: exec.signal,
        spawnImpl: deps.spawnImpl,
      })
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
  for (const tool of createTtsTools(resolved)) {
    ctx.tools.register(tool)
  }
}
