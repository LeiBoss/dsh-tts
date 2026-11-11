import { defineTool } from '@deepseek-ai/dsh-tools';
import { AudioRoute, } from "./audio-route.js";
import { AUDIO_FORMAT, cacheKey, findCachedFile } from "./cache.js";
import { synthesizeChunked } from "./chunked-tts.js";
import { Config, DEFAULT_RATE, requireSynthesisConfig, resolveConfig, } from "./config.js";
import { synthesize, } from "./edge-tts.js";
import { ErrorCode, TtsError } from "./errors.js";
import { isFallbackEligible, runFallback } from "./fallback.js";
import { selfCheck } from "./self-check.js";
export { Config } from "./config.js";
export { ErrorCode, TtsError } from "./errors.js";
export { cacheKey, findCachedFile } from "./cache.js";
export { runProcess, synthesize } from "./edge-tts.js";
export { selfCheck } from "./self-check.js";
export { AUDIO_ROUTE_PREFIX, AudioRoute } from "./audio-route.js";
export { DEFAULT_CHUNK_SIZE, splitText } from "./chunker.js";
export { synthesizeChunked } from "./chunked-tts.js";
export { isFallbackEligible, runFallback } from "./fallback.js";
export { isSapiSupported, sapiRate, synthesizeSapi } from "./sapi-tts.js";
export const name = 'dsh-tts';
/** The registry must exist before `apply` runs. */
export const inject = ['tools'];
/**
 * Edge-TTS voice names are `<lang>-<REGION>-<Name>Neural`, with an optional
 * lowercase sub-region segment (for example `zh-CN-liaoning-XiaobeiNeural`).
 */
const VOICE_PATTERN = /^[a-z]{2,3}-[A-Z]{2,3}(?:-[a-z0-9]+)?-[A-Za-z0-9]+Neural$/;
/** Edge-TTS rates are signed percentages such as `+0%` or `-10%`. */
const RATE_PATTERN = /^[+-]\d{1,3}%$/;
/**
 * Canonical tool value. Only the fields declared in `output.schema` may
 * appear; `browserUrl` is omitted when the host offers no web route and
 * `engine` is omitted when the default Edge-TTS path produced the file.
 */
function canonicalAudio(audio, audioRoute, engine) {
    const browserUrl = audioRoute?.urlFor(audio.filePath);
    return {
        filePath: audio.filePath,
        format: audio.format,
        ...(browserUrl === undefined ? {} : { browserUrl }),
        ...(engine === undefined ? {} : { engine }),
    };
}
function requireText(text) {
    if (text.trim().length === 0) {
        throw new TtsError(ErrorCode.EmptyText, '`text` must be a non-empty string.', 'Pass the text that should be spoken; whitespace-only input is rejected.');
    }
}
function requireVoice(voice) {
    if (!VOICE_PATTERN.test(voice)) {
        throw new TtsError(ErrorCode.InvalidVoice, `Invalid Edge-TTS voice ${JSON.stringify(voice)}.`, 'Use a name such as `zh-CN-XiaoxiaoNeural`; run `edge-tts --list-voices` to list valid voices.');
    }
}
function requireRate(rate) {
    if (!RATE_PATTERN.test(rate)) {
        throw new TtsError(ErrorCode.InvalidRate, `Invalid Edge-TTS rate ${JSON.stringify(rate)}.`, 'Use a signed percentage such as `+0%`, `-10%`, or `+25%`.');
    }
}
function generateDescription() {
    return [
        'Synthesize speech from text with Edge-TTS and save it as a durable audio file.',
        'Call this when the user asks for spoken output as a file: read this aloud, generate a voiceover, make an audio version of the text.',
        'Returns the absolute file path and audio format. The model cannot hear the audio; use the path directly.',
        'It does NOT play audio, transcribe audio, clone or modify a voice, post-process audio, or generate music.',
    ].join(' ');
}
function selfCheckDescription() {
    return [
        'Diagnose the local TTS runtime without synthesizing audio.',
        'Reports whether the edge-tts binary is available, whether the DSH sandbox permits creating the subprocess, and whether the output directory is writable.',
        'Call this after installation, or when tts_generate fails with EDGE_TTS_NOT_FOUND, SPAWN_EPERM, or OUTPUT_DIR_NOT_WRITABLE.',
    ].join(' ');
}
/**
 * Build both tool definitions from one resolved config. Exported so tests can
 * exercise the real `execute` bodies with an injected spawn implementation.
 */
export function createTtsTools(config, deps = {}) {
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
                    browserUrl: {
                        type: 'string',
                        description: 'Same-origin URL that plays this audio in the DSH Web UI; absent when no web route is available.',
                    },
                    engine: {
                        type: 'string',
                        description: 'Engine that produced the audio when it was not the default Edge-TTS path, for example `sapi`.',
                    },
                    fallback: {
                        type: 'string',
                        description: '`speechSynthesis` when no host audio file was produced and the caller should speak the text with the browser API.',
                    },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [
                {
                    type: 'text',
                    text: value.fallback === 'speechSynthesis'
                        ? `${ErrorCode.SpeechSynthesisRequired}: no host audio file was produced. Use the browser speechSynthesis API to read the text.`
                        : value.browserUrl
                            ? `Generated audio: ${value.filePath} (${value.format})\nPlayback URL: ${value.browserUrl}`
                            : `Generated audio: ${value.filePath} (${value.format})`,
                },
            ],
        },
        async execute(args, exec) {
            const text = args.text;
            requireText(text);
            const voice = args.voice?.trim() || config.defaultVoice;
            requireVoice(voice);
            const rate = args.rate?.trim() || DEFAULT_RATE;
            requireRate(rate);
            const { outputDir, timeoutMs, chunkSize, chunkingEnabled, fallbackEnabled, fallbackOrder, } = requireSynthesisConfig(config);
            const hash = cacheKey(text, voice, rate);
            const cached = await findCachedFile(outputDir, hash);
            if (cached !== undefined) {
                return canonicalAudio({ filePath: cached, format: AUDIO_FORMAT }, deps.audioRoute);
            }
            const primary = async () => chunkingEnabled && text.length > chunkSize
                ? await synthesizeChunked(text, {
                    voice,
                    rate,
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
                    binary: config.edgeTtsBinary,
                    outputDir,
                    hash,
                    timeoutMs,
                    signal: exec.signal,
                    spawnImpl: deps.spawnImpl,
                    now: deps.now?.(),
                });
            let audio;
            try {
                audio = await primary();
            }
            catch (error) {
                // Validation, config, cache, and abort errors never fall back.
                if (!fallbackEnabled || !isFallbackEligible(error))
                    throw error;
                const outcome = await runFallback({
                    text,
                    rate,
                    outputDir,
                    hash,
                    timeoutMs,
                    fallbackOrder,
                    signal: exec.signal,
                    now: deps.now?.(),
                    primaryError: error,
                }, {
                    platform: deps.platform,
                    spawnImpl: deps.spawnImpl,
                    powershellBinary: deps.powershellBinary,
                    ffmpegBinary: deps.ffmpegBinary,
                    synthesizeSapiImpl: deps.sapiSynthesize,
                });
                if (outcome.kind === 'speechSynthesis') {
                    return {
                        filePath: '',
                        format: '',
                        engine: outcome.engine,
                        fallback: outcome.engine,
                    };
                }
                return canonicalAudio(outcome.audio, deps.audioRoute, outcome.engine);
            }
            return canonicalAudio(audio, deps.audioRoute);
        },
    });
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
                { type: 'text', text: JSON.stringify(value, null, 2) },
            ],
        },
        async execute(_args, exec) {
            return selfCheck({
                config,
                signal: exec.signal,
                spawnImpl: deps.spawnImpl,
            });
        },
    });
    return [generate, check];
}
/**
 * Mount both tools. Registration is fiber-owned, so unloading the plugin
 * unregisters them without explicit cleanup.
 */
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    const audioRoute = resolved.outputDir
        ? new AudioRoute({ outputDir: resolved.outputDir })
        : undefined;
    // Optional dependency: non-Web runtimes (for example Electron over file://)
    // never provide `httpServer`, and the plugin still works without browserUrl.
    if (audioRoute) {
        ctx.inject(['httpServer'], (webCtx) => {
            const server = webCtx
                .httpServer;
            if (!server)
                return;
            webCtx.effect(() => audioRoute.register(server));
        });
    }
    for (const tool of createTtsTools(resolved, { audioRoute })) {
        ctx.tools.register(tool);
    }
}
//# sourceMappingURL=index.js.map