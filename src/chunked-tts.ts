/**
 * Serial chunked synthesis for long texts.
 *
 * Every chunk goes through the existing Edge-TTS path into a private temp
 * directory, in order, one subprocess at a time. The finished MP3 files are
 * concatenated byte-for-byte (MP3 frame streams allow this) and the result is
 * published atomically at the normal cache path, so the cache key remains the
 * hash of the full original text.
 */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AUDIO_FORMAT, outputFilePath } from './cache.ts'
import { DEFAULT_TOTAL_TIMEOUT_MS } from './config.ts'
import { splitText } from './chunker.ts'
import {
  synthesize,
  type SpawnFunction,
  type SynthesizedAudio,
} from './edge-tts.ts'
import { ErrorCode, TtsError, type TtsErrorCode } from './errors.ts'

/** Pause between chunk subprocesses so Edge-TTS is not rate-limited. */
export const DEFAULT_INTER_CHUNK_DELAY_MS = 200

export interface ChunkedSynthesisOptions {
  voice: string
  rate: string
  /** Applied uniformly to every chunk. */
  pitch?: string
  /** Applied uniformly to every chunk. */
  volume?: string
  binary: string
  outputDir: string
  /** Cache key of the full original text. */
  hash: string
  timeoutMs: number
  /** Whole-call budget across every chunk and inter-chunk delay. */
  totalTimeoutMs?: number
  chunkSize: number
  signal?: AbortSignal
  spawnImpl?: SpawnFunction
  now?: Date
  /** Injectable sleep, used by tests to avoid real delays. */
  delay?: (ms: number) => Promise<void>
  interChunkDelayMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function chunkFailure(index: number, total: number, error: unknown): TtsError {
  if (error instanceof TtsError) {
    return new TtsError(
      error.code as TtsErrorCode,
      `Chunk ${index + 1}/${total} failed: ${error.detail}`,
      error.suggestion,
      { cause: error },
    )
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new TtsError(
    ErrorCode.EdgeTtsFailed,
    `Chunk ${index + 1}/${total} failed: ${detail}`,
    'Retry the call; if it persists, run `tts_self_check` and inspect Edge-TTS output.',
    { cause: error },
  )
}

function publishFailure(target: string, error: unknown): TtsError {
  const detail = error instanceof Error ? error.message : String(error)
  return new TtsError(
    ErrorCode.OutputDirNotWritable,
    `Cannot write the concatenated audio file ${target}: ${detail}`,
    'Check the DSH sandbox file policy and the output directory permissions.',
    { cause: error },
  )
}

function overallTimeout(
  totalTimeoutMs: number,
  index: number,
  total: number,
): TtsError {
  return new TtsError(
    ErrorCode.SynthesisTimeout,
    `Overall synthesis deadline of ${totalTimeoutMs} ms was exceeded before chunk ${index + 1}/${total}.`,
    'Increase `totalTimeoutMs`, shorten the text, or raise `chunkSize`.',
  )
}

/**
 * Synthesize `text` chunk by chunk and return one concatenated MP3. Callers
 * only use this above the chunk threshold; calling it with one chunk simply
 * delegates to the one-shot path.
 */
export async function synthesizeChunked(
  text: string,
  options: ChunkedSynthesisOptions,
): Promise<SynthesizedAudio> {
  const chunks = splitText(text, options.chunkSize)
  const base = {
    voice: options.voice,
    rate: options.rate,
    pitch: options.pitch,
    volume: options.volume,
    binary: options.binary,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    spawnImpl: options.spawnImpl,
  }

  if (chunks.length <= 1) {
    return synthesize(text, {
      ...base,
      outputDir: options.outputDir,
      hash: options.hash,
      now: options.now,
    })
  }

  const delayMs = options.interChunkDelayMs ?? DEFAULT_INTER_CHUNK_DELAY_MS
  const delay = options.delay ?? sleep
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-tts-chunks-'))
  const baseTime = (options.now ?? new Date()).getTime()
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS
  const deadline = Date.now() + totalTimeoutMs

  try {
    const buffers: Buffer[] = []
    for (let index = 0; index < chunks.length; index += 1) {
      if (options.signal?.aborted) {
        throw new TtsError(ErrorCode.Aborted, 'Chunked synthesis was aborted.')
      }
      if (Date.now() >= deadline) {
        throw overallTimeout(totalTimeoutMs, index, chunks.length)
      }
      if (index > 0 && delayMs > 0) await delay(delayMs)
      if (Date.now() >= deadline) {
        throw overallTimeout(totalTimeoutMs, index, chunks.length)
      }

      const remaining = deadline - Date.now()
      try {
        const part = await synthesize(chunks[index] ?? '', {
          ...base,
          timeoutMs: Math.max(1, Math.min(options.timeoutMs, remaining)),
          outputDir: tempDir,
          hash: `part-${index}`,
          now: new Date(baseTime + index),
        })
        buffers.push(await readFile(part.filePath))
      } catch (error) {
        if (Date.now() >= deadline) {
          throw overallTimeout(totalTimeoutMs, index, chunks.length)
        }
        throw chunkFailure(index, chunks.length, error)
      }
    }

    const bytes = Buffer.concat(buffers)
    if (bytes.length === 0) {
      throw new TtsError(
        ErrorCode.EmptyAudio,
        'Chunked synthesis produced no audio bytes.',
        'Retry the call; if it persists, run `tts_self_check`.',
      )
    }

    const target = outputFilePath(options.outputDir, options.hash, options.now)
    try {
      await mkdir(dirname(target), { recursive: true })
      const partial = `${target}.partial`
      await writeFile(partial, bytes)
      await rename(partial, target)
    } catch (error) {
      throw publishFailure(target, error)
    }

    return { filePath: target, format: AUDIO_FORMAT }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}
