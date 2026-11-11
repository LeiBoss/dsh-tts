/**
 * Pure text chunking for long synthesis requests.
 *
 * Splitting happens on code points, so a surrogate pair is never cut in half,
 * and the cut point prefers sentence punctuation, then newlines, then softer
 * separators such as commas and spaces. The module has no I/O and no
 * subprocess dependency, which keeps it directly testable.
 */

/** Target characters per chunk; also the one-shot threshold. */
export const DEFAULT_CHUNK_SIZE = 1_200

/** A cut is only taken before this fraction of the window when possible. */
const MIN_FILL_RATIO = 0.5

const HARD_SENTENCE = new Set(['。', '！', '？', '；', '!', '?', ';'])
const SOFT_BREAK = new Set([
  '，',
  '、',
  '：',
  ',',
  ':',
  ' ',
  '\t',
  '\u3000',
])

/** Count Unicode code points rather than UTF-16 code units. */
export function countCharacters(text: string): number {
  return Array.from(text).length
}

function isSentenceBreak(chars: readonly string[], index: number): boolean {
  const char = chars[index]
  if (char === undefined) return false
  if (char === '\n' || HARD_SENTENCE.has(char)) return true
  // A full stop only ends a sentence when followed by whitespace or the end;
  // this keeps `3.14` and file names together.
  if (char === '.') {
    const next = chars[index + 1]
    return next === undefined || /\s/.test(next)
  }
  return false
}

/**
 * Split `text` into chunks of at most `chunkSize` characters, cutting at the
 * latest sentence boundary in each window when one exists. Whitespace at a
 * chunk edge is trimmed; otherwise every character is preserved.
 */
export function splitText(
  text: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): string[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError(`chunkSize must be a positive integer, got ${chunkSize}`)
  }

  const chars = Array.from(text)
  if (chars.length === 0) return []
  if (chars.length <= chunkSize) return [text]

  const minFill = Math.max(1, Math.floor(chunkSize * MIN_FILL_RATIO))
  const chunks: string[] = []
  let start = 0

  while (start < chars.length) {
    if (chars.length - start <= chunkSize) {
      const tail = chars.slice(start).join('').trim()
      if (tail.length > 0) chunks.push(tail)
      break
    }

    const limit = start + chunkSize
    let sentence = -1
    let soft = -1

    for (let index = start; index < limit; index += 1) {
      if (isSentenceBreak(chars, index)) sentence = index + 1
      else if (SOFT_BREAK.has(chars[index] ?? '')) soft = index + 1
    }

    let cut: number
    if (sentence >= start + minFill) {
      cut = sentence
    } else if (soft >= start + minFill) {
      cut = soft
    } else if (sentence > start) {
      cut = sentence
    } else if (soft > start) {
      cut = soft
    } else {
      cut = limit
    }

    const piece = chars.slice(start, cut).join('').trim()
    if (piece.length > 0) chunks.push(piece)
    start = cut
  }

  return chunks
}
