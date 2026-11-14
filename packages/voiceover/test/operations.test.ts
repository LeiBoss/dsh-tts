import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Completer } from '../src/llm.ts'
import { loadRerunPlan, rerunProject } from '../src/operations.ts'
import { runProject } from '../src/pipeline.ts'
import type { Synthesizer } from '../src/types.ts'

const TEXT = ['第一段讲背景。', '第二段讲问题。', '第三段讲方案。', '第四段讲实现。', '第五段讲结果。', '第六段讲结论。'].join('\n\n')

const OUTLINE = JSON.stringify({
  title: '续跑测试',
  chapters: [
    { id: 'ch-01', title: '背景', sourceRange: [0, 2], summary: '背景', estimatedChars: 40 },
    { id: 'ch-02', title: '方案', sourceRange: [3, 5], summary: '方案', estimatedChars: 40 },
  ],
})

/** Canned model replies; the script keeps the chapter title so failures are targetable. */
function completer(): Completer {
  return {
    model: 'fake',
    async complete(request) {
      if (request.system.includes('结构分析器')) {
        return JSON.stringify({ blockId: 'b', summary: '', chapterCandidates: [], crossRefs: [] })
      }
      if (request.system.includes('章节规划器')) return OUTLINE
      if (request.system.includes('稿件编辑')) {
        const title = /·\s*(.+)$/m.exec(request.user)?.[1]?.trim() ?? '本章'
        return JSON.stringify({ script: `${title}的口播稿。第一句。`, changes: [], risks: [] })
      }
      if (request.system.includes('质检员')) return JSON.stringify({ verdict: 'pass', issues: [] })
      if (request.system.includes('字幕断句器')) return JSON.stringify({ units: [{ text: '第一屏' }] })
      throw new Error(`unexpected prompt: ${request.system}`)
    },
  }
}

/** Synthesizer that fails while `needle` matches the text it receives. */
function synth(failOn: { needle?: string } = {}): Synthesizer & { calls: number } {
  const state = {
    calls: 0,
    async synthesize(request: { text: string }) {
      state.calls += 1
      if (failOn.needle !== undefined && request.text.includes(failOn.needle)) {
        throw new Error('synthesis exploded')
      }
      const dir = await mkdtemp(join(tmpdir(), 'vo-rerun-'))
      const filePath = join(dir, 'out.mp3')
      await (await import('node:fs/promises')).writeFile(filePath, Buffer.from('ID3fake'))
      return { filePath, bytes: 10, durationMs: 5000, timingQuality: 'estimated' as const, format: 'mp3' as const }
    },
  }
  return state
}

test('resumes a project: finished chapters are skipped, the failed one runs again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-rerun-project-'))
  try {
    const options = {
      outputDir: root,
      title: '续跑测试',
      text: TEXT,
      voice: 'zh-CN-XiaoxiaoNeural',
      rate: '+0%',
      style: 'news' as const,
      network: true,
    }

    const first = await runProject({ completer: completer(), synth: synth({ needle: '方案' }) }, options)
    const statuses = first.state.chapters.map((chapter) => chapter.status)
    assert.deepEqual(statuses, ['done', 'failed'])
    // The style is persisted now, which is what makes a rerun reproducible.
    assert.equal(first.state.style, 'news')

    const second = await rerunProject(
      { completer: completer(), synth: synth() },
      { outputDir: root, projectId: first.projectId },
    )

    assert.equal(second.projectId, first.projectId, 'a rerun must not fork the project')
    assert.deepEqual(second.skipped, ['ch-01'], 'the finished chapter is skipped')
    assert.deepEqual(
      second.state.chapters.map((chapter) => chapter.status),
      ['done', 'done'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rebuilds the run options from persisted state, not from the caller', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-rerun-plan-'))
  try {
    const result = await runProject(
      { completer: completer(), synth: synth() },
      {
        outputDir: root,
        title: '续跑测试',
        text: TEXT,
        voice: 'zh-CN-XiaoxiaoNeural',
        rate: '+5%',
        style: 'lecture',
        network: true,
        auditSample: 0,
      },
    )

    const loaded = await loadRerunPlan(root, result.projectId)
    assert.ok(loaded)
    assert.equal(loaded.plan.voice, 'zh-CN-XiaoxiaoNeural')
    assert.equal(loaded.plan.rate, '+5%')
    assert.equal(loaded.plan.style, 'lecture')
    assert.equal(loaded.plan.title, '续跑测试')
    // The source text comes from disk, so a rerun cannot swap documents.
    assert.match(loaded.plan.text, /第一段讲背景/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses an unknown or malformed project id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-rerun-missing-'))
  try {
    await assert.rejects(
      () => rerunProject({ completer: completer(), synth: synth() }, { outputDir: root, projectId: 'deadbeef00' }),
      /Unknown project/,
    )
    await assert.rejects(
      () => rerunProject({ completer: completer(), synth: synth() }, { outputDir: root, projectId: '../../etc' }),
      /Unknown project/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a chapter-scoped rerun touches only that chapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-rerun-one-'))
  try {
    const options = {
      outputDir: root,
      title: '续跑测试',
      text: TEXT,
      voice: 'zh-CN-XiaoxiaoNeural',
      rate: '+0%',
      style: 'news' as const,
      network: true,
    }
    const first = await runProject({ completer: completer(), synth: synth({ needle: '方案' }) }, options)
    assert.deepEqual(first.state.chapters.map((chapter) => chapter.status), ['done', 'failed'])
    const firstScript = first.state.chapters[0]?.script?.hash

    const second = await rerunProject(
      { completer: completer(), synth: synth() },
      { outputDir: root, projectId: first.projectId, chapters: ['ch-02'] },
    )

    assert.deepEqual(second.state.chapters.map((chapter) => chapter.status), ['done', 'done'])
    assert.equal(second.state.chapters[0]?.script?.hash, firstScript)
    assert.deepEqual(second.skipped, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})