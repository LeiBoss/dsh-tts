/**
 * Read-only JSON endpoint behind the conversation panel.
 *
 * The panel cannot read structured tool return values (a tool result exposes
 * only its rendered text), and polling a Tool would fight the conversation. So
 * the panel parses the project id out of the rendered result and polls this
 * route instead, which reads the same persisted `state.json` the pipeline
 * writes.
 *
 * Security matches the engine's audio route: the host's connection fence runs
 * first, the path is strictly `<prefix>/<projectId>.json`, and nothing outside
 * the project state file is readable.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectState } from './pipeline.ts'
import type { Capability, ChapterStatus, EngineInfo } from './types.ts'
import { readJson } from './util.ts'

/** Path prefix owned by this plugin. */
export const PANEL_ROUTE_PREFIX = '/voiceover/panel'

/** Project ids are the first 12 hex characters of a content hash. */
const PROJECT_ID = /^[0-9a-f]{8,24}$/

/** Structural view of a DSH web route registration. */
export interface RegisterableRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** Structural view of the host `webServer` service; only `register` is used. */
export interface HttpRouteRegistrar {
  register(route: RegisterableRoute): () => void
}

/** Structural view of the host connection fence. */
export interface ConnectionFence {
  requestRejection?(input: { headers: Record<string, string | string[] | undefined> }): 401 | 403 | undefined
}

/** One chapter row as the panel needs it. */
export interface PanelChapter {
  id: string
  order: number
  title: string
  status: ChapterStatus
  durationMs?: number
  subtitles?: string
  error?: string
}

/** What the panel renders. Deliberately small: no script text, no file paths. */
export interface PanelSnapshot {
  projectId: string
  title: string
  done: number
  total: number
  /** Chapters that still need work; the panel keeps polling while this is > 0. */
  pending: number
  failed: number
  capability: Capability
  engine: EngineInfo
  chapters: PanelChapter[]
  warnings: string[]
  /** Total warnings recorded; `warnings` is capped for the panel. */
  warningCount: number
  /** mtime of `state.json`: the last time the pipeline actually wrote progress. */
  stateUpdatedAt: string
  /** When this snapshot was served; not a progress fact. */
  servedAt: string
}

/** Injection points; tests pass a fake host. */
export interface PanelRouteOptions {
  outputDir: string
  connection?: ConnectionFence
  debug?: (message: string) => void
}

/** Serve one project's persisted progress as JSON. */
export class PanelRoute {
  private readonly options: PanelRouteOptions

  constructor(options: PanelRouteOptions) {
    this.options = options
  }

  /** Build a snapshot from `state/state.json`; undefined when unknown. */
  async snapshot(projectId: string): Promise<PanelSnapshot | undefined> {
    if (!PROJECT_ID.test(projectId)) return undefined
    const stateFile = join(this.options.outputDir, projectId, 'state', 'state.json')
    const state = await readJson<ProjectState>(stateFile)
    if (state === undefined) return undefined

    // The panel shows "last write" so a stalled run is visible. A request time
    // here would always look fresh and hide exactly that condition.
    let stateUpdatedAt = new Date(0).toISOString()
    try {
      stateUpdatedAt = (await stat(stateFile)).mtime.toISOString()
    } catch {
      // Keep the epoch fallback: "unknown" must not claim freshness.
    }

    const chapters = [...state.chapters].sort((a, b) => a.order - b.order)
    const done = chapters.filter((chapter) => chapter.status === 'done').length
    const failed = chapters.filter((chapter) => chapter.status === 'failed').length

    return {
      projectId,
      title: state.outline.title,
      done,
      total: state.outline.chapters.length,
      pending: Math.max(0, state.outline.chapters.length - done - failed),
      failed,
      capability: state.capability,
      engine: state.engine,
      chapters: chapters.map((chapter) => ({
        id: chapter.id,
        order: chapter.order,
        title: chapter.title,
        status: chapter.status,
        ...(chapter.audio === undefined ? {} : { durationMs: chapter.audio.durationMs }),
        ...(chapter.subtitles === undefined ? {} : { subtitles: chapter.subtitles.path }),
        ...(chapter.error === undefined ? {} : { error: chapter.error.code }),
      })),
      warnings: state.warnings.slice(0, 5),
      warningCount: state.warnings.length,
      stateUpdatedAt,
      servedAt: new Date().toISOString(),
    }
  }

  /** Register on the host router; the disposer unregisters the route. */
  register(server: HttpRouteRegistrar): () => void {
    return server.register({
      kind: 'prefix',
      path: PANEL_ROUTE_PREFIX,
      handler: (req, res) => this.handle(req, res),
    })
  }

  /** Handle one request. Never throws: every path answers or closes. */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      this.answer(res, 405, { error: 'method not allowed' })
      return
    }

    const rejection = this.options.connection?.requestRejection?.({ headers: req.headers })
    if (rejection !== undefined) {
      this.answer(res, rejection, { error: 'unauthorized' })
      return
    }

    const path = (req.url ?? '/').split('?')[0] ?? '/'
    if (!path.startsWith(`${PANEL_ROUTE_PREFIX}/`)) {
      this.answer(res, 404, { error: 'not found' })
      return
    }
    const name = path.slice(PANEL_ROUTE_PREFIX.length + 1)
    const match = /^([0-9a-f]{8,24})\.json$/.exec(name)
    if (match === null) {
      this.answer(res, 400, { error: 'expected /<projectId>.json' })
      return
    }

    const projectId = match[1] ?? ''
    const snapshot = await this.snapshot(projectId)
    if (snapshot === undefined) {
      this.answer(res, 404, { error: 'unknown project' })
      return
    }
    this.options.debug?.(`panel served ${projectId}`)
    this.answer(res, 200, snapshot)
  }

  /** Write one JSON response with no caching. */
  private answer(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) {
      res.end()
      return
    }
    const payload = `${JSON.stringify(body)}\n`
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }
}
