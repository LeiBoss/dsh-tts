/**
 * Pure-JS synthesis backend over `node-edge-tts`.
 *
 * Why this exists: the CLI backend requires Python, which is the single largest
 * install obstacle for a DSH plugin. This adapter removes it, and it also
 * returns word boundaries, which upgrades subtitle timing from "estimated" to
 * "exact".
 *
 * The module is an optional dependency: a host without it still gets the CLI
 * path, so the import is dynamic and the loader is injectable for tests.
 */
import { ErrorCode, TtsError } from '../errors.ts'

/** One word boundary as Edge reports it. */
export interface EdgeJsWord {
  text: string
  offsetMs: number
  durationMs: number
}

/** One synthesis request. */
export interface EdgeJsRequest {
  text: string
  voice: string
  /** `+0%` style, passed through to SSML. */
  rate?: string
  /** `+0Hz` style. */
  pitch?: string
  /** `+0%` style. */
  volume?: string
  /** Forwarded to the WSS handshake; Edge ignores HTTPS_PROXY. */
  proxy?: string
  timeoutMs?: number
}

/** Audio plus the timing metadata Edge reports for it. */
export interface EdgeJsResult {
  audio: Buffer
  words: EdgeJsWord[]
}

/** The shape `node-edge-tts` exposes; kept structural so the version can drift. */
interface EdgeJsInstance {
  streamAudio(text: string): AsyncGenerator<Buffer | { part: string; start: number; end: number }>
  ttsPromise(text: string, audioPath: string): Promise<void>
}

interface EdgeJsModule {
  EdgeTTS: new (config: Record<string, unknown>) => EdgeJsInstance
}

let loader: (() => Promise<unknown>) | undefined

/** Replace the module loader. Tests inject a fake; production clears it. */
export function setEdgeJsLoader(impl: (() => Promise<unknown>) | undefined): void {
  loader = impl
}

/** Load the optional dependency, or report that it is not installed. */
export async function loadEdgeJsModule(): Promise<EdgeJsModule | undefined> {
  const load = loader ?? ((): Promise<unknown> => import('node-edge-tts'))
  try {
    const loaded = (await load()) as Partial<EdgeJsModule>
    return typeof loaded.EdgeTTS === 'function' ? (loaded as EdgeJsModule) : undefined
  } catch {
    return undefined
  }
}

/** Whether the pure-JS backend can be used in this process. */
export async function isEdgeJsAvailable(): Promise<boolean> {
  return (await loadEdgeJsModule()) !== undefined
}

/** Edge-TTS voices are `<lang>-<REGION>-<Name>Neural`; the language is the prefix. */
function languageOf(voice: string): string {
  const parts = voice.split('-')
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : 'zh-CN'
}

/** Classify a backend failure as protocol drift when the handshake is rejected. */
function asTtsError(error: unknown): TtsError {
  const detail = error instanceof Error ? error.message : String(error)
  const drift = /403|handshake|sec-ms-gec|invalid response status/i.test(detail)
  return new TtsError(
    ErrorCode.EdgeTtsFailed,
    `The pure-JS Edge backend failed: ${detail}`,
    drift
      ? 'The Edge handshake changed. Upgrade `node-edge-tts`, or pin the CLI backend with engine=edge-py.'
      : 'Check the network and the configured proxy; run tts_probe_network to test reachability.',
    { cause: error, protocolDrift: drift },
  )
}

/**
 * Synthesize once and collect audio plus word boundaries. Word offsets are
 * absolute from the start of this call's audio, which is what callers need to
 * shift per chunk.
 */
export async function synthesizeWithEdgeJs(request: EdgeJsRequest): Promise<EdgeJsResult> {
  const module = await loadEdgeJsModule()
  if (module === undefined) {
    throw new TtsError(
      ErrorCode.EngineUnavailable,
      'The pure-JS Edge backend is not installed (node-edge-tts is missing).',
      'Install it with `npm i node-edge-tts`, or set engine=edge-py to use the CLI backend.',
    )
  }

  const instance = new module.EdgeTTS({
    voice: request.voice,
    lang: languageOf(request.voice),
    outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    // `saveSubtitles` gates *parsing* of the WordBoundary metadata, not file
    // writes: `streamAudio()` yields the boundaries and never touches disk.
    // Without it the generator yields audio only and timing stays estimated.
    saveSubtitles: true,
    ...(request.proxy === undefined ? {} : { proxy: request.proxy }),
    ...(request.rate === undefined ? {} : { rate: request.rate }),
    ...(request.pitch === undefined ? {} : { pitch: request.pitch }),
    ...(request.volume === undefined ? {} : { volume: request.volume }),
    ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
  })

  const chunks: Buffer[] = []
  const words: EdgeJsWord[] = []

  try {
    for await (const item of instance.streamAudio(request.text)) {
      if (Buffer.isBuffer(item)) {
        chunks.push(item)
        continue
      }
      if (typeof item === 'object' && item !== null && 'part' in item) {
        const boundary = item as { part: string; start: number; end: number }
        const durationMs = Math.max(0, boundary.end - boundary.start)
        if (boundary.part.length > 0) {
          words.push({ text: boundary.part, offsetMs: boundary.start, durationMs })
        }
      }
    }
  } catch (error) {
    throw asTtsError(error)
  }

  if (chunks.length === 0) {
    throw new TtsError(
      ErrorCode.EmptyAudio,
      'The pure-JS Edge backend returned no audio bytes.',
      'Retry; if it persists, run tts_self_check and tts_probe_network.',
    )
  }

  return { audio: Buffer.concat(chunks), words }
}
