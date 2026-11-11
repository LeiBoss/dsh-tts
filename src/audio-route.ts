/**
 * Same-origin HTTP route for generated audio.
 *
 * The DSH Web host owns the HTTP server; this module only registers a prefix
 * route on `ctx.httpServer` (never listens on its own port). URLs carry an
 * HMAC-signed, expiring token that names a file *relative to the configured
 * output directory*, so a token can never be turned into an arbitrary path
 * read. Range requests are answered with `206 Partial Content`, which is what
 * lets an `<audio>` element seek inside a long file.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'

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

/** Structural view of `ctx.httpServer`; only `register` is used. */
export interface HttpRouteRegistrar {
  register(route: RegisterableRoute): () => void
}

/** Resolves a local audio path to a browser-openable URL, when routable. */
export interface AudioUrlProvider {
  urlFor(filePath: string): string | undefined
}

export interface AudioRouteOptions {
  /** Ledger root; tokens may only name files beneath it. */
  outputDir: string
  /** Token lifetime in milliseconds. */
  ttlMs?: number
  /** Override the per-instance HMAC secret (tests only). */
  secret?: Buffer
  /** Injectable clock in epoch milliseconds. */
  now?: () => number
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

/**
 * Owns the signed-token format and the HTTP handler. One instance per plugin
 * load; `register` binds it to the host router and returns a disposer.
 */
export class AudioRoute implements AudioUrlProvider {
  private readonly root: string
  private readonly ttlMs: number
  private readonly secret: Buffer
  private readonly now: () => number
  private active = false

  constructor(options: AudioRouteOptions) {
    this.root = resolve(options.outputDir)
    this.ttlMs = options.ttlMs ?? DEFAULT_URL_TTL_MS
    this.secret = options.secret ?? randomBytes(32)
    this.now = options.now ?? Date.now
  }

  /** True once the host router accepted the route. */
  get registered(): boolean {
    return this.active
  }

  /** Register on the DSH host router; the disposer unregisters and disables URLs. */
  register(server: HttpRouteRegistrar): () => void {
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

  /** Serve one request. Exported behaviour is exercised directly by tests. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' })
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
