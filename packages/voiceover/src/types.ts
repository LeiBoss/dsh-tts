/**
 * Public vocabulary shared by the pipeline, the artifact writer, and the tools.
 * Everything here is plain data: no cordis, no DSH imports, so the core can be
 * unit-tested without a host.
 */

/** One planned chapter; `sourceRange` is inclusive on both ends. */
export interface OutlineChapter {
  id: string
  title: string
  summary: string
  sourceRange: [number, number]
  estimatedChars: number
  crossRefs?: string[]
  note?: string
}

/** Result of the outline stage. */
export interface Outline {
  title: string
  chapters: OutlineChapter[]
}

/** Per-chapter lifecycle. `failed` is terminal until a rerun is requested. */
export type ChapterStatus =
  | 'queued'
  | 'adapted'
  | 'marked'
  | 'audited'
  | 'synthesized'
  | 'timed'
  | 'done'
  | 'failed'

/** Audio facts recorded for one chapter. */
export interface ChapterAudio {
  path: string
  bytes: number
  durationMs: number
  timingQuality: 'exact' | 'estimated'
  format: 'mp3' | 'wav'
}

/** Subtitle facts recorded for one chapter. */
export interface ChapterSubtitles {
  path: string
  units: number
  timingQuality: 'exact' | 'estimated'
}

/** One chapter as persisted in `state.json`. */
export interface ChapterRecord {
  id: string
  order: number
  title: string
  chars: number
  sourceRange: [number, number]
  status: ChapterStatus
  script?: { path: string; hash: string }
  audio?: ChapterAudio
  subtitles?: ChapterSubtitles
  error?: { code: string; message: string; retryable: boolean }
}

/** What the host could do at the time this project ran. */
export interface Capability {
  llm: boolean
  network: boolean
  wordBoundaries: boolean
  timingQuality: 'exact' | 'estimated' | 'none'
}

/** Engine identity recorded in the manifest. */
export interface EngineInfo {
  name: 'edge-js' | 'edge-py' | 'sapi' | 'speechSynthesis'
  version?: string
  voice: string
  rate: string
  viaProxy?: boolean
}

/** The consumed artifact contract. */
export interface Manifest {
  schemaVersion: 1
  projectId: string
  createdAt: string
  updatedAt?: string
  title?: string
  capability: Capability
  engine: EngineInfo
  promptVersion: string
  source: { path: string; hash: string; chars: number; kind?: 'md' | 'txt' | 'pdf' | 'docx' | 'html' }
  chapters: ManifestChapter[]
  totals: { chapters: number; chars: number; audioMs: number; bytes: number }
  warnings: string[]
}

/** Chapter shape inside the manifest. */
export interface ManifestChapter {
  id: string
  order: number
  title: string
  chars: number
  sourceRange: [number, number]
  status: ChapterStatus
  audio?: ChapterAudio
  subtitles?: ChapterSubtitles
  script?: { path: string; hash: string }
  error?: { code: string; message: string; retryable: boolean }
}

/** Word-level timing, when an engine provides it. */
export interface WordTiming {
  text: string
  offsetMs: number
  durationMs: number
}

/** What a synthesizer returns. `durationMs` is mandatory so timing never guesses. */
export interface SynthResult {
  filePath: string
  bytes: number
  durationMs: number
  timingQuality: 'exact' | 'estimated'
  format: 'mp3' | 'wav'
  /** Engine that actually produced the file, as reported by `ctx.tts`. */
  engine?: string
  words?: WordTiming[]
  browserUrl?: string
}

/** Narrow port the pipeline talks to; `ctx.tts` implements it. */
export interface Synthesizer {
  synthesize(request: {
    text: string
    voice: string
    rate: string
    signal?: AbortSignal
  }): Promise<SynthResult>
}

/** Prompt version must change whenever a prompt changes (see PROMPTS.md). */
export const PROMPT_VERSION = 'p1.3'

/** Bump when `manifest.json`'s shape changes. */
export const SCHEMA_VERSION = 1
