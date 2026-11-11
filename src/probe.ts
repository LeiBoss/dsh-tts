/**
 * Optional network diagnostic: a single TCP connection to the Edge-TTS
 * endpoint. It never synthesizes audio and never performs a WebSocket
 * handshake, so it is cheap and does not consume service quota.
 *
 * This deliberately lives outside `tts_self_check`, which must stay offline.
 */
import { connect, type Socket } from 'node:net'

/** The only endpoint shipped by edge-tts 7.3.1. */
export const PROBE_HOST = 'speech.platform.bing.com'
export const PROBE_PORT = 443

/** Default and hard upper bound for one probe. */
export const DEFAULT_PROBE_TIMEOUT_MS = 1_500
export const MAX_PROBE_TIMEOUT_MS = 5_000

export type ProbeConnector = (options: { host: string; port: number }) => Socket

export interface ProbeOptions {
  /** Defaults to {@link PROBE_HOST}; tests use a local listener. */
  host?: string
  /** Defaults to {@link PROBE_PORT}. */
  port?: number
  /** Clamped to [1, {@link MAX_PROBE_TIMEOUT_MS}]; defaults to 1500. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Injected connector, so tests never touch the real network. */
  connectImpl?: ProbeConnector
}

export interface ProbeResult {
  host: string
  port: number
  /** True only when the TCP handshake completed before the timeout. */
  reachable: boolean
  elapsedMs: number
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_PROBE_TIMEOUT_MS
  }
  return Math.max(1, Math.min(Math.trunc(value), MAX_PROBE_TIMEOUT_MS))
}

/**
 * Attempt one TCP connection and report reachability. Failures — timeouts,
 * refusals, DNS errors — resolve with `reachable: false` instead of throwing.
 */
export function probeEndpoint(options: ProbeOptions = {}): Promise<ProbeResult> {
  const host = options.host ?? PROBE_HOST
  const port = options.port ?? PROBE_PORT
  const timeoutMs = clampTimeout(options.timeoutMs)
  const connector = options.connectImpl ?? ((address) => connect(address))
  const startedAt = Date.now()

  return new Promise<ProbeResult>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let socket: Socket | undefined

    const finish = (reachable: boolean): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      socket?.destroy()
      resolve({ host, port, reachable, elapsedMs: Date.now() - startedAt })
    }
    const onAbort = (): void => finish(false)

    try {
      socket = connector({ host, port })
    } catch {
      finish(false)
      return
    }

    timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))

    if (options.signal?.aborted) {
      finish(false)
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
  })
}
