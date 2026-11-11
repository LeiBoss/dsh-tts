/**
 * The injectable `ctx.tts` service.
 *
 * The tool layer (`tts_generate`) and other plugins share one implementation:
 * cache lookup, single-flight-free concurrency, chunked long text, fallback,
 * and duration measurement. The service deliberately returns structured audio
 * facts (duration, timing quality, engine) rather than a rendered string, so a
 * consumer plugin can build its own UX.
 */
import { readFile } from 'node:fs/promises'
import { measureMp3 } from './audio/mp3-duration.ts'
import { AUDIO_FORMAT, cacheKey, findCachedFile, readCacheMetadata, writeCacheMetadata } from './cache.ts'
import { synthesizeChunked } from './chunked-tts.ts'
import { ConcurrencyLimiter } from './concurrency.ts'
import type { ResolvedConfig, TtsEngine } from './config.ts'
import { synthesize, type SpawnFunction, type SynthesizedAudio } from './edge-tts.ts'
import { ErrorCode, TtsError } from './errors.ts'
import { isFallbackEligible, runFallback, type FallbackAttempt } from './fallback.ts'
import { probeEndpoint, type ProbeConnector } from './probe.ts'
import { selfCheck, type SelfCheckResult } from './self-check.ts'
import { isSapiSupported } from './sapi-tts.ts'

/** What a caller can rely on without probing the network. */
export interface TtsCapabilities {
  /** Word-level timings are not produced by the Edge-TTS CLIs. */
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
  log?: (message: string) => void
}

/** Voice names are `<lang>-<REGION>-<Name>Neural` with an optional sub-region. */
const VOICE_PATTERN = /^[a-z]{2,3}-[A-Z]{2,3}(?:-[a-z0-9]+)?-[A-Za-z0-9]+Neural$/
const RATE_PATTERN = /^[+-]\d{1,3}%$/
const PITCH_PATTERN = /^[+-]\d{1,3}Hz$/
const VOLUME_PATTERN = /^[+-]\d{1,3}%$/

/** Average spoken characters per second for Chinese at `+0%`. */
const CHARS_PER_SECOND = 4.6

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

/** Read a finished MP3 and report its real duration when the frames parse. */
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
      wordBoundaries: false,
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
      }
    }

    return this.limiter.run(async () => this.produce({ text, voice, rate, pitch, volume, hash, signal: request.signal }), request.signal)
  }

  /** Produce audio without consulting the cache. */
  private async produce(input: {
    text: string
    voice: string
    rate: string
    pitch: string
    volume: string
    hash: string
    signal?: AbortSignal
  }): Promise<TtsResult> {
    const { text, voice, rate, pitch, volume, hash, signal } = input
    const chunked = this.config.chunkingEnabled && text.length > this.config.chunkSize

    try {
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
      return this.finish(audio, text, voice, rate, pitch, volume, 'edge-tts')
    } catch (error) {
      if (!this.config.fallbackEnabled || !isFallbackEligible(error)) throw error
      this.log(`edge-tts failed, trying the fallback chain: ${String(error)}`)
      const outcome = await runFallback({
        text,
        rate,
        outputDir: this.config.outputDir,
        hash,
        timeoutMs: this.config.timeoutMs,
        fallbackOrder: this.config.fallbackOrder as readonly TtsEngine[],
        signal,
        primaryError: error,
      })
      if (outcome.kind === 'audio') {
        return this.finish(outcome.audio, text, voice, rate, pitch, volume, outcome.engine, outcome.attempts)
      }
      return {
        kind: 'speechSynthesis',
        text,
        voice,
        rate,
        reason: outcome.attempts.map((attempt) => `${attempt.engine}: ${attempt.reason}`).join('; '),
      }
    }
  }

  /** Measure the produced file and record which engine wrote it. */
  private async finish(
    audio: SynthesizedAudio,
    text: string,
    voice: string,
    rate: string,
    pitch: string,
    volume: string,
    engine: string,
    attempts?: FallbackAttempt[],
  ): Promise<TtsAudioResult> {
    const facts = await readAudioFacts(audio.filePath, text, rate)
    await writeCacheMetadata(audio.filePath, {
      engine,
      voice,
      rate,
      pitch,
      volume,
      createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
    })
    return {
      kind: 'audio',
      filePath: audio.filePath,
      format: audio.format,
      durationMs: facts.durationMs,
      timingQuality: facts.timingQuality,
      engine,
      fromCache: false,
      attempts,
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
