/**
 * The injectable `ctx.tts` service.
 *
 * The tool layer (`tts_generate`) and other plugins share one implementation:
 * cache lookup, bounded concurrency, chunked long text, fallback, and duration
 * measurement. The service deliberately returns structured audio facts
 * (duration, timing quality, engine, word boundaries) rather than a rendered
 * string, so a consumer plugin can build its own UX.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { measureMp3 } from './audio/mp3-duration.ts'
import { AUDIO_FORMAT, cacheKey, findCachedFile, outputFilePath, readCacheMetadata, writeCacheMetadata } from './cache.ts'
import { splitText } from './chunker.ts'
import { synthesizeChunked } from './chunked-tts.ts'
import { ConcurrencyLimiter } from './concurrency.ts'
import type { ResolvedConfig, TtsEngine } from './config.ts'
import { synthesize, type SpawnFunction, type SynthesizedAudio } from './edge-tts.ts'
import { isEdgeJsAvailable, synthesizeWithEdgeJs, type EdgeJsWord } from './engines/edge-js.ts'
import { ErrorCode, looksLikeThrottle, TtsError } from './errors.ts'
import { isFallbackEligible, runFallback, type FallbackAttempt } from './fallback.ts'
import { probeEndpoint, type ProbeConnector } from './probe.ts'
import { selfCheck, type SelfCheckResult } from './self-check.ts'
import { isSapiSupported, type SapiOptions } from './sapi-tts.ts'

/** What a caller can rely on without probing the network. */
export interface TtsCapabilities {
  /** Word-level timings, which only the pure-JS backend produces. */
  readonly wordBoundaries: boolean
  readonly formats: readonly ('mp3' | 'wav')[]
  /** A fully local engine exists (SAPI on Windows). */
  readonly offline: boolean
}

/** One synthesis request. */
export interface TtsRequest {
  text: string
  voice?: string
  rate?: string
  pitch?: string
  volume?: string
  signal?: AbortSignal
}

/** Audio actually produced on this host. */
export interface TtsAudioResult {
  kind: 'audio'
  filePath: string
  format: string
  durationMs: number
  timingQuality: 'exact' | 'estimated'
  engine: string
  fromCache: boolean
  /** Present when the backend reported word boundaries. */
  words?: { text: string; offsetMs: number; durationMs: number }[]
  attempts?: FallbackAttempt[]
}

/** No engine could produce a file; the caller should speak `text` itself. */
export interface TtsSpeechResult {
  kind: 'speechSynthesis'
  text: string
  voice: string
  rate: string
  reason: string
}

export type TtsResult = TtsAudioResult | TtsSpeechResult

/** Offline/online snapshot used by the voiceover capability matrix. */
export interface TtsProbeReport {
  host: string
  port: number
  reachable: boolean
  elapsedMs: number
  viaProxy: boolean
  offlineEngine: boolean
}

/** Environment report with exactly one suggested next action per problem. */
export interface TtsDoctorReport {
  selfCheck: SelfCheckResult
  probe: TtsProbeReport
  capabilities: TtsCapabilities
  suggestions: string[]
}

/** Injection points; production uses the real binaries and network. */
export interface TtsServiceDeps {
  spawnImpl?: SpawnFunction
  probeConnect?: ProbeConnector
  now?: () => Date
  limiter?: ConcurrencyLimiter
  /** Backoff sleep; injected so retry tests never wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Platform override for the SAPI chain (tests run on any OS). */
  platform?: NodeJS.Platform
  powershellBinary?: string
  ffmpegBinary?: string
  /** Injected SAPI implementation, so tests never launch PowerShell. */
  synthesizeSapiImpl?: (text: string, options: SapiOptions) => Promise<SynthesizedAudio>
  log?: (message: string) => void
}

/** Normalized arguments shared by every backend path. */
interface SynthesisInput {
  text: string
  voice: string
  rate: string
  pitch: string
  volume: string
  hash: string
  signal?: AbortSignal
}

/** Voice names are `<lang>-<REGION>-<Name>Neural` with an optional sub-region. */
const VOICE_PATTERN = /^[a-z]{2,3}-[A-Z]{2,3}(?:-[a-z0-9]+)?-[A-Za-z0-9]+Neural$/
const RATE_PATTERN = /^[+-]\d{1,3}%$/
const PITCH_PATTERN = /^[+-]\d{1,3}Hz$/
const VOLUME_PATTERN = /^[+-]\d{1,3}%$/

/** Average spoken characters per second for Chinese at `+0%`. */
const CHARS_PER_SECOND = 4.6

/** Backoff schedule for upstream throttling, tried before any fallback. */
const THROTTLE_BACKOFF_MS: readonly number[] = [2000, 6000, 18000]

/** Whether a failure is transient throttling worth backing off on. */
function isThrottleError(error: unknown): boolean {
  if (!(error instanceof TtsError)) return false
  return error.code === ErrorCode.UpstreamThrottled || looksLikeThrottle(error.detail)
}

/** Parse a signed percentage such as `+10%` into a speed factor. */
function rateFactor(rate: string): number {
  const match = /^([+-])(\d{1,3})%$/.exec(rate)
  if (match === null) return 1
  const magnitude = Number(match[2])
  return match[1] === '-' ? Math.max(0.1, 1 - magnitude / 100) : 1 + magnitude / 100
}

/** Coarse duration for engines that cannot report their own timing. */
function estimateDurationMs(text: string, rate: string): number {
  const seconds = text.length / (CHARS_PER_SECOND * rateFactor(rate))
  return Math.max(200, Math.round(seconds * 1000))
}

/** Read a finished audio file and report its real duration when frames parse. */
interface AudioFacts {
  bytes: number
  durationMs: number
  timingQuality: 'exact' | 'estimated'
}

async function readAudioFacts(filePath: string, text: string, rate: string): Promise<AudioFacts> {
  const buffer = await readFile(filePath)
  const info = measureMp3(buffer)
  if (info !== undefined) {
    return { bytes: buffer.length, durationMs: info.durationMs, timingQuality: 'exact' }
  }
  return { bytes: buffer.length, durationMs: estimateDurationMs(text, rate), timingQuality: 'estimated' }
}

/** Absolute end of the last reported word, used to advance a chunk offset. */
function wordsEndMs(words: readonly EdgeJsWord[]): number {
  let end = 0
  for (const word of words) end = Math.max(end, word.offsetMs + word.durationMs)
  return end
}

/**
 * Cache key for one synthesis. The published `cacheKey(text, voice, rate)` is
 * kept for compatibility, but prosody now participates: two calls that differ
 * only in pitch or volume must not share a file.
 */
function synthesisKey(text: string, voice: string, rate: string, pitch: string, volume: string): string {
  return cacheKey(`${text}\u0000pitch=${pitch}\u0000volume=${volume}`, voice, rate)
}

/** One service instance owns one capacity pool and one cache namespace. */
export class TtsService {
  private readonly config: ResolvedConfig
  private readonly deps: TtsServiceDeps
  private readonly limiter: ConcurrencyLimiter
  private readonly log: (message: string) => void
  private engineKind?: 'edge-js' | 'edge-py' | 'sapi'

  constructor(config: ResolvedConfig, deps: TtsServiceDeps = {}) {
    this.config = config
    this.deps = deps
    this.limiter =
      deps.limiter ??
      new ConcurrencyLimiter({
        maxConcurrent: config.maxConcurrent,
        queueSize: config.queueSize,
        queueTimeoutMs: config.queueTimeoutMs,
      })
    this.log = deps.log ?? (() => {})
  }

  /** Static capabilities; never touches the network. */
  get capabilities(): TtsCapabilities {
    return {
      // Conservative until the backend is resolved: only the pure-JS engine
      // reports word boundaries, and `auto` may land on the CLI backend.
      wordBoundaries: this.engineKind === 'edge-js',
      formats: ['mp3'],
      offline: isSapiSupported(),
    }
  }

  /** Synthesize, preferring a cache hit and falling back across engines. */
  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const text = request.text ?? ''
    if (text.trim().length === 0) {
      throw new TtsError(ErrorCode.EmptyText, 'The text to synthesize is empty.')
    }

    const voice = request.voice ?? this.config.defaultVoice
    const rate = request.rate ?? '+0%'
    const pitch = request.pitch ?? '+0Hz'
    const volume = request.volume ?? '+0%'

    if (!VOICE_PATTERN.test(voice)) {
      throw new TtsError(
        ErrorCode.InvalidVoice,
        `Invalid voice name: ${voice}`,
        'Use an Edge-TTS voice such as zh-CN-XiaoxiaoNeural.',
      )
    }
    if (!RATE_PATTERN.test(rate)) {
      throw new TtsError(ErrorCode.InvalidRate, `Invalid rate: ${rate}`, 'Use +0% or -10%.')
    }
    if (!PITCH_PATTERN.test(pitch)) {
      throw new TtsError(ErrorCode.InvalidPitch, `Invalid pitch: ${pitch}`, 'Use +0Hz or +10Hz.')
    }
    if (!VOLUME_PATTERN.test(volume)) {
      throw new TtsError(ErrorCode.InvalidVolume, `Invalid volume: ${volume}`, 'Use +0% or -20%.')
    }
    if (this.config.outputDir.length === 0) {
      throw new TtsError(
        ErrorCode.DshHomeNotSet,
        'No output directory is available.',
        'Set DSH_HOME or configure outputDir.',
      )
    }

    const hash = synthesisKey(text, voice, rate, pitch, volume)
    const cached = await findCachedFile(this.config.outputDir, hash)
    if (cached !== undefined) {
      const facts = await readAudioFacts(cached, text, rate)
      const metadata = await readCacheMetadata(cached)
      return {
        kind: 'audio',
        filePath: cached,
        format: AUDIO_FORMAT,
        durationMs: facts.durationMs,
        timingQuality: facts.timingQuality,
        engine: metadata?.engine ?? 'edge-tts',
        fromCache: true,
        ...(metadata?.words === undefined ? {} : { words: metadata.words }),
      }
    }

    return this.limiter.run(
      async () =>
        this.produce({
          text,
          voice,
          rate,
          pitch,
          volume,
          hash,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }),
      request.signal,
    )
  }

  /** Resolve the backend once per instance; `auto` prefers the pure-JS engine. */
  private async resolveEngine(): Promise<'edge-js' | 'edge-py' | 'sapi'> {
    if (this.engineKind !== undefined) return this.engineKind
    const configured = this.config.engine
    this.engineKind =
      configured === 'auto' ? ((await isEdgeJsAvailable()) ? 'edge-js' : 'edge-py') : configured
    return this.engineKind
  }

  /** Produce audio without consulting the cache. */
  private async produce(input: SynthesisInput): Promise<TtsResult> {
    const engine = await this.resolveEngine()
    // `engine=sapi` must not silently run the Edge CLI: the local engine is a
    // different code path with different failure modes.
    if (engine === 'sapi') return this.produceWithSapi(input)
    const attempt = (): Promise<TtsResult> =>
      engine === 'edge-js' ? this.produceWithEdgeJs(input) : this.produceWithCli(input)

    // Throttling is transient: back off and retry the good engine before
    // falling back. A fallback would hide the load problem and produce worse
    // audio, and a 429 from Edge usually clears within seconds.
    let lastError: unknown
    for (let index = 0; index <= THROTTLE_BACKOFF_MS.length; index += 1) {
      try {
        return await attempt()
      } catch (error) {
        lastError = error
        const delay = THROTTLE_BACKOFF_MS[index]
        if (delay === undefined || !isThrottleError(error)) break
        this.log(`upstream throttled; retrying in ${delay}ms`)
        await this.sleep(delay, input.signal)
      }
    }
    return this.fallbackChain(input, lastError)
  }

  /** Local engine: no network, no Edge CLI, straight to the SAPI chain. */
  private async produceWithSapi(input: SynthesisInput): Promise<TtsResult> {
    const order = this.config.fallbackOrder.filter((name) => name === 'sapi')
    if (order.length === 0) {
      throw new TtsError(
        ErrorCode.EngineUnavailable,
        'engine=sapi, but "sapi" is not in fallbackOrder.',
        'Add "sapi" to fallbackOrder, or set engine to auto.',
      )
    }

    const outcome = await runFallback(
      {
        text: input.text,
        rate: input.rate,
        outputDir: this.config.outputDir,
        hash: input.hash,
        timeoutMs: this.config.timeoutMs,
        fallbackOrder: order,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      {
        ...(this.deps.platform === undefined ? {} : { platform: this.deps.platform }),
        ...(this.deps.spawnImpl === undefined ? {} : { spawnImpl: this.deps.spawnImpl }),
        ...(this.deps.powershellBinary === undefined ? {} : { powershellBinary: this.deps.powershellBinary }),
        ...(this.deps.ffmpegBinary === undefined ? {} : { ffmpegBinary: this.deps.ffmpegBinary }),
        ...(this.deps.synthesizeSapiImpl === undefined ? {} : { synthesizeSapiImpl: this.deps.synthesizeSapiImpl }),
      },
    )

    if (outcome.kind === 'audio') {
      return this.finish(outcome.audio, { ...input, engine: 'sapi' }, { attempts: outcome.attempts })
    }
    return {
      kind: 'speechSynthesis',
      text: input.text,
      voice: input.voice,
      rate: input.rate,
      reason: outcome.attempts.map((attempt) => `${attempt.engine}: ${attempt.reason}`).join('; '),
    }
  }
  /** Wait between throttle retries; injected in tests so they never sleep. */
  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.deps.sleep !== undefined) {
      await this.deps.sleep(ms, signal)
      return
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new TtsError(ErrorCode.Aborted, 'Synthesis was aborted during a throttle backoff.'))
        },
        { once: true },
      )
    })
  }

  /** CLI backend: one process per chunk, no word boundaries. */
  private async produceWithCli(input: SynthesisInput): Promise<TtsResult> {
    const { text, voice, rate, pitch, volume, hash, signal } = input
    const chunked = this.config.chunkingEnabled && text.length > this.config.chunkSize

    const audio = chunked
      ? await synthesizeChunked(text, {
          voice,
          rate,
          pitch,
          volume,
          proxy: this.config.proxy,
          binary: this.config.edgeTtsBinary,
          outputDir: this.config.outputDir,
          hash,
          timeoutMs: this.config.timeoutMs,
          totalTimeoutMs: this.config.totalTimeoutMs,
          chunkSize: this.config.chunkSize,
          signal,
          spawnImpl: this.deps.spawnImpl,
          now: this.deps.now?.(),
        })
      : await synthesize(text, {
          voice,
          rate,
          pitch,
          volume,
          proxy: this.config.proxy,
          binary: this.config.edgeTtsBinary,
          outputDir: this.config.outputDir,
          hash,
          timeoutMs: this.config.timeoutMs,
          signal,
          spawnImpl: this.deps.spawnImpl,
          now: this.deps.now?.(),
        })
    return this.finish(audio, { text, voice, rate, pitch, volume, engine: 'edge-py' })
  }

  /** Pure-JS backend: one connection per chunk, word boundaries preserved. */
  private async produceWithEdgeJs(input: SynthesisInput): Promise<TtsResult> {
    const { text, voice, rate, pitch, volume, hash, signal } = input
    const chunks =
      this.config.chunkingEnabled && text.length > this.config.chunkSize
        ? splitText(text, this.config.chunkSize)
        : [text]

    const buffers: Buffer[] = []
    const words: EdgeJsWord[] = []
    let offsetMs = 0

    for (const chunk of chunks) {
      if (signal?.aborted) {
        throw new TtsError(ErrorCode.Aborted, 'Synthesis was aborted between chunks.')
      }
      const result = await synthesizeWithEdgeJs({
        text: chunk,
        voice,
        rate,
        pitch,
        volume,
        ...(this.config.proxy === undefined ? {} : { proxy: this.config.proxy }),
        timeoutMs: this.config.timeoutMs,
      })
      buffers.push(result.audio)
      for (const word of result.words) {
        words.push({ ...word, offsetMs: word.offsetMs + offsetMs })
      }
      const measured = measureMp3(result.audio)
      offsetMs += measured?.durationMs ?? wordsEndMs(result.words)
    }

    const audio = Buffer.concat(buffers)
    const filePath = outputFilePath(this.config.outputDir, hash, this.deps.now?.())
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, audio)

    return this.finish(
      { filePath, format: AUDIO_FORMAT },
      { text, voice, rate, pitch, volume, engine: 'edge-js' },
      {
        ...(words.length === 0 ? {} : { words }),
        ...(offsetMs > 0 ? { durationMs: offsetMs, timingQuality: 'exact' as const } : {}),
      },
    )
  }
  /** Try the configured chain after the primary backend failed. */
  private async fallbackChain(input: SynthesisInput, error: unknown): Promise<TtsResult> {
    if (!this.config.fallbackEnabled || !isFallbackEligible(error)) throw error
    this.log(`primary backend failed, trying the fallback chain: ${String(error)}`)

    const outcome = await runFallback(
      {
        text: input.text,
        rate: input.rate,
        outputDir: this.config.outputDir,
        hash: input.hash,
        timeoutMs: this.config.timeoutMs,
        fallbackOrder: this.config.fallbackOrder as readonly TtsEngine[],
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        primaryError: error,
      },
      {
        ...(this.deps.platform === undefined ? {} : { platform: this.deps.platform }),
        ...(this.deps.spawnImpl === undefined ? {} : { spawnImpl: this.deps.spawnImpl }),
        ...(this.deps.powershellBinary === undefined ? {} : { powershellBinary: this.deps.powershellBinary }),
        ...(this.deps.ffmpegBinary === undefined ? {} : { ffmpegBinary: this.deps.ffmpegBinary }),
        ...(this.deps.synthesizeSapiImpl === undefined ? {} : { synthesizeSapiImpl: this.deps.synthesizeSapiImpl }),
      },
    )

    if (outcome.kind === 'audio') {
      return this.finish(outcome.audio, { ...input, engine: outcome.engine }, { attempts: outcome.attempts })
    }
    return {
      kind: 'speechSynthesis',
      text: input.text,
      voice: input.voice,
      rate: input.rate,
      reason: outcome.attempts.map((attempt) => `${attempt.engine}: ${attempt.reason}`).join('; '),
    }
  }

  /**
   * Measure the produced file and record which engine wrote it. `override`
   * carries facts the backend already knows (word boundaries, exact duration).
   */
  private async finish(
    audio: SynthesizedAudio,
    identity: { text: string; voice: string; rate: string; pitch: string; volume: string; engine: string },
    override: {
      words?: EdgeJsWord[]
      durationMs?: number
      timingQuality?: 'exact' | 'estimated'
      attempts?: FallbackAttempt[]
    } = {},
  ): Promise<TtsAudioResult> {
    const facts = await readAudioFacts(audio.filePath, identity.text, identity.rate)
    await writeCacheMetadata(audio.filePath, {
      engine: identity.engine,
      voice: identity.voice,
      rate: identity.rate,
      pitch: identity.pitch,
      volume: identity.volume,
      createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
      ...(override.words === undefined ? {} : { words: override.words }),
    })
    return {
      kind: 'audio',
      filePath: audio.filePath,
      format: audio.format,
      durationMs: override.durationMs ?? facts.durationMs,
      timingQuality: override.timingQuality ?? facts.timingQuality,
      engine: identity.engine,
      fromCache: false,
      ...(override.words === undefined ? {} : { words: override.words }),
      ...(override.attempts === undefined ? {} : { attempts: override.attempts }),
    }
  }

  /** One TCP probe; never synthesizes and never consumes service quota. */
  async probe(): Promise<TtsProbeReport> {
    const result = await probeEndpoint({ connectImpl: this.deps.probeConnect })
    return {
      host: result.host,
      port: result.port,
      reachable: result.reachable,
      elapsedMs: result.elapsedMs,
      viaProxy: this.config.proxy !== undefined,
      offlineEngine: isSapiSupported(),
    }
  }

  /** Self-check plus probe plus one actionable suggestion per failure. */
  async doctor(): Promise<TtsDoctorReport> {
    const check = await selfCheck({ config: this.config, spawnImpl: this.deps.spawnImpl })
    const probe = await this.probe()
    const suggestions: string[] = []

    if (!check.edgeTtsAvailable) {
      suggestions.push('Install Edge-TTS (`pip install edge-tts`) or point `edgeTtsBinary` at the executable.')
    }
    if (!probe.reachable) {
      suggestions.push(
        probe.viaProxy
          ? 'The proxy is configured but the endpoint is still unreachable: verify the proxy allows WSS to speech.platform.bing.com.'
          : 'The endpoint is unreachable: configure `proxy`, or rely on the offline engine (`sapi` on Windows).',
      )
    }
    if (!check.outputDirWritable) {
      suggestions.push('The output directory is not writable: change `outputDir` or fix its permissions.')
    }
    if (suggestions.length === 0) suggestions.push('No action needed.')

    return { selfCheck: check, probe, capabilities: this.capabilities, suggestions }
  }
}
