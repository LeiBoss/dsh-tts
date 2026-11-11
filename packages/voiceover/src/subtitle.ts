/**
 * Subtitle construction: unit splitting (rule-based fallback when the model is
 * unavailable), timing alignment (word boundaries when available, proportional
 * otherwise), and SRT serialization.
 *
 * Two invariants the rest of the system relies on:
 * - units are screen-sized (<= 2 lines of <= 18 chars), not sentence-sized;
 * - timing is monotonic, clamped to the audio, and never claims `exact` unless
 *   word offsets were actually available.
 */
import type { WordTiming } from './types.ts'

/** One subtitle screen. `\n` separates the two allowed lines. */
export interface SubtitleUnit {
  text: string
}

/** A unit with resolved timing. */
export interface TimedUnit {
  text: string
  startMs: number
  endMs: number
}

/** Minimum time a screen stays visible. */
export const MIN_UNIT_MS = 800
/** Gap between consecutive screens. */
export const MIN_GAP_MS = 50
/** Characters per line before wrapping. */
export const MAX_LINE_CHARS = 18
/** Characters per screen across both lines. */
export const MAX_UNIT_CHARS = MAX_LINE_CHARS * 2

/** Characters that must not start a subtitle line. */
const NO_LINE_START = new Set(['的', '了', '是', '在', '和', '也', '就', '而', '与', '及', '着', '过', '吗', '呢'])

/** Count characters that carry timing weight (letters, digits, CJK). */
export function spokenLength(text: string): number {
  let count = 0
  for (const char of text) {
    if (/[\p{L}\p{N}]/u.test(char)) count += 1
  }
  return count
}

/** Split on sentence punctuation, keeping the punctuation with its sentence. */
function sentences(text: string): string[] {
  const parts = text.split(/(?<=[。！？!?；;\n])/u)
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

/**
 * Rule-based splitter used when no model is available. It is deliberately
 * conservative: a sentence that fits becomes one screen, otherwise it is split
 * at commas, and finally hard-split at the character limit.
 */
export function splitUnitsFallback(text: string): SubtitleUnit[] {
  const units: string[] = []

  for (const sentence of sentences(text)) {
    if (spokenLength(sentence) <= MAX_LINE_CHARS) {
      units.push(sentence.replace(/[。．.]$/u, ''))
      continue
    }
    const clauses = sentence.split(/(?<=[，,、])/u).map((part) => part.trim()).filter(Boolean)
    let buffer = ''
    for (const clause of clauses) {
      if (buffer.length === 0) {
        buffer = clause
        continue
      }
      if (spokenLength(buffer) + spokenLength(clause) <= MAX_LINE_CHARS) {
        buffer += clause
        continue
      }
      units.push(buffer)
      buffer = clause
    }
    if (buffer.length > 0) units.push(buffer)
  }

  // Hard-split anything still too long, then merge back a no-start character.
  const out: string[] = []
  for (const unit of units) {
    const clean = unit.trim()
    if (clean.length === 0) continue
    if (clean.length <= MAX_UNIT_CHARS) {
      out.push(clean)
      continue
    }
    for (let i = 0; i < clean.length; i += MAX_LINE_CHARS) {
      out.push(clean.slice(i, i + MAX_LINE_CHARS).trim())
    }
  }

  const merged: string[] = []
  for (const unit of out) {
    const previous = merged[merged.length - 1]
    const first = unit[0] ?? ''
    if (previous !== undefined && NO_LINE_START.has(first) && previous.length + unit.length <= MAX_UNIT_CHARS) {
      merged[merged.length - 1] = previous + unit
      continue
    }
    merged.push(unit)
  }

  return merged
    .map((text) => text.replace(/[。．.]$/u, '').trim())
    .filter((text) => text.length > 0)
    .map((text) => ({ text }))
}

/** One normalized character with its absolute position in time. */
interface CharSlot {
  startMs: number
  durationMs: number
}

/** Expand word timings into per-character slots. */
function charSlots(words: readonly WordTiming[]): CharSlot[] {
  const slots: CharSlot[] = []
  for (const word of words) {
    const chars = [...word.text].filter((char) => /[\p{L}\p{N}]/u.test(char))
    if (chars.length === 0) continue
    const per = word.durationMs / chars.length
    for (let i = 0; i < chars.length; i += 1) {
      slots.push({ startMs: word.offsetMs + i * per, durationMs: per })
    }
  }
  return slots
}

/**
 * Assign start/end to every unit. With word timings the result is `exact`;
 * without them it is proportional to spoken length and must be labelled
 * `estimated` by the caller.
 */
export function alignUnits(
  units: readonly SubtitleUnit[],
  durationMs: number,
  words?: readonly WordTiming[],
): { units: TimedUnit[]; quality: 'exact' | 'estimated' } {
  const total = units.reduce((sum, unit) => sum + spokenLength(unit.text), 0)
  const slots = words !== undefined && words.length > 0 ? charSlots(words) : []
  const useWords = slots.length >= total && total > 0
  const quality: 'exact' | 'estimated' = useWords ? 'exact' : 'estimated'

  const raw: TimedUnit[] = []
  let cursor = 0
  const perChar = total > 0 ? durationMs / total : 0

  for (const unit of units) {
    const length = spokenLength(unit.text)
    let startMs: number
    let endMs: number

    if (useWords) {
      const first = slots[cursor]
      const last = slots[Math.min(slots.length - 1, cursor + Math.max(1, length) - 1)]
      startMs = first?.startMs ?? 0
      endMs = last === undefined ? startMs + MIN_UNIT_MS : last.startMs + last.durationMs
    } else {
      startMs = Math.round(cursor * perChar)
      endMs = Math.round((cursor + Math.max(1, length)) * perChar)
    }

    raw.push({ text: unit.text, startMs, endMs })
    cursor += Math.max(1, length)
  }

  // Enforce the readability rules in one pass, keeping order monotonic.
  const timed: TimedUnit[] = []
  for (const [index, unit] of raw.entries()) {
    const previous = timed[index - 1]
    let start = unit.startMs
    if (previous !== undefined && start < previous.endMs + MIN_GAP_MS) {
      start = previous.endMs + MIN_GAP_MS
    }
    let end = Math.max(unit.endMs, start + MIN_UNIT_MS)
    const next = raw[index + 1]
    if (next !== undefined && end + MIN_GAP_MS > next.startMs) {
      end = Math.max(start + 1, next.startMs - MIN_GAP_MS)
    }
    if (end > durationMs) end = Math.max(start + 1, durationMs)
    timed.push({ text: unit.text, startMs: Math.max(0, Math.round(start)), endMs: Math.round(end) })
  }

  return { units: timed, quality }
}

/** Format a millisecond offset as `HH:MM:SS,mmm`. */
function timestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  const millis = total % 1000
  const pad = (value: number, width: number): string => String(value).padStart(width, '0')
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`
}

/** Render an SRT document (1-based indices, blank line after each cue). */
export function formatSrt(units: readonly TimedUnit[]): string {
  return units
    .map((unit, index) => `${index + 1}\n${timestamp(unit.startMs)} --> ${timestamp(unit.endMs)}\n${unit.text}`)
    .join('\n\n')
    .concat('\n')
}
