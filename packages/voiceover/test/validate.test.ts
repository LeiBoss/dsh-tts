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

/** Deep-copy a fixture so each case mutates its own object. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

test('outline validation reports every broken field at its JSON path', () => {
  const cases: [string, (outline: any) => void, string][] = [
    ['empty title', (o) => { o.title = '' }, '/title'],
    ['long title', (o) => { o.title = 'x'.repeat(61) }, '/title'],
    ['bad chapter id', (o) => { o.chapters[0].id = 'chapter-1' }, '/chapters/0/id'],
    ['long chapter title', (o) => { o.chapters[0].title = 'x'.repeat(15) }, '/chapters/0/title'],
    ['long summary', (o) => { o.chapters[0].summary = 'x'.repeat(81) }, '/chapters/0/summary'],
    ['range not an array', (o) => { o.chapters[0].sourceRange = 5 }, '/chapters/0/sourceRange'],
    ['range inverted', (o) => { o.chapters[0].sourceRange = [5, 1] }, '/chapters/0/sourceRange'],
    ['range negative', (o) => { o.chapters[0].sourceRange = [-1, 3] }, '/chapters/0/sourceRange/0'],
    ['non-integer char count', (o) => { o.chapters[0].estimatedChars = 1.5 }, '/chapters/0/estimatedChars'],
    ['crossRefs not an array', (o) => { o.chapters[0].crossRefs = 'x' }, '/chapters/0/crossRefs'],
    ['crossRef too long', (o) => { o.chapters[0].crossRefs = ['x'.repeat(41)] }, '/chapters/0/crossRefs/0'],
    ['note too long', (o) => { o.chapters[0].note = 'x'.repeat(121) }, '/chapters/0/note'],
    ['no chapters', (o) => { o.chapters = [] }, '/chapters'],
    [
      'too many chapters',
      (o) => {
        o.chapters = Array.from({ length: 41 }, (_, index) => ({
          ...o.chapters[0],
          id: `ch-${String(index + 1).padStart(2, '0')}`,
        }))
      },
      '/chapters',
    ],
  ]

  for (const [name, mutate, path] of cases) {
    const outline = clone(VALID_OUTLINE) as any
    mutate(outline)
    try {
      validateOutline(outline)
      assert.fail(`${name}: expected a ValidationError`)
    } catch (error) {
      assert.ok(error instanceof ValidationError, `${name}: wrong error type`)
      assert.equal(error.path, path, `${name}: wrong path`)
    }
  }
})

test('manifest validation reports every broken field at its JSON path', () => {
  const cases: [string, (manifest: any) => void, string][] = [
    ['bad schema version', (m) => { m.schemaVersion = 2 }, '/schemaVersion'],
    ['non-hex project id', (m) => { m.projectId = 'ZZZZZZZZ' }, '/projectId'],
    ['short project id', (m) => { m.projectId = 'abc' }, '/projectId'],
    ['missing createdAt', (m) => { delete m.createdAt }, '/createdAt'],
    ['bad prompt version', (m) => { m.promptVersion = '1.3' }, '/promptVersion'],
    ['capability missing a flag', (m) => { delete m.capability.llm }, '/capability/llm'],
    ['bad timing quality', (m) => { m.capability.timingQuality = 'good' }, '/capability/timingQuality'],
    ['bad engine name', (m) => { m.engine.name = 'google' }, '/engine/name'],
    ['bad rate', (m) => { m.engine.rate = 'fast' }, '/engine/rate'],
    ['bad source hash', (m) => { m.source.hash = 'sha256:abc' }, '/source/hash'],
    ['zero source chars', (m) => { m.source.chars = 0 }, '/source/chars'],
    ['no chapters', (m) => { m.chapters = [] }, '/chapters'],
    ['bad chapter status', (m) => { m.chapters[0].status = 'built' }, '/chapters/0/status'],
    ['bad chapter order', (m) => { m.chapters[0].order = 0 }, '/chapters/0/order'],
    ['bad audio bytes', (m) => { m.chapters[0].audio.bytes = 0 }, '/chapters/0/audio/bytes'],
    ['bad audio quality', (m) => { m.chapters[0].audio.timingQuality = 'maybe' }, '/chapters/0/audio/timingQuality'],
    [
      'error flag not boolean',
      (m) => {
        m.chapters[0].error = { code: 'X', message: 'y', retryable: 'yes' }
      },
      '/chapters/0/error/retryable',
    ],
    ['negative totals', (m) => { m.totals.bytes = -1 }, '/totals/bytes'],
    ['long warning', (m) => { m.warnings = ['x'.repeat(201)] }, '/warnings/0'],
  ]

  for (const [name, mutate, path] of cases) {
    const manifest = clone(VALID_MANIFEST) as any
    mutate(manifest)
    try {
      validateManifest(manifest)
      assert.fail(`${name}: expected a ValidationError`)
    } catch (error) {
      assert.ok(error instanceof ValidationError, `${name}: wrong error type`)
      assert.equal(error.path, path, `${name}: wrong path`)
    }
  }
})