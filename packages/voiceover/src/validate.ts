/**
 * Hand-written validators. The pipeline must never write a manifest that the
 * published schema would reject, and a model-produced outline must fail loudly
 * with a JSON path (so the repair prompt can point at the exact field).
 */

/** Validation failure carrying the offending JSON pointer. */
export class ValidationError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'ValidationError'
    this.path = path
  }
}

function fail(path: string, message: string): never {
  throw new ValidationError(path, message)
}

function object(path: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'must be an object')
  }
  return value as Record<string, unknown>
}

function string(path: string, value: unknown, min: number, max: number): string {
  if (typeof value !== 'string') fail(path, 'must be a string')
  if (value.length < min) fail(path, `must be at least ${min} characters`)
  if (value.length > max) fail(path, `must be at most ${max} characters`)
  return value
}

function integer(path: string, value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(path, 'must be an integer')
  if (value < min) fail(path, `must be >= ${min}`)
  return value
}

function boolean(path: string, value: unknown): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean')
  return value
}

function range(path: string, value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) fail(path, 'must be a two-element array')
  const start = integer(`${path}/0`, value[0], 0)
  const end = integer(`${path}/1`, value[1], 0)
  if (end < start) fail(path, 'end must be >= start')
  return [start, end]
}

function oneOf<T extends string>(path: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(path, `must be one of ${allowed.join(' | ')}`)
  }
  return value as T
}

/** Validate an outline as produced by the planning stage. */
export function validateOutline(value: unknown): import('./types.ts').Outline {
  const root = object('', value)
  const title = string('/title', root.title, 1, 60)
  if (!Array.isArray(root.chapters)) fail('/chapters', 'must be an array')
  if (root.chapters.length < 1) fail('/chapters', 'must not be empty')
  if (root.chapters.length > 40) fail('/chapters', 'must contain at most 40 chapters')

  const chapters = root.chapters.map((raw, index) => {
    const path = `/chapters/${index}`
    const chapter = object(path, raw)
    const id = string(`${path}/id`, chapter.id, 4, 10)
    if (!/^ch-[0-9]{2,3}$/.test(id)) fail(`${path}/id`, 'must match ch-01')
    const crossRefs = chapter.crossRefs
    if (crossRefs !== undefined) {
      if (!Array.isArray(crossRefs)) fail(`${path}/crossRefs`, 'must be an array')
      for (const [i, ref] of crossRefs.entries()) string(`${path}/crossRefs/${i}`, ref, 0, 40)
    }
    const note = chapter.note
    if (note !== undefined) string(`${path}/note`, note, 0, 120)
    return {
      id,
      title: string(`${path}/title`, chapter.title, 1, 14),
      summary: string(`${path}/summary`, chapter.summary, 0, 80),
      sourceRange: range(`${path}/sourceRange`, chapter.sourceRange),
      estimatedChars: integer(`${path}/estimatedChars`, chapter.estimatedChars, 1),
      crossRefs: (crossRefs as string[] | undefined) ?? [],
      note: (note as string | undefined) ?? '',
    }
  })

  return { title, chapters }
}

/** Validate a manifest before it is written to disk. */
export function validateManifest(value: unknown): import('./types.ts').Manifest {
  const root = object('', value)
  if (root.schemaVersion !== 1) fail('/schemaVersion', 'must be 1')
  const projectId = string('/projectId', root.projectId, 8, 24)
  if (!/^[0-9a-f]+$/.test(projectId)) fail('/projectId', 'must be lowercase hex')
  string('/createdAt', root.createdAt, 10, 40)
  string('/promptVersion', root.promptVersion, 3, 12)

  const capability = object('/capability', root.capability)
  boolean('/capability/llm', capability.llm)
  boolean('/capability/network', capability.network)
  boolean('/capability/wordBoundaries', capability.wordBoundaries)
  oneOf('/capability/timingQuality', capability.timingQuality, ['exact', 'estimated', 'none'] as const)

  const engine = object('/engine', root.engine)
  oneOf('/engine/name', engine.name, ['edge-js', 'edge-py', 'sapi', 'speechSynthesis'] as const)
  string('/engine/voice', engine.voice, 1, 80)
  string('/engine/rate', engine.rate, 2, 8)

  const source = object('/source', root.source)
  string('/source/path', source.path, 1, 400)
  const hash = string('/source/hash', source.hash, 71, 71)
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) fail('/source/hash', 'must be sha256:<64 hex>')
  integer('/source/chars', source.chars, 1)

  if (!Array.isArray(root.chapters) || root.chapters.length === 0) {
    fail('/chapters', 'must be a non-empty array')
  }
  for (const [index, raw] of root.chapters.entries()) {
    const path = `/chapters/${index}`
    const chapter = object(path, raw)
    string(`${path}/id`, chapter.id, 4, 10)
    integer(`${path}/order`, chapter.order, 1)
    string(`${path}/title`, chapter.title, 1, 40)
    integer(`${path}/chars`, chapter.chars, 1)
    oneOf(`${path}/status`, chapter.status, [
      'queued',
      'adapted',
      'marked',
      'audited',
      'synthesized',
      'timed',
      'done',
      'failed',
    ] as const)
    if (chapter.audio !== undefined) {
      const audio = object(`${path}/audio`, chapter.audio)
      string(`${path}/audio/path`, audio.path, 1, 400)
      integer(`${path}/audio/bytes`, audio.bytes, 1)
      integer(`${path}/audio/durationMs`, audio.durationMs, 1)
      oneOf(`${path}/audio/timingQuality`, audio.timingQuality, ['exact', 'estimated'] as const)
    }
    if (chapter.error !== undefined) {
      const error = object(`${path}/error`, chapter.error)
      string(`${path}/error/code`, error.code, 1, 60)
      string(`${path}/error/message`, error.message, 1, 400)
      boolean(`${path}/error/retryable`, error.retryable)
    }
  }

  const totals = object('/totals', root.totals)
  integer('/totals/chapters', totals.chapters, 0)
  integer('/totals/chars', totals.chars, 0)
  integer('/totals/audioMs', totals.audioMs, 0)
  integer('/totals/bytes', totals.bytes, 0)

  if (!Array.isArray(root.warnings)) fail('/warnings', 'must be an array')
  for (const [index, warning] of root.warnings.entries()) {
    string(`/warnings/${index}`, warning, 0, 200)
  }

  return value as import('./types.ts').Manifest
}
