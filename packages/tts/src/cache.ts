import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Directory names this module owns: `YYYY-MM-DD`. */
const DATE_DIRECTORY = /^\d{4}-\d{2}-\d{2}$/

/** Audio container Edge-TTS writes. */
export const AUDIO_FORMAT = 'mp3'

/**
 * Stable cache key for one synthesis request. The first 16 hex characters of
 * SHA-256 are enough to name a file while keeping names short.
 */
export function cacheKey(text: string, voice: string, rate: string): string {
  return createHash('sha256')
    .update(`${text}\u0000${voice}\u0000${rate}`, 'utf8')
    .digest('hex')
    .slice(0, 16)
}

/** Local-calendar `YYYY-MM-DD` bucket for a timestamp. */
export function dateDirName(date: Date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Target path for a fresh synthesis: `<outputDir>/<date>/<hash>-<epochMs>.mp3`.
 * The timestamp keeps concurrent first-time syntheses from colliding.
 */
export function outputFilePath(
  outputDir: string,
  hash: string,
  date: Date = new Date(),
): string {
  return join(outputDir, dateDirName(date), `${hash}-${date.getTime()}.${AUDIO_FORMAT}`)
}

/**
 * Diagnostic record stored next to a finished MP3. It never participates in
 * cache lookup; it only lets a later cache hit report which engine produced
 * the file (for example `sapi` after a fallback).
 */
export interface CacheMetadata {
  engine: string
  voice: string
  rate: string
  pitch: string
  volume: string
  createdAt: string
}

/** Sidecar path for one audio file. */
export function metadataPath(filePath: string): string {
  return `${filePath}.json`
}

/** Best-effort metadata write; diagnostics must never fail synthesis. */
export async function writeCacheMetadata(
  filePath: string,
  metadata: CacheMetadata,
): Promise<void> {
  try {
    await writeFile(metadataPath(filePath), JSON.stringify(metadata), 'utf8')
  } catch {
    // The audio file is already valid; a missing sidecar only loses engine info.
  }
}

/** Read a sidecar, treating missing, unreadable, or malformed data as absent. */
export async function readCacheMetadata(
  filePath: string,
): Promise<CacheMetadata | undefined> {
  try {
    const parsed = JSON.parse(await readFile(metadataPath(filePath), 'utf8')) as {
      engine?: unknown
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined
    if (typeof parsed.engine !== 'string' || parsed.engine.length === 0) {
      return undefined
    }
    return parsed as CacheMetadata
  } catch {
    return undefined
  }
}

/**
 * Find an existing non-empty file for `hash`, newest date bucket first. Only
 * files carrying the exact key prefix and a positive size qualify, so a
 * partial or unrelated file never satisfies the cache. The `.mp3.json`
 * sidecars and the `.audio-route-secret` file never match this filter.
 */
export async function findCachedFile(
  outputDir: string,
  hash: string,
): Promise<string | undefined> {
  let entries
  try {
    entries = await readdir(outputDir, { withFileTypes: true })
  } catch {
    return undefined
  }

  const dateDirs = entries
    .filter((entry) => entry.isDirectory() && DATE_DIRECTORY.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse()

  const prefix = `${hash}-`
  for (const dirName of dateDirs) {
    const dir = join(outputDir, dirName)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(`.${AUDIO_FORMAT}`)) continue
      const filePath = join(dir, name)
      try {
        const info = await stat(filePath)
        if (info.isFile() && info.size > 0) return filePath
      } catch {
        // Raced with a cleanup; try the next candidate.
      }
    }
  }
  return undefined
}
