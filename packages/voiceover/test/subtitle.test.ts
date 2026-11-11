import assert from 'node:assert/strict'
import test from 'node:test'
import {
  alignUnits,
  formatSrt,
  MAX_UNIT_CHARS,
  splitUnitsFallback,
  spokenLength,
  type SubtitleUnit,
} from '../src/subtitle.ts'

const LONG =
  '这是第一句话，里面有一些内容需要被拆开。这是第二句话，它同样需要被拆开成合适的字幕单元。第三句很短。第四句也很短。'

test('fallback splitter keeps every screen within the character budget', () => {
  const units = splitUnitsFallback(LONG)
  assert.ok(units.length > 0)
  for (const unit of units) {
    assert.ok(spokenLength(unit.text) <= MAX_UNIT_CHARS, `too long: ${unit.text}`)
    assert.ok(spokenLength(unit.text) > 0, 'empty unit')
  }
})

test('fallback splitter never starts a screen with a dangling particle', () => {
  const text = '我们讨论了很多问题，的的确确存在一些争议，了结了这件事之后才继续。'
  for (const unit of splitUnitsFallback(text)) {
    assert.ok(!['的', '了', '是', '在'].includes(unit.text[0] ?? ''), `bad start: ${unit.text}`)
  }
})

test('word boundaries produce exact timing that stays inside the audio', () => {
  const units: SubtitleUnit[] = [{ text: '第一句' }, { text: '第二句' }]
  const words = [
    { text: '第一', offsetMs: 0, durationMs: 400 },
    { text: '句', offsetMs: 400, durationMs: 200 },
    { text: '第二', offsetMs: 900, durationMs: 400 },
    { text: '句', offsetMs: 1300, durationMs: 200 },
  ]
  const aligned = alignUnits(units, 2000, words)
  assert.equal(aligned.quality, 'exact')
  assert.equal(aligned.units.length, 2)
  assert.equal(aligned.units[0]?.startMs, 0)
  assert.equal(aligned.units[1]?.startMs, 900)
  assert.ok((aligned.units[1]?.endMs ?? 0) <= 2000)
})

test('without word boundaries timing is proportional and marked estimated', () => {
  const units: SubtitleUnit[] = [{ text: '短句' }, { text: '这是一个更长的句子内容' }]
  const aligned = alignUnits(units, 6000)
  assert.equal(aligned.quality, 'estimated')
  assert.equal(aligned.units.length, 2)
  const [first, second] = aligned.units
  assert.ok(first !== undefined && second !== undefined)
  assert.ok(first.startMs < second.startMs)
  assert.ok(first.endMs <= second.startMs)
  assert.ok(second.endMs <= 6000)
  assert.ok(first.endMs - first.startMs >= 800, 'minimum on-screen time')
})

test('never lets a unit run past the end of the audio', () => {
  const units: SubtitleUnit[] = [{ text: '一二三四五六七八九十' }]
  const aligned = alignUnits(units, 500)
  assert.ok((aligned.units[0]?.endMs ?? 0) <= 500)
  assert.ok((aligned.units[0]?.endMs ?? 0) > (aligned.units[0]?.startMs ?? 0))
})

test('SRT output is ordered, monotonic, and blank-line separated', () => {
  const aligned = alignUnits([{ text: '第一屏' }, { text: '第二屏' }], 4000)
  const srt = formatSrt(aligned.units)
  const blocks = srt.trim().split('\n\n')
  assert.equal(blocks.length, 2)
  assert.match(blocks[0] ?? '', /^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n第一屏$/)
  assert.match(blocks[1] ?? '', /^2\n/)
})
