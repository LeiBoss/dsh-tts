/**
 * One builder for the project snapshot, shared by the conversation panel and
 * the daemon API. Reimplementing this per surface is how two views drift apart
 * and start disagreeing about which chapters are done.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectState } from './pipeline.ts'
import type { Capability, ChapterStatus, EngineInfo } from './types.ts'
import { readJson } from './util.ts'

/** Project ids are the first hex characters of a content hash. */
export const PROJECT_ID = /^[0-9a-f]{8,24}$/

/** One chapter row. */
export interface SnapshotChapter {
  id: string
  order: number
  title: string
  status: ChapterStatus
  durationMs?: number
  subtitles?: string
  error?: string
  /** Relative audio path; the caller decides whether it is servable. */
  audio?: string
  /** Playback URL, only when the caller supplied a minting function. */
  audioUrl?: string
}

/** What both surfaces render/serve. */
export interface ProjectSnapshot {
  projectId: string
  title: string
  done: number
  total: number
  /** Chapters that still need work. */
  pending: number
  failed: number
  capability: Capability
  engine: EngineInfo
  chapters: SnapshotChapter[]
  warnings: string[]
  /** Total warnings recorded; `warnings` is capped. */
  warningCount: number
  /** mtime of `state.json`: the last time the pipeline actually wrote progress. */
  stateUpdatedAt: string
  /** When this snapshot was served; not a progress fact. */
  servedAt: string
}

/** Options for {@link projectSnapshot}. */
export interface SnapshotOptions {
  /** Mints a playback URL for a chapter's audio file, when a route exists. */
  audioUrlFor?: (filePath: string) => string | undefined
}

/**
 * Read one project's persisted progress. Returns undefined for an unknown or
 * malformed id, and never reads outside `<outputDir>/<projectId>`.
 */
export async function projectSnapshot(
  outputDir: string,
  projectId: string,
  options: SnapshotOptions = {},
): Promise<ProjectSnapshot | undefined> {
  if (!PROJECT_ID.test(projectId)) return undefined
  const stateFile = join(outputDir, projectId, 'state', 'state.json')
  const state = await readJson<ProjectState>(stateFile)
  if (state === undefined) return undefined

  // The panel and the API show "last write" so a stalled run is visible; a
  // request time here would always look fresh and hide exactly that condition.
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
    chapters: chapters.map((chapter) => {
      const row: SnapshotChapter = {
        id: chapter.id,
        order: chapter.order,
        title: chapter.title,
        status: chapter.status,
        ...(chapter.audio === undefined ? {} : { durationMs: chapter.audio.durationMs, audio: chapter.audio.path }),
        ...(chapter.subtitles === undefined ? {} : { subtitles: chapter.subtitles.path }),
        ...(chapter.error === undefined ? {} : { error: chapter.error.code }),
      }
      // Playback URLs are minted per request: they expire, and they only exist
      // while a route is mounted.
      if (chapter.audio !== undefined && options.audioUrlFor !== undefined) {
        const url = options.audioUrlFor(join(outputDir, projectId, chapter.audio.path))
        if (url !== undefined) row.audioUrl = url
      }
      return row
    }),
    warnings: state.warnings.slice(0, 5),
    warningCount: state.warnings.length,
    stateUpdatedAt,
    servedAt: new Date().toISOString(),
  }
}
