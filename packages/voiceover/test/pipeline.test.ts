import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Completer } from '../src/llm.ts'
import { chapterInputHash, fallbackOutline, normalizeSource, runProject } from '../src/pipeline.ts'
import type { Synthesizer } from '../src/types.ts'
import { validateManifest } from '../src/validate.ts'

const PARAGRAPHS = ['第一段讲背景。', '第二段讲问题。', '第三段讲方案。', '第四段讲实现。', '第五段讲结果。', '第六段讲结论。']
const TEXT = PARAGRAPHS.join('\n\n')

const OUTLINE_JSON = JSON.stringify({
  title: '测试文稿',
  chapters: [
    { id: 'ch-01', title: '背景与问题', sourceRange: [0, 2], summary: '背景与问题', estimatedChars: 40 },
    { id: 'ch-02', title: '方案与结论', sourceRange: [3, 5], summary: '方案与结论', estimatedChars: 40 },
  ],
})

const SCRIPT_JSON = JSON.stringify({
  script: '这是改写后的口播稿。第一句在这里。第二句在这里。',
  changes: [],
  risks: [],
})

const UNITS_JSON = JSON.stringify({
  units: [{ text: '这是改写后的口播稿' }, { text: '第一句在这里' }, { text: '第二句在这里' }],
})

/** Route a prompt to a canned response by its system role marker. */
function fakeCompleter(overrides: { auditIssues?: unknown[]; onCall?: () => void } = {}): Completer {
  return {
    model: 'fake',
    async complete(request) {
      overrides.onCall?.()
      if (request.system.includes('结构分析器')) {
        return JSON.stringify({ blockId: 'block-001', summary: '块摘要', chapterCandidates: [], crossRefs: [] })
      }
      if (request.system.includes('章节规划器')) return OUTLINE_JSON
      if (request.system.includes('稿件编辑')) {
        // Keep the chapter title in the script so a per-chapter failure can be
        // targeted by its source text.
        const title = /·\s*(.+)$/m.exec(request.user)?.[1]?.trim() ?? '本章'
        return JSON.stringify({
          script: `${title}的口播稿。第一句在这里。第二句在这里。`,
          changes: [],
          risks: [],
        })
      }
      if (request.system.includes('质检员')) {
        return JSON.stringify({ verdict: 'pass', issues: overrides.auditIssues ?? [] })
      }
      if (request.system.includes('字幕断句器')) return UNITS_JSON
      throw new Error(`unexpected prompt: ${request.system}`)
    },
  }
}

/** Write a tiny fake audio file and report timing facts. */
function fakeSynthesizer(options: { failOn?: string[] } = {}): Synthesizer & { calls: number } {
  const synthesizer = {
    calls: 0,
    async synthesize(request: { text: string; voice: string; rate: string }) {
      synthesizer.calls += 1
      if (options.failOn?.some((needle) => request.text.includes(needle))) {
        throw new Error('synthesis exploded')
      }
      const filePath = join(await mkdtemp(join(tmpdir(), 'vo-synth-')), 'out.mp3')
      await import('node:fs/promises').then((fs) => fs.writeFile(filePath, Buffer.from('ID3fake')))
      return {
        filePath,
        bytes: 1024,
        durationMs: 9000,
        timingQuality: 'estimated' as const,
        format: 'mp3' as const,
      }
    },
  }
  return synthesizer
}

test('fallback outline covers every paragraph exactly once', () => {
  const outline = fallbackOutline({ title: 't', paragraphs: PARAGRAPHS })
  const covered = outline.chapters.flatMap((chapter) => {
    const ids: number[] = []
    for (let i = chapter.sourceRange[0]; i <= chapter.sourceRange[1]; i += 1) ids.push(i)
    return ids
  })
  assert.deepEqual(covered, [0, 1, 2, 3, 4, 5])
})

test('runs a project end to end and writes a schema-valid manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vo-project-'))
  try {
    const result = await runProject(
      { completer: fakeCompleter(), synth: fakeSynthesizer() },
      { outputDir: dir, title: '测试文稿', text: TEXT, voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', style: 'news', network: true },
    )

    assert.equal(result.manifest.chapters.length, 2)
    assert.deepEqual(
      result.manifest.chapters.map((chapter) => chapter.status),
      ['done', 'done'],
    )
    assert.equal(result.manifest.totals.audioMs, 18_000)
    assert.equal(result.manifest.capability.llm, true)
    assert.equal(result.manifest.capability.timingQuality, 'estimated')
    // The schema is the contract: this must not throw.
    validateManifest(JSON.parse(await readFile(join(result.projectDir, 'manifest.json'), 'utf8')))

    const subtitle = await readFile(join(result.projectDir, 'audio', 'ch-01.est.srt'), 'utf8')
    assert.match(subtitle, /^1\n00:00:00,000 --> /)
    assert.match(subtitle, /2\n/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resumes without redoing unchanged chapters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vo-resume-'))
  try {
    let calls = 0
    const completer = fakeCompleter({ onCall: () => { calls += 1 } })
    const synth = fakeSynthesizer()
    const options = {
      outputDir: dir,
      title: '测试文稿',
      text: TEXT,
      voice: 'zh-CN-XiaoxiaoNeural',
      rate: '+0%',
      style: 'news' as const,
      network: true,
    }

    const first = await runProject({ completer, synth }, options)
    assert.equal(first.skipped.length, 0)
    const callsAfterFirst = calls
    const synthAfterFirst = synth.calls

    const second = await runProject({ completer, synth }, options)
    assert.deepEqual(second.skipped.sort(), ['ch-01', 'ch-02'])
    assert.equal(calls, callsAfterFirst, 'no model calls on a fully cached project')
    assert.equal(synth.calls, synthAfterFirst, 'no synthesis on a fully cached project')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a high-severity audit sends the chapter through one repair round', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vo-audit-'))
  try {
    let adaptations = 0
    const completer: Completer = {
      model: 'fake',
      async complete(request) {
        if (request.system.includes('结构分析器')) {
          return JSON.stringify({ blockId: 'b', summary: '', chapterCandidates: [], crossRefs: [] })
        }
        if (request.system.includes('章节规划器')) return OUTLINE_JSON
        if (request.system.includes('稿件编辑')) {
          adaptations += 1
          return SCRIPT_JSON
        }
        if (request.system.includes('质检员')) {
          return JSON.stringify({
            verdict: 'fix',
            issues: [{ severity: 'high', kind: 'omission', evidence: { source: '第三段讲方案。', script: '' }, fix: '补回方案那一段' }],
          })
        }
        if (request.system.includes('字幕断句器')) return UNITS_JSON
        throw new Error('unexpected prompt')
      },
    }

    const result = await runProject(
      { completer, synth: fakeSynthesizer() },
      { outputDir: dir, title: 't', text: TEXT, voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', style: 'news', network: true },
    )

    // Two chapters, both audited (sample = 2), both repaired once.
    assert.equal(adaptations, 4)
    assert.ok(result.manifest.warnings.some((warning) => warning.includes('high-severity')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed chapter is recorded and the rest still ship', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vo-fail-'))
  try {
    const result = await runProject(
      { completer: fakeCompleter(), synth: fakeSynthesizer({ failOn: ['方案与结论'] }) },
      { outputDir: dir, title: 't', text: TEXT, voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', style: 'news', network: true },
    )

    const statuses = result.manifest.chapters.map((chapter) => chapter.status)
    assert.deepEqual(statuses, ['done', 'failed'])
    assert.equal(result.manifest.totals.chapters, 1)
    assert.equal(result.manifest.chapters[1]?.error?.code, 'CHAPTER_FAILED')
    validateManifest(result.manifest)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('chapter input hash changes with style, so a style switch reruns', () => {
  const text = '同一段正文'
  assert.notEqual(chapterInputHash(text, 'news'), chapterInputHash(text, 'lecture'))
})

test('only processes the requested chapter and leaves the others untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vo-only-'))
  try {
    const options = {
      outputDir: dir,
      title: '测试文稿',
      text: TEXT,
      voice: 'zh-CN-XiaoxiaoNeural',
      rate: '+0%',
      style: 'news' as const,
      network: true,
    }
    const first = await runProject({ completer: fakeCompleter(), synth: fakeSynthesizer({ failOn: ['方案与结论'] }) }, options)
    assert.deepEqual(first.state.chapters.map((chapter) => chapter.status), ['done', 'failed'])
    const firstScript = first.state.chapters[0]?.script?.hash

    const second = await runProject(
      { completer: fakeCompleter(), synth: fakeSynthesizer() },
      { ...options, only: ['ch-02'] },
    )

    assert.deepEqual(second.skipped, [], 'untargeted chapters are not reported as hash-skips')
    assert.deepEqual(second.state.chapters.map((chapter) => chapter.status), ['done', 'done'])
    assert.equal(second.state.chapters[0]?.script?.hash, firstScript, 'ch-01 artifacts stay untouched')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unknown chapter id is rejected instead of silently doing nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vo-only-'))
  try {
    await assert.rejects(
      () =>
        runProject(
          { completer: fakeCompleter(), synth: fakeSynthesizer() },
          {
            outputDir: dir,
            title: 't',
            text: TEXT,
            voice: 'zh-CN-XiaoxiaoNeural',
            rate: '+0%',
            style: 'news',
            network: true,
            only: ['ch-09'],
          },
        ),
      /Unknown chapter/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('markdown syntax is stripped before anything is spoken', () => {
  const normalized = normalizeSource(
    ['# 标题', '', '这是**重点**，参见[文档](https://example.com/a)。', '', '```js', 'const x = 1', '```', '', '- 列表项', '> 引用'].join('\n'),
  )
  assert.equal(normalized.includes('#'), false)
  assert.equal(normalized.includes('**'), false)
  assert.equal(normalized.includes('https://'), false)
  assert.equal(normalized.includes('const x = 1'), false)
  assert.match(normalized, /重点/)
  assert.match(normalized, /文档/)
  assert.match(normalized, /列表项/)
})

test('fallback planning honours the chapter character target', () => {
  const paragraphs = Array.from({ length: 20 }, () => '这是一段测试正文，用来确认分章目标是否生效。')
  const wide = fallbackOutline({ title: 't', paragraphs, chapterChars: 400 })
  const narrow = fallbackOutline({ title: 't', paragraphs, chapterChars: 100 })
  assert.ok(narrow.chapters.length > wide.chapters.length, 'a smaller target must produce more chapters')
  assert.ok(wide.chapters.length >= 2)
})

test('a failed chapter keeps the engine error code instead of CHAPTER_FAILED', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vo-err-'))
  try {
    const throttled = {
      async synthesize() {
        const error = new Error('Unexpected server response: 429')
        Object.assign(error, { code: 'UPSTREAM_THROTTLED' })
        throw error
      },
    }
    const result = await runProject(
      { completer: fakeCompleter(), synth: throttled },
      {
        outputDir: dir,
        title: 't',
        text: TEXT,
        voice: 'zh-CN-XiaoxiaoNeural',
        rate: '+0%',
        style: 'news',
        network: true,
      },
    )
    assert.equal(result.state.chapters[0]?.status, 'failed')
    assert.equal(result.state.chapters[0]?.error?.code, 'UPSTREAM_THROTTLED')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})