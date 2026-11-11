import { defineTool } from '@deepseek-ai/dsh-tools';
import { AudioRoute, } from "./audio-route.js";
import { AUDIO_FORMAT, cacheKey, findCachedFile, readCacheMetadata, writeCacheMetadata, } from "./cache.js";
import { synthesizeChunked } from "./chunked-tts.js";
import { ConcurrencyLimiter } from "./concurrency.js";
import { Config, DEFAULT_RATE, isTtsEngine, requireSynthesisConfig, resolveConfig, } from "./config.js";
import { EngineHealthRegistry } from "./engine-health.js";
import { synthesize, } from "./edge-tts.js";
import { ErrorCode, TtsError } from "./errors.js";
import { isFallbackEligible, runFallback } from "./fallback.js";
import { selfCheck } from "./self-check.js";
import { probeEndpoint } from "./probe.js";
import { AVAILABLE_VOICES } from "./voices.js";
export { Config } from "./config.js";
export { ErrorCode, TtsError } from "./errors.js";
export { cacheKey, findCachedFile } from "./cache.js";
export { runProcess, synthesize } from "./edge-tts.js";
export { selfCheck } from "./self-check.js";
export { AUDIO_ROUTE_PREFIX, AudioRoute } from "./audio-route.js";
export { DEFAULT_CHUNK_SIZE, splitText } from "./chunker.js";
export { synthesizeChunked } from "./chunked-tts.js";
export { ConcurrencyLimiter } from "./concurrency.js";
export { isFallbackEligible, runFallback } from "./fallback.js";
export { isSapiSupported, sapiRate, synthesizeSapi } from "./sapi-tts.js";
export { AVAILABLE_VOICES, VOICES } from "./voices.js";
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
/** Edge-TTS pitches are signed frequencies such as `+10Hz` or `-20Hz`. */
const PITCH_PATTERN = /^[+-]\d{1,3}Hz$/;
/** Edge-TTS volumes are signed percentages such as `+20%` or `-10%`. */
const VOLUME_PATTERN = /^[+-]\d{1,3}%$/;
/** Pitch Edge-TTS uses when the call omits one. */
export const DEFAULT_PITCH = '+0Hz';
/** Volume Edge-TTS uses when the call omits one. */
export const DEFAULT_VOLUME = '+0%';
/**
 * Canonical tool value. Only the fields declared in `output.schema` may
 * appear; `browserUrl` is omitted when the host offers no web route and
 * `engine` is omitted when the default Edge-TTS path produced the file.
 */
function canonicalAudio(audio, audioRoute, engine, engineHealth) {
    const browserUrl = audioRoute?.urlFor(audio.filePath);
    return {
        filePath: audio.filePath,
        format: audio.format,
        ...(browserUrl === undefined ? {} : { browserUrl }),
        ...(engine === undefined ? {} : { engine }),
        ...(engineHealth === undefined ? {} : { engineHealth }),
    };
}
/**
 * Optional health descriptor attached only when it carries information: a
 * non-default engine, a non-healthy engine, or a skipped engine. The plain
 * Edge-TTS success path therefore keeps its historical `{filePath, format}`
 * shape.
 */
function describeEngineHealth(usedEngine, usedEngineState, skipped) {
    if (usedEngine === 'edge-tts' &&
        usedEngineState === 'healthy' &&
        skipped.length === 0) {
        return undefined;
    }
    return {
        usedEngine,
        usedEngineState,
        ...(skipped.length === 0 ? {} : { skippedEngines: [...skipped] }),
    };
}
/**
 * Condense per-engine failures for the `speechSynthesis` fallback. Absolute
 * paths are stripped and each reason is truncated: the field is user-visible
 * and must never leak temp paths, tokens or the source text.
 */
function summarizeAttempts(attempts) {
    return attempts
        .map((attempt) => {
        const reason = attempt.reason
            .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s'"`;:]+/g, '[path]')
            .replace(/\s+/g, ' ')
            .trim();
        const clipped = reason.length > 160 ? `${reason.slice(0, 157)}...` : reason;
        return `${attempt.engine}: ${clipped}`;
    })
        .join('; ');
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
function requirePitch(pitch) {
    if (!PITCH_PATTERN.test(pitch)) {
        throw new TtsError(ErrorCode.InvalidPitch, `Invalid Edge-TTS pitch ${JSON.stringify(pitch)}.`, 'Use a signed frequency such as `+0Hz`, `+10Hz`, or `-20Hz`.');
    }
}
function requireVolume(volume) {
    if (!VOLUME_PATTERN.test(volume)) {
        throw new TtsError(ErrorCode.InvalidVolume, `Invalid Edge-TTS volume ${JSON.stringify(volume)}.`, 'Use a signed percentage such as `+0%`, `+20%`, or `-10%`.');
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
function probeDescription() {
    return [
        'Network diagnostic only: opens one TCP connection to speech.platform.bing.com:443 (1.5 s timeout by default, 5 s maximum) and reports whether it is reachable.',
        'It does not synthesize audio, does not send a WebSocket handshake, and does not consume Edge-TTS quota.',
        'The probe always connects directly, even when a proxy is configured; a false result can simply mean the machine needs a proxy. In that case check the `proxy` config instead of assuming the plugin is broken.',
        'tts_self_check stays fully offline; call this tool only when you need to test connectivity.',
    ].join(' ');
}
/**
 * Build both tool definitions from one resolved config. Exported so tests can
 * exercise the real `execute` bodies with an injected spawn implementation.
 */
export function createTtsTools(config, deps = {}) {
    const limiter = deps.limiter ??
        new ConcurrencyLimiter({
            maxConcurrent: config.maxConcurrent,
            queueSize: config.queueSize,
            queueTimeoutMs: config.queueTimeoutMs,
        });
    const inFlight = new Map();
    // Process-local health only; a plugin restart starts every engine healthy.
    const health = new EngineHealthRegistry(config.engineHealth, deps.now ?? (() => new Date()));
    /**
     * Wait for a shared synthesis with a per-caller abort. A caller that gives
     * up only removes itself; the underlying task is aborted when the last
     * waiter leaves.
     */
    const waitForGroup = (group, signal) => new Promise((resolve, reject) => {
        group.waiters += 1;
        let done = false;
        const finish = (settle) => {
            if (done)
                return;
            done = true;
            signal?.removeEventListener('abort', onAbort);
            group.waiters -= 1;
            if (group.waiters === 0 && !group.settled)
                group.controller.abort();
            settle();
        };
        const onAbort = () => {
            finish(() => reject(new TtsError(ErrorCode.Aborted, 'TTS synthesis was aborted while waiting for a shared request.')));
        };
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        group.promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    });
    const cachedEngine = async (filePath) => {
        const metadata = await readCacheMetadata(filePath);
        if (metadata === undefined || metadata.engine === 'edge-tts') {
            return undefined;
        }
        return metadata.engine;
    };
    const recordMetadata = async (audio, engine, settings) => {
        await writeCacheMetadata(audio.filePath, {
            engine,
            ...settings,
            createdAt: new Date().toISOString(),
        });
    };
    /**
     * A cache hit used no engine, so report the state of whichever engine
     * produced the file (or Edge-TTS for legacy entries without a sidecar).
     */
    const healthForCacheHit = (cachedEngineName) => {
        const usedEngine = cachedEngineName ?? 'edge-tts';
        const state = health.stateOf(isTtsEngine(usedEngine) ? usedEngine : 'edge-tts');
        return describeEngineHealth(usedEngine, state, []);
    };
    const renderOutcome = (outcome, speech) => {
        if (outcome.kind === 'speechSynthesis') {
            return {
                fallback: 'speechSynthesis',
                ...speech,
                ...(outcome.reason === undefined
                    ? {}
                    : { fallbackReason: outcome.reason }),
            };
        }
        return canonicalAudio(outcome.audio, deps.audioRoute, outcome.engine, outcome.engineHealth);
    };
    /**
     * Human-readable tool output. The JSON contract keeps `browserUrl` relative;
     * the absolute link is rendered only when the host advertised an origin, so
     * headless runs simply omit it instead of guessing a host.
     */
    const renderGeneratedAudio = (value) => {
        if (value.fallback === 'speechSynthesis') {
            const base = `${ErrorCode.SpeechSynthesisRequired}: satisfied without a host audio file. Read the returned text with the browser speechSynthesis API. If a file was expected, install or repair edge-tts and retry.`;
            return value.fallbackReason === undefined
                ? base
                : `${base}\nReason: ${value.fallbackReason}`;
        }
        const filePath = value.filePath ?? '';
        const format = value.format ?? '';
        const absolute = (() => {
            try {
                return deps.audioRoute?.absoluteUrlFor?.(filePath);
            }
            catch {
                return undefined;
            }
        })();
        const header = `Generated audio: \`${filePath}\` (${format})`;
        if (absolute !== undefined) {
            return `${header}\n[▶ 播放](${absolute})`;
        }
        if (value.browserUrl !== undefined) {
            return `Generated audio: ${filePath} (${format})\nPlayback URL: ${value.browserUrl}`;
        }
        return header;
    };
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
                        description: 'Absolute path of the generated audio file. Present unless `fallback` is `speechSynthesis`.',
                    },
                    format: {
                        type: 'string',
                        description: 'Audio container format, for example mp3. Present unless `fallback` is `speechSynthesis`.',
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
                        description: '`speechSynthesis` when no host audio file was produced and the caller should speak `text` with the browser API.',
                    },
                    text: {
                        type: 'string',
                        description: 'Original text, returned only when `fallback` is `speechSynthesis`.',
                    },
                    voice: {
                        type: 'string',
                        description: 'Effective voice, returned only when `fallback` is `speechSynthesis`.',
                    },
                    rate: {
                        type: 'string',
                        description: 'Effective rate, returned only when `fallback` is `speechSynthesis`.',
                    },
                    fallbackReason: {
                        type: 'string',
                        description: 'Condensed per-engine failure summary, returned only when `fallback` is `speechSynthesis`. Contains engine names, error codes and truncated stderr; never user text, tokens or absolute paths.',
                    },
                    engineHealth: {
                        type: 'object',
                        additionalProperties: false,
                        description: 'Optional in-memory health snapshot for this call. Omitted on the plain healthy Edge-TTS path. Reflects the last observed attempt, not a live network probe.',
                        properties: {
                            usedEngine: {
                                type: 'string',
                                required: true,
                                description: 'Engine that produced this audio, for example `edge-tts` or `sapi`.',
                            },
                            usedEngineState: {
                                type: 'string',
                                required: true,
                                enum: ['healthy', 'degraded', 'open'],
                                description: 'Health of `usedEngine` just before this attempt succeeded.',
                            },
                            skippedEngines: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Engines skipped for this attempt because their cooldown circuit was open.',
                            },
                        },
                    },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [
                {
                    type: 'text',
                    text: renderGeneratedAudio(value),
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
            const pitch = args.pitch?.trim() || DEFAULT_PITCH;
            requirePitch(pitch);
            const volume = args.volume?.trim() || DEFAULT_VOLUME;
            requireVolume(volume);
            const { outputDir, timeoutMs, totalTimeoutMs, chunkSize, chunkingEnabled, fallbackEnabled, fallbackOrder, } = requireSynthesisConfig(config);
            const hash = cacheKey(text, voice, rate);
            const settings = { voice, rate, pitch, volume };
            const cached = await findCachedFile(outputDir, hash);
            if (cached !== undefined) {
                const engine = await cachedEngine(cached);
                return canonicalAudio({ filePath: cached, format: AUDIO_FORMAT }, deps.audioRoute, engine, healthForCacheHit(engine));
            }
            // Identical in-flight requests share one synthesis; they never consume
            // another slot. Different pitch/volume share the key by design, matching
            // the documented cache behaviour.
            const existing = inFlight.get(hash);
            if (existing !== undefined) {
                return renderOutcome(await waitForGroup(existing, exec.signal), {
                    text,
                    voice,
                    rate,
                });
            }
            const controller = new AbortController();
            const task = limiter.run(async () => {
                // A request that waited for a slot may find the file already produced.
                const ready = await findCachedFile(outputDir, hash);
                if (ready !== undefined) {
                    const engine = await cachedEngine(ready);
                    const engineHealth = healthForCacheHit(engine);
                    return {
                        kind: 'audio',
                        audio: { filePath: ready, format: AUDIO_FORMAT },
                        ...(engine === undefined ? {} : { engine }),
                        ...(engineHealth === undefined ? {} : { engineHealth }),
                    };
                }
                const primary = async () => chunkingEnabled && text.length > chunkSize
                    ? await synthesizeChunked(text, {
                        voice,
                        rate,
                        pitch,
                        volume,
                        proxy: config.proxy,
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
                        proxy: config.proxy,
                        binary: config.edgeTtsBinary,
                        outputDir,
                        hash,
                        timeoutMs,
                        signal: controller.signal,
                        spawnImpl: deps.spawnImpl,
                        now: deps.now?.(),
                    });
                // Health only removes engines from this attempt; the order below is
                // still the configured chain, and an all-open chain forces its last
                // engine through instead of returning an empty result.
                const chain = fallbackEnabled
                    ? ['edge-tts', ...fallbackOrder.filter((name) => name !== 'edge-tts')]
                    : ['edge-tts'];
                const plan = health.plan(chain);
                const skipped = [...plan.skip];
                const primarySkipped = plan.skip.has('edge-tts');
                const runChain = async (primaryError) => {
                    const started = Date.now();
                    const outcome = await runFallback({
                        text,
                        rate,
                        outputDir,
                        hash,
                        timeoutMs,
                        fallbackOrder,
                        signal: controller.signal,
                        now: deps.now?.(),
                        ...(primaryError === undefined ? {} : { primaryError }),
                        ...(primarySkipped
                            ? {
                                primaryReason: 'primary engine skipped: circuit open (cooldown)',
                            }
                            : {}),
                        skip: plan.skip,
                    }, {
                        platform: deps.platform,
                        spawnImpl: deps.spawnImpl,
                        powershellBinary: deps.powershellBinary,
                        ffmpegBinary: deps.ffmpegBinary,
                        synthesizeSapiImpl: deps.sapiSynthesize,
                        health,
                    });
                    deps.log?.(`fallback engine=${outcome.engine} elapsedMs=${Date.now() - started}`);
                    if (outcome.kind === 'speechSynthesis') {
                        return {
                            kind: 'speechSynthesis',
                            reason: summarizeAttempts(outcome.attempts),
                        };
                    }
                    await recordMetadata(outcome.audio, outcome.engine, settings);
                    const engineHealth = describeEngineHealth(outcome.engine, outcome.engineState, skipped);
                    return {
                        kind: 'audio',
                        audio: outcome.audio,
                        engine: outcome.engine,
                        ...(engineHealth === undefined ? {} : { engineHealth }),
                    };
                };
                if (primarySkipped)
                    return await runChain();
                try {
                    const audio = await primary();
                    const engineState = health.stateOf('edge-tts');
                    health.recordSuccess('edge-tts');
                    await recordMetadata(audio, 'edge-tts', settings);
                    const engineHealth = describeEngineHealth('edge-tts', engineState, skipped);
                    return {
                        kind: 'audio',
                        audio,
                        ...(engineHealth === undefined ? {} : { engineHealth }),
                    };
                }
                catch (error) {
                    health.recordFailure('edge-tts', error);
                    // Validation, config, cache, and abort errors never fall back.
                    if (!fallbackEnabled || !isFallbackEligible(error))
                        throw error;
                    return await runChain(error);
                }
            }, controller.signal);
            const group = {
                promise: task,
                controller,
                waiters: 0,
                settled: false,
            };
            task.then(() => {
                group.settled = true;
                if (inFlight.get(hash) === group)
                    inFlight.delete(hash);
            }, () => {
                group.settled = true;
                if (inFlight.get(hash) === group)
                    inFlight.delete(hash);
            });
            inFlight.set(hash, group);
            return renderOutcome(await waitForGroup(group, exec.signal), {
                text,
                voice,
                rate,
            });
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
                    proxyConfigured: {
                        type: 'boolean',
                        required: true,
                        description: 'Whether a proxy is configured for Edge-TTS. Connectivity is not tested; call tts_probe_network for that.',
                    },
                    availableVoices: {
                        type: 'array',
                        items: { type: 'string' },
                        required: true,
                        description: 'Static list of documented voice names; no network query is performed.',
                    },
                    engineHealth: {
                        type: 'object',
                        required: true,
                        additionalProperties: true,
                        description: 'In-memory per-engine health snapshot keyed by engine name, with `state` and `consecutiveFailures` (plus `lastErrorCode` after a failure). It is not a live probe: tts_self_check performs no network requests.',
                    },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [
                { type: 'text', text: JSON.stringify(value, null, 2) },
            ],
        },
        async execute(_args, exec) {
            const result = await selfCheck({
                config,
                signal: exec.signal,
                spawnImpl: deps.spawnImpl,
                engineHealth: () => health.snapshot(),
            });
            return {
                ...result,
                availableVoices: [...AVAILABLE_VOICES],
                engineHealth: result.engineHealth ?? health.snapshot(),
            };
        },
    });
    const probe = defineTool({
        name: 'tts_probe_network',
        description: probeDescription(),
        parameters: {
            timeoutMs: {
                type: 'number',
                description: 'TCP connect timeout in milliseconds. Defaults to 1500; values are clamped to 1..5000.',
            },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    host: {
                        type: 'string',
                        required: true,
                        description: 'Probed host; always speech.platform.bing.com.',
                    },
                    port: {
                        type: 'number',
                        required: true,
                        description: 'Probed TCP port; always 443.',
                    },
                    reachable: {
                        type: 'boolean',
                        required: true,
                        description: 'Whether the TCP connection completed before the timeout.',
                    },
                    elapsedMs: {
                        type: 'number',
                        required: true,
                        description: 'Wall-clock time spent on the probe, in milliseconds.',
                    },
                    proxyConfigured: {
                        type: 'boolean',
                        required: true,
                        description: 'Whether a proxy is configured. The probe itself always connects directly.',
                    },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [
                { type: 'text', text: JSON.stringify(value, null, 2) },
            ],
        },
        async execute(args, exec) {
            const result = await probeEndpoint({
                timeoutMs: args.timeoutMs,
                signal: exec.signal,
                connectImpl: deps.probeConnect,
            });
            return { ...result, proxyConfigured: config.proxy !== undefined };
        },
    });
    return [generate, check, probe];
}
/**
 * Read an optional Cordis service without requiring a static dependency.
 */
function serviceOf(ctx, name) {
    const getter = ctx.get;
    return typeof getter === 'function'
        ? getter.call(ctx, name)
        : undefined;
}
/**
 * Mount both tools. Registration is fiber-owned, so unloading the plugin
 * unregisters them without explicit cleanup.
 */
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    const logger = typeof ctx.logger === 'function' ? ctx.logger('@leiboss/dsh-tts') : undefined;
    const debug = (message) => {
        logger?.debug(message);
    };
    const connection = serviceOf(ctx, 'connection');
    const audioRoute = resolved.outputDir
        ? new AudioRoute({
            outputDir: resolved.outputDir,
            trustedHosts: resolved.trustedHosts,
            connection,
            debug,
        })
        : undefined;
    // The Web host provides `webServer`. Older hosts exposed the same router as
    // `httpServer`; if neither exists (for example Electron over file://), the
    // plugin still works but returns no browserUrl.
    if (audioRoute) {
        const webServer = serviceOf(ctx, 'webServer');
        const legacy = webServer === undefined
            ? serviceOf(ctx, 'httpServer')
            : undefined;
        const server = webServer ?? legacy;
        // `getOrigin` may throw before the listener binds; then the tool output
        // stays relative-only rather than advertising a guessed host.
        const applyOrigin = (registrar) => {
            try {
                const origin = registrar.getOrigin?.();
                if (origin) {
                    audioRoute.setOrigin(origin);
                    debug('audio route origin advertised by the host');
                }
            }
            catch {
                // Intentionally ignored: no origin, no absolute link.
            }
        };
        if (server !== undefined) {
            applyOrigin(server);
            ctx.effect(() => audioRoute.register(server));
        }
        else {
            ctx.inject(['webServer'], (webCtx) => {
                const late = webCtx
                    .webServer;
                if (!late)
                    return;
                applyOrigin(late);
                webCtx.effect(() => audioRoute.register(late));
            });
        }
    }
    for (const tool of createTtsTools(resolved, { audioRoute, log: debug })) {
        ctx.tools.register(tool);
    }
}
//# sourceMappingURL=index.js.map