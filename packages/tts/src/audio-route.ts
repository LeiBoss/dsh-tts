/**
 * Same-origin HTTP route for generated audio.
 *
 * The DSH Web host owns the HTTP server; this module only registers a prefix
 * route on the host `webServer` service (never listens on its own port). URLs
 * carry an HMAC-signed, expiring token that names a file *relative to the
 * configured output directory*, so a token can never be turned into an
 * arbitrary path read. Range requests are answered with `206 Partial Content`,
 * which is what lets an `<audio>` element seek inside a long file.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

/** Path prefix owned by this plugin. The signed token is the next segment. */
export const AUDIO_ROUTE_PREFIX = '/dsh-tts/audio'

/** Signed URLs stay valid for six hours by default. */
export const DEFAULT_URL_TTL_MS = 6 * 60 * 60 * 1000

/** Structural view of a DSH web route registration. */
export interface RegisterableRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** Structural view of the host `webServer` service; only `register` is used. */
export interface HttpRouteRegistrar {
  register(route: RegisterableRoute): () => void
  /** Advertised bind host, when the host exposes it. */
  host?: string
  /** Actual listening port, when the host exposes it. */
  port?: number
  /** Scheme advertised by the host, when available. */
  protocol?: string
  /** Origin advertised by the host, when available. */
  getOrigin?(): string | undefined
}

/**
 * Host-provided trust fence. DSH 0.2.2 exposes this as `ctx.connection`;
 * `admit` is intentionally not used so links remain shareable to a browser
 * that has no DSH session cookie.
 */
export interface ConnectionFence {
  requestRejection?(input: {
    headers: Record<string, string | string[] | undefined>
  }): 401 | 403 | undefined
  allowsRemoteAuthorities?: boolean
}

/** Name of the persisted HMAC secret inside the output directory. */
export const SECRET_FILE_NAME = '.audio-route-secret'

/** Resolves a local audio path to a browser-openable URL, when routable. */
export interface AudioUrlProvider {
  urlFor(filePath: string): string | undefined
  /** Absolute URL for human-readable output; absent host origin yields `undefined`. */
  absoluteUrlFor?(filePath: string): string | undefined
}

export interface AudioRouteOptions {
  /** Ledger root; tokens may only name files beneath it. */
  outputDir: string
  /** Token lifetime in milliseconds. */
  ttlMs?: number
  /** Override the per-instance HMAC secret (tests only). */
  secret?: Buffer
  /** Path of the persisted secret; defaults to `<outputDir>/.audio-route-secret`. */
  secretPath?: string
  /** Injectable clock in epoch milliseconds. */
  now?: () => number
  /** Hostnames allowed in `Host`; unset means any hostname (port still checked). */
  allowedHosts?: readonly string[]
  /** Expected listen port; mismatched `Host` ports are rejected. */
  expectedPort?: number
  /** Debug sink for origin rejections; receives no token or path. */
  debug?: (message: string) => void
  /** Extra trusted Host names (reverse proxies); disables port pinning. */
  trustedHosts?: readonly string[]
  /** Host trust fence, when DSH exposes `ctx.connection`. */
  connection?: ConnectionFence
}

/** Longest suffix accepted by {@link parseRange}; keeps the parser simple. */
const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/

function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | undefined {
  const match = RANGE_PATTERN.exec(header.trim())
  if (!match) return undefined

  const startRaw = match[1] ?? ''
  const endRaw = match[2] ?? ''
  if (startRaw === '' && endRaw === '') return undefined

  if (startRaw === '') {
    const suffix = Number(endRaw)
    if (!Number.isInteger(suffix) || suffix <= 0) return undefined
    const start = Math.max(0, size - suffix)
    return { start, end: size - 1 }
  }

  const start = Number(startRaw)
  if (!Number.isInteger(start) || start < 0 || start >= size) return undefined

  const end = endRaw === '' ? size - 1 : Number(endRaw)
  if (!Number.isInteger(end) || end < start) return undefined
  return { start, end: Math.min(end, size - 1) }
}

function sendText(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  const body = Buffer.from(message, 'utf8')
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Content-Length', String(body.length))
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value)
  }
  res.end(body)
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Hostnames trusted by default for a bind address. Wildcard binds accept any
 * hostname (the port and same-origin checks still apply), because the public
 * hostname is not knowable from `0.0.0.0`.
 */
function defaultAllowedHosts(host: string): string[] {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (normalized === '0.0.0.0' || normalized === '::' || normalized === '*') {
    return []
  }
  return [...new Set(['localhost', '127.0.0.1', '::1', normalized])]
}

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return true
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
  return (
    normalized === '' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized.startsWith('127.')
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Load the persisted HMAC secret, creating it on first use. Persistence keeps
 * previously issued URLs valid across plugin reloads. Any filesystem failure
 * degrades to an in-memory secret instead of failing plugin load.
 */
function loadOrCreateSecret(
  path: string,
  debug?: (message: string) => void,
): Buffer {
  try {
    const hex = readFileSync(path, 'utf8').trim()
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex')
    debug?.('audio route secret was malformed; rotating')
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined
    if (code !== 'ENOENT') {
      debug?.(`audio route secret read failed: ${describe(error)}`)
    }
  }

  const secret = randomBytes(32)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, secret.toString('hex'), { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(path, 0o600)
    } catch {
      // Windows does not implement POSIX modes; best effort only.
    }
  } catch (error) {
    debug?.(`audio route secret persistence failed: ${describe(error)}`)
  }
  return secret
}

/**
 * Owns the signed-token format and the HTTP handler. One instance per plugin
 * load; `register` binds it to the host router and returns a disposer.
 */
export class AudioRoute implements AudioUrlProvider {
  private readonly root: string
  private readonly ttlMs: number
  private readonly secret: Buffer
  private readonly now: () => number
  private readonly debug?: (message: string) => void
  private readonly trustedHosts: string[]
  private readonly connection?: ConnectionFence
  private allowedHosts?: readonly string[]
  private expectedPort?: number
  private skipPortCheck = false
  private active = false
  private origin?: string

  constructor(options: AudioRouteOptions) {
    this.root = resolve(options.outputDir)
    this.ttlMs = options.ttlMs ?? DEFAULT_URL_TTL_MS
    this.now = options.now ?? Date.now
    this.debug = options.debug
    this.connection = options.connection
    this.trustedHosts = (options.trustedHosts ?? [])
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0)
    this.allowedHosts = options.allowedHosts
    this.expectedPort = options.expectedPort
    this.secret =
      options.secret ??
      loadOrCreateSecret(
        options.secretPath ?? join(this.root, SECRET_FILE_NAME),
        this.debug,
      )
  }

  /** True once the host router accepted the route. */
  get registered(): boolean {
    return this.active
  }

  /** Register on the DSH host router; the disposer unregisters and disables URLs. */
  register(server: HttpRouteRegistrar): () => void {
    const remote = this.connection?.allowsRemoteAuthorities === true
    if (this.trustedHosts.length > 0) {
      // A configured whitelist implies a proxy that may rewrite the port.
      this.allowedHosts = this.trustedHosts
      this.skipPortCheck = true
    } else if (remote && !isLoopbackHost(server.host)) {
      this.allowedHosts = []
      this.skipPortCheck = true
      this.debug?.('audio route relaxed Host checks for remote authorities')
    } else if (this.expectedPort === undefined) {
      this.expectedPort = server.port
      if (this.allowedHosts === undefined && server.host) {
        this.allowedHosts = defaultAllowedHosts(server.host)
      }
    }

    const dispose = server.register({
      kind: 'prefix',
      path: AUDIO_ROUTE_PREFIX,
      handler: (req, res) => this.handle(req, res),
    })
    this.active = true

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.active = false
      dispose()
    }
  }

  /**
   * Browser-openable same-origin URL, or `undefined` when the route is not
   * registered or the file is outside the output directory / not an MP3.
   */
  urlFor(filePath: string): string | undefined {
    if (!this.active) return undefined

    const relativePath = this.relativePath(filePath)
    if (relativePath === undefined) return undefined

    const expires = Math.ceil((this.now() + this.ttlMs) / 1000)
    const encoded = Buffer.from(relativePath, 'utf8').toString('base64url')
    const payload = `${expires}.${encoded}`
    return `${AUDIO_ROUTE_PREFIX}/${payload}.${this.sign(payload)}`
  }

  /** Remember the host-advertised origin, trimmed of any trailing slash. */
  setOrigin(origin: string): void {
    const trimmed = origin.trim().replace(/\/+$/, '')
    if (trimmed.length > 0) this.origin = trimmed
  }

  /**
   * Absolute playback URL for humans, or `undefined` when the host did not
   * advertise an origin. Never guesses a host: callers fall back to the
   * relative {@link urlFor} result instead.
   */
  absoluteUrlFor(filePath: string): string | undefined {
    const relative = this.urlFor(filePath)
    if (relative === undefined || this.origin === undefined) return undefined
    return `${this.origin}${relative}`
  }

  /** Serve one request. Exported behaviour is exercised directly by tests. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' })
      return
    }

    const rejection = this.connection?.requestRejection?.({
      headers: req.headers,
    })
    if (rejection === 401 || rejection === 403) {
      this.debug?.(`audio route rejected by host connection: ${rejection}`)
      sendText(
        res,
        rejection,
        rejection === 401 ? 'Unauthorized' : 'Forbidden',
      )
      return
    }

    const originRejection = this.checkOrigin(req)
    if (originRejection !== undefined) {
      this.debug?.(`audio route rejected: ${originRejection}`)
      sendText(res, 403, 'Forbidden')
      return
    }

    const rawUrl = req.url ?? ''
    const query = rawUrl.indexOf('?')
    const pathname = query === -1 ? rawUrl : rawUrl.slice(0, query)
    if (!pathname.startsWith(`${AUDIO_ROUTE_PREFIX}/`)) {
      sendText(res, 404, 'Not Found')
      return
    }

    let token: string
    try {
      token = decodeURIComponent(pathname.slice(AUDIO_ROUTE_PREFIX.length + 1))
    } catch {
      sendText(res, 404, 'Not Found')
      return
    }

    const target = this.verify(token)
    if (target === undefined) {
      sendText(res, 404, 'Not Found')
      return
    }

    let size: number
    try {
      const info = await stat(target)
      if (!info.isFile() || info.size <= 0) {
        sendText(res, 404, 'Not Found')
        return
      }
      size = info.size
    } catch {
      sendText(res, 404, 'Not Found')
      return
    }

    const header = req.headers.range
    const rangeHeader = Array.isArray(header) ? header[0] : header
    let range: { start: number; end: number } | undefined
    if (rangeHeader !== undefined) {
      range = parseRange(rangeHeader, size)
      if (range === undefined) {
        sendText(res, 416, 'Range Not Satisfiable', {
          'Content-Range': `bytes */${size}`,
        })
        return
      }
    }

    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', 'private, max-age=300')

    if (range === undefined) {
      res.statusCode = 200
      res.setHeader('Content-Length', String(size))
    } else {
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
      res.setHeader('Content-Length', String(range.end - range.start + 1))
    }

    if (method === 'HEAD') {
      res.end()
      return
    }

    const stream = createReadStream(target, range)
    stream.on('error', () => {
      res.destroy()
    })
    stream.pipe(res)
  }

  /** HMAC-SHA-256 over the payload, base64url-encoded. */
  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload, 'utf8').digest('base64url')
  }

  /**
   * Same-origin fence in front of the token check. Returns a reason when the
   * request must be rejected. Missing headers are tolerated only when neither
   * a port nor an Origin pins the request to a browser origin, which keeps
   * non-browser callers working while DSH provides no trust-fence API.
   */
  private checkOrigin(req: IncomingMessage): string | undefined {
    const host = headerValue(req.headers.host)
    const origin = headerValue(req.headers.origin)

    if (host === undefined) {
      return origin === undefined ? undefined : 'origin present without host'
    }

    let parsed: URL
    try {
      parsed = new URL(`http://${host}`)
    } catch {
      return 'malformed host header'
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (
      this.allowedHosts !== undefined &&
      this.allowedHosts.length > 0 &&
      !this.allowedHosts.includes(hostname)
    ) {
      return `untrusted host ${hostname}`
    }

    if (this.expectedPort !== undefined && !this.skipPortCheck) {
      const port =
        parsed.port === ''
          ? parsed.protocol === 'https:'
            ? 443
            : 80
          : Number(parsed.port)
      if (port !== this.expectedPort) {
        return `host port ${port} does not match ${this.expectedPort}`
      }
    }

    if (origin !== undefined) {
      let parsedOrigin: URL
      try {
        parsedOrigin = new URL(origin)
      } catch {
        return 'malformed origin header'
      }
      if (
        parsedOrigin.protocol !== 'http:' &&
        parsedOrigin.protocol !== 'https:'
      ) {
        return `unsupported origin scheme ${parsedOrigin.protocol}`
      }
      if (parsedOrigin.host.toLowerCase() !== host.toLowerCase()) {
        return 'origin and host differ'
      }
    }

    return undefined
  }

  /** Path relative to the ledger root, using `/` on every platform. */
  private relativePath(filePath: string): string | undefined {
    if (extname(filePath).toLowerCase() !== '.mp3') return undefined
    const target = resolve(filePath)
    const rel = relative(this.root, target)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
    return rel.split('\\').join('/')
  }

  /** Verify signature + expiry, then confine the decoded path to the root. */
  private verify(token: string): string | undefined {
    const segments = token.split('.')
    if (segments.length !== 3) return undefined

    const expiresRaw = segments[0] ?? ''
    const encoded = segments[1] ?? ''
    const signature = segments[2] ?? ''
    if (!expiresRaw || !encoded || !signature) return undefined

    const expected = Buffer.from(this.sign(`${expiresRaw}.${encoded}`), 'utf8')
    const actual = Buffer.from(signature, 'utf8')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return undefined
    }

    const expires = Number(expiresRaw)
    if (!Number.isFinite(expires) || this.now() > expires * 1000) return undefined

    const rel = Buffer.from(encoded, 'base64url').toString('utf8')
    if (rel.length === 0 || rel.includes('\u0000')) return undefined

    const target = resolve(this.root, rel)
    const check = relative(this.root, target)
    if (check === '' || check.startsWith('..') || isAbsolute(check)) return undefined
    if (extname(target).toLowerCase() !== '.mp3') return undefined
    return target
  }
}
