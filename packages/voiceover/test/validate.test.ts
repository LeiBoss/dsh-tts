import assert from 'node:assert/strict'
import test from 'node:test'
import { callJson, extractJson, LlmError, type Completer } from '../src/llm.ts'
import { coverageErrors } from '../src/prompts.ts'
import { ValidationError, validateManifest, validateOutline } from '../src/validate.ts'

const VALID_OUTLINE = {
  title: '一篇长文',
  chapters: [
    { id: 'ch-01', title: '开头', sourceRange: [0, 4], summary: '开头', estimatedChars: 100 },
    { id: 'ch-02', title: '结尾', sourceRange: [5, 9], summary: '结尾', estimatedChars: 100 },
  ],
}

const VALID_MANIFEST = {
  schemaVersion: 1,
  projectId: 'abcdef123456',
  createdAt: '2026-11-11T14:30:00.000Z',
  title: '一篇长文',
  capability: { llm: true, network: true, wordBoundaries: false, timingQuality: 'estimated' },
  engine: { name: 'edge-py', voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%' },
  promptVersion: 'p1.3',
  source: { path: 'source/normalized.md', hash: `sha256:${'a'.repeat(64)}`, chars: 100 },
  chapters: [
    {
      id: 'ch-01',
      order: 1,
      title: '开头',
      chars: 50,
      sourceRange: [0, 4],
      status: 'done',
      audio: { path: 'audio/ch-01.mp3', bytes: 100, durationMs: 1000, timingQuality: 'estimated' },
      subtitles: { path: 'audio/ch-01.est.srt', units: 3, timingQuality: 'estimated' },
    },
  ],
  totals: { chapters: 1, chars: 50, audioMs: 1000, bytes: 100 },
  warnings: [],
}

test('accepts a well-formed outline', () => {
  const outline = validateOutline(VALID_OUTLINE)
  assert.equal(outline.chapters.length, 2)
})

test('reports the JSON path of a bad field', () => {
  try {
    validateOutline({ ...VALID_OUTLINE, chapters: [{ ...VALID_OUTLINE.chapters[0], id: 'nope' }] })
    assert.fail('expected a ValidationError')
  } catch (error) {
    assert.ok(error instanceof ValidationError)
    assert.equal(error.path, '/chapters/0/id')
  }
})

test('coverage rejects gaps and overlaps', () => {
  const gapped = validateOutline({
    title: 't',
    chapters: [
      { id: 'ch-01', title: 'a', sourceRange: [0, 2], summary: '', estimatedChars: 1 },
      { id: 'ch-02', title: 'b', sourceRange: [4, 6], summary: '', estimatedChars: 1 },
    ],
  })
  const errors = coverageErrors(gapped, 7)
  assert.ok(errors.length > 0)
  assert.match(errors[0] ?? '', /starts at 4/)
})

test('accepts a complete manifest and rejects a missing capability', () => {
  assert.doesNotThrow(() => validateManifest(VALID_MANIFEST))
  const broken = { ...VALID_MANIFEST, capability: { llm: true } }
  assert.throws(() => validateManifest(broken), ValidationError)
})

test('extracts JSON from fenced replies', () => {
  assert.deepEqual(extractJson('好的：\n```json\n{"a":1}\n```'), { a: 1 })
})

test('repairs a structurally invalid reply instead of failing the run', async () => {
  let calls = 0
  const completer: Completer = {
    async complete() {
      calls += 1
      return calls === 1 ? '这不是 JSON' : JSON.stringify({ units: [{ text: '好的' }] })
    },
  }
  const result = await callJson(
    completer,
    { system: 's', user: 'u' },
    (value) => value as { units: { text: string }[] },
  )
  assert.equal(calls, 2)
  assert.equal(result.units[0]?.text, '好的')
})

test('gives up with a routable code after the repair budget is spent', async () => {
  const completer: Completer = { async complete() { return 'still not json' } }
  await assert.rejects(
    () => callJson(completer, { system: 's', user: 'u' }, (value) => value, { repairRounds: 1 }),
    (error: unknown) => error instanceof LlmError && error.code === 'LLM_SCHEMA_INVALID',
  )
})
