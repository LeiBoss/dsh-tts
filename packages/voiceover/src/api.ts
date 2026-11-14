/**
 * Daemon API: the same operations the DSH plugin exposes, reachable by any
 * process on this machine (scripts, other agents, an editor task).
 *
 * Everything here is a pure function of (`ApiContext`, request) so it can be
 * exercised without sockets; `cli.ts` is the only place that binds a port.
 *
 * Auth: a bearer token is mandatory. The daemon refuses to start without one,
 * and every route except `/healthz` requires it.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { StyleProfile } from './pipeline.ts'
import { projectSnapshot } from './snapshot.ts'

/** Collaborators the API needs; the CLI wires them to the real pipeline. */
export interface ApiContext {
  outputDir: string
  token: string
  version: string
  startedAt: number
  synthesize(input: { text: string; voice?: string; rate?: string }): Promise<{
    filePath: string
    format: string
    durationMs: number
    timingQuality: 'exact' | 'estimated'
    engine: string
  }>
  createProject(input: {
    sourcePath?: string
    sourceText?: string
    title?: string
    voice?: string
    rate?: string
    style?: StyleProfile
  }): Promise<{ projectId: string }>
  rerunProject(projectId: string): Promise<void>
  doctor(): Promise<unknown>
}

/** One request, already read into memory. */
export interface ApiRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body?: Buffer
}

/** One response. `body` is always a Buffer so callers can stream it verbatim. */
export interface ApiResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

/** Largest accepted JSON body for a create call. */
const MAX_BODY_BYTES = 5 * 1024 * 1024
/** Longest text accepted for one-shot synthesis. */
const MAX_TTS_CHARS = 10_000

const STYLES = new Set<StyleProfile>(['lecture', 'news', 'story', 'docs'])
const PROJECT_ID = /^[0-9a-f]{8,24}$/
const CHAPTER = /^ch-[0-9]{2,3}$/

/** JSON response helper. */
function json(status: number, body: unknown): ApiResponse {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8')
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(payload.length),
      'cache-control': 'no-store',
    },
    body: payload,
  }
}

/** Constant-time bearer check: compare digests so lengths always match. */
function authorized(headers: ApiRequest['headers'], token: string): boolean {
  const raw = headers.authorization
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false
  const expected = createHash('sha256').update(token).digest()
  const actual = createHash('sha256').update(value.slice('Bearer '.length).trim()).digest()
  return timingSafeEqual(expected, actual)
}

/** Parse a JSON body, tolerating an empty one. */
function parseJson(body: Buffer | undefined): Record<string, unknown> | undefined {
  if (body === undefined || body.length === 0) return {}
  if (body.length > MAX_BODY_BYTES) return undefined
  try {
    const value: unknown = JSON.parse(body.toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** Parse `Range: bytes=start-end` against a known size. */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'invalid' | undefined {
  if (header === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return 'invalid'
  const startRaw = match[1] ?? ''
  const endRaw = match[2] ?? ''
  if (startRaw === '' && endRaw === '') return 'invalid'

  if (startRaw === '') {
    const suffix = Number(endRaw)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startRaw)
  const end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid'
  return { start, end }
}

/** Serve a file with optional single-range support. */
async function serveFile(
  filePath: string,
  contentType: string,
  rangeHeader: string | undefined,
): Promise<ApiResponse> {
  let bytes: Buffer
  try {
    bytes = await readFile(filePath)
  } catch {
    return json(404, { error: 'not found' })
  }

  const range = parseRange(rangeHeader, bytes.length)
  if (range === 'invalid') {
    return {
      status: 416,
      headers: { 'content-range': `bytes */${bytes.length}`, 'content-type': 'application/json' },
      body: Buffer.from(`${JSON.stringify({ error: 'invalid range' })}\n`),
    }
  }
  if (range === undefined) {
    return {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(bytes.length),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      },
      body: bytes,
    }
  }
  const slice = bytes.subarray(range.start, range.end + 1)
  return {
    status: 206,
    headers: {
      'content-type': contentType,
      'content-length': String(slice.length),
      'content-range': `bytes ${range.start}-${range.end}/${bytes.length}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    },
    body: slice,
  }
}

/** Resolve a chapter artifact inside one project, refusing escapes. */
function artifactPath(outputDir: string, projectId: string, name: string): string | undefined {
  if (!PROJECT_ID.test(projectId)) return undefined
  const projectDir = resolve(outputDir, projectId)
  const target = resolve(projectDir, 'audio', name)
  if (!target.startsWith(`${projectDir}/`) && !target.startsWith(`${projectDir}\\`)) return undefined
  return target
}

/**
 * Dispatch one request. Never throws: every failure becomes a JSON response.
 */
export async function handleRequest(context: ApiContext, request: ApiRequest): Promise<ApiResponse> {
  const url = new URL(request.url, 'http://localhost')
  const path = url.pathname

  if (path === '/healthz') {
    return json(200, {
      ok: true,
      version: context.version,
      uptimeMs: Date.now() - context.startedAt,
    })
  }
  if (!authorized(request.headers, context.token)) {
    return json(401, { error: 'unauthorized', hint: 'send Authorization: Bearer <token>' })
  }

  if (path === '/v1/doctor' && request.method === 'GET') {
    return json(200, await context.doctor())
  }

  if (path === '/v1/tts' && request.method === 'POST') {
    const body = parseJson(request.body)
    if (body === undefined) return json(400, { error: 'invalid JSON body' })
    const text = typeof body.text === 'string' ? body.text : ''
    if (text.trim().length === 0) return json(400, { error: 'text is required' })
    if (text.length > MAX_TTS_CHARS) {
      return json(413, { error: `text exceeds ${MAX_TTS_CHARS} characters` })
    }
    const voice = typeof body.voice === 'string' ? body.voice : undefined
    const rate = typeof body.rate === 'string' ? body.rate : undefined
    try {
      const result = await context.synthesize({ text, ...(voice === undefined ? {} : { voice }), ...(rate === undefined ? {} : { rate }) })
      return json(200, result)
    } catch (error) {
      return json(422, { error: error instanceof Error ? error.message.slice(0, 300) : 'synthesis failed' })
    }
  }

  if (path === '/v1/voiceover' && request.method === 'POST') {
    const body = parseJson(request.body)
    if (body === undefined) return json(400, { error: 'invalid JSON body' })
    const sourcePath = typeof body.sourcePath === 'string' ? body.sourcePath : undefined
    const sourceText = typeof body.sourceText === 'string' ? body.sourceText : undefined
    if ((sourcePath === undefined) === (sourceText === undefined)) {
      return json(400, { error: 'provide exactly one of sourcePath or sourceText' })
    }
    if (sourceText !== undefined && sourceText.length > MAX_BODY_BYTES) {
      return json(413, { error: 'sourceText is too large' })
    }
    const styleRaw = typeof body.style === 'string' ? body.style : undefined
    if (styleRaw !== undefined && !STYLES.has(styleRaw as StyleProfile)) {
      return json(400, { error: 'style must be lecture, news, story or docs' })
    }
    try {
      const created = await context.createProject({
        ...(sourcePath === undefined ? {} : { sourcePath }),
        ...(sourceText === undefined ? {} : { sourceText }),
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.voice === 'string' ? { voice: body.voice } : {}),
        ...(typeof body.rate === 'string' ? { rate: body.rate } : {}),
        ...(styleRaw === undefined ? {} : { style: styleRaw as StyleProfile }),
      })
      return json(202, { projectId: created.projectId, statusUrl: `/v1/projects/${created.projectId}` })
    } catch (error) {
      return json(422, { error: error instanceof Error ? error.message.slice(0, 300) : 'create failed' })
    }
  }

  const projectMatch = /^\/v1\/projects\/([0-9a-f]{8,24})(\/.*)?$/.exec(path)
  if (projectMatch !== null) {
    const projectId = projectMatch[1] ?? ''
    const rest = projectMatch[2] ?? ''

    if (rest === '' && request.method === 'GET') {
      const snapshot = await projectSnapshot(context.outputDir, projectId)
      return snapshot === undefined ? json(404, { error: 'unknown project' }) : json(200, snapshot)
    }

    if (rest === '/manifest' && request.method === 'GET') {
      const filePath = join(resolve(context.outputDir, projectId), 'manifest.json')
      try {
        const manifest = await readFile(filePath, 'utf8')
        return {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          body: Buffer.from(manifest, 'utf8'),
        }
      } catch {
        return json(404, { error: 'manifest is not ready' })
      }
    }

    if (rest === '/rerun' && request.method === 'POST') {
      const snapshot = await projectSnapshot(context.outputDir, projectId)
      if (snapshot === undefined) return json(404, { error: 'unknown project' })
      try {
        await context.rerunProject(projectId)
        return json(202, { ok: true, projectId })
      } catch (error) {
        return json(422, { error: error instanceof Error ? error.message.slice(0, 300) : 'rerun failed' })
      }
    }

    const audioMatch = /^\/audio\/(ch-[0-9]{2,3})\.(mp3|wav)$/.exec(rest)
    if (audioMatch !== null && request.method === 'GET') {
      const fileName = `${audioMatch[1]}.${audioMatch[2]}`
      const filePath = artifactPath(context.outputDir, projectId, fileName)
      if (filePath === undefined) return json(400, { error: 'bad chapter' })
      return serveFile(filePath, audioMatch[2] === 'wav' ? 'audio/wav' : 'audio/mpeg', rangeOf(request))
    }

    const subtitleMatch = /^\/subtitles\/(ch-[0-9]{2,3})(\.est)?\.srt$/.exec(rest)
    if (subtitleMatch !== null && request.method === 'GET') {
      const fileName = `${subtitleMatch[1]}${subtitleMatch[2] ?? ''}.srt`
      const filePath = artifactPath(context.outputDir, projectId, fileName)
      if (filePath === undefined) return json(400, { error: 'bad chapter' })
      return serveFile(filePath, 'text/plain; charset=utf-8', undefined)
    }

    return json(404, { error: 'unknown endpoint' })
  }

  return json(404, { error: 'unknown endpoint' })
}

/** Read the `Range` header defensively. */
function rangeOf(request: ApiRequest): string | undefined {
  const raw = request.headers.range
  return Array.isArray(raw) ? raw[0] : raw
}

/** Re-exported so the CLI can share the chapter pattern. */
export { CHAPTER }
