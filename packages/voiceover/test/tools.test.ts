import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { apply, createVoiceoverTools } from '../src/index.ts'
import { normalizeSource, projectKey } from '../src/pipeline.ts'

const PROJECT_ID = 'abcdef123456'

/** Minimal host context: a recording tool registry and an optional fake engine. */
function fakeContext(tts?: unknown): { ctx: Context; registered: { name: string }[] } {
  const registered: { name: string }[] = []
  const ctx = {
    tools: { register: (tool: { name: string }) => (registered.push(tool), () => {}) },
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {} }),
    get: (key: string) => (key === 'tts' ? tts : undefined),
    effect: (fn: () => unknown) => fn(),
    inject: () => {},
  } as unknown as Context
  return { ctx, registered }
}

/** A fake `ctx.tts` that reports a fixed audio file. */
function fakeTts(filePath: string): unknown {
  return {
    capabilities: { wordBoundaries: true, formats: ['mp3'], offline: false },
    async synthesize() {
      return {
        kind: 'audio',
        filePath,
        format: 'mp3',
        durationMs: 1000,
        timingQuality: 'exact',
        engine: 'edge-js',
        fromCache: false,
      }
    },
  }
}

/** Tools by name, from the factory. */
async function tools(env: NodeJS.ProcessEnv, tts?: unknown): Promise<Record<string, Record<string, unknown>>> {
  const { ctx } = fakeContext(tts)
  const list = createVoiceoverTools(ctx, {}, env) as unknown as Record<string, unknown>[]
  return Object.fromEntries(list.map((tool) => [String(tool.name), tool]))
}

/** Render function of a tool definition (it lives under `output`). */
function renderOf(tool: Record<string, unknown>): (args: unknown, value: unknown) => { text: string }[] {
  const output = tool.output as { render?: (args: unknown, value: unknown) => { text: string }[] } | undefined
  assert.ok(typeof output?.render === 'function', 'the tool must expose a render function')
  return output.render
}

/** Windows keeps a directory busy for a moment after a background write. */
async function removeWithRetry(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
/** Wait for a file the background run writes, so cleanup cannot race it. */
async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      await stat(path)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error(`timed out waiting for ${path}`)
}

/** Persist a project whose state the read-only tools can answer from. */
async function seed(outputDir: string): Promise<void> {
  const dir = join(outputDir, PROJECT_ID)
  await mkdir(join(dir, 'state'), { recursive: true })
  await mkdir(join(dir, 'audio'), { recursive: true })
  await writeFile(join(dir, 'audio', 'ch-01.mp3'), Buffer.from('ID3'))
  await writeFile(
    join(dir, 'state', 'state.json'),
    JSON.stringify({
      projectId: PROJECT_ID,
      sourceHash: 'a'.repeat(64),
      promptVersion: 'p1.3',
      engine: { name: 'edge-js', voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%' },
      capability: { llm: false, network: true, wordBoundaries: false, timingQuality: 'exact' },
      style: 'news',
      outline: {
        title: '工具测试',
        chapters: [{ id: 'ch-01', title: '开头', summary: '', sourceRange: [0, 1], estimatedChars: 10 }],
      },
      chapters: [
        {
          id: 'ch-01',
          order: 1,
          title: '开头',
          chars: 10,
          sourceRange: [0, 1],
          status: 'done',
          audio: { path: 'audio/ch-01.mp3', bytes: 3, durationMs: 1000, timingQuality: 'exact', format: 'mp3' },
          subtitles: { path: 'audio/ch-01.srt', units: 1, timingQuality: 'exact' },
        },
      ],
      inputHashes: {},
      warnings: [],
      createdAt: '2026-11-14T00:00:00.000Z',
    }),
  )
}

test('apply registers all four tools', () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, {})
  assert.deepEqual(
    registered.map((tool) => tool.name),
    ['voiceover_create', 'voiceover_status', 'voiceover_export', 'voiceover_rerun'],
  )
})

test('voiceover_create validates its source before starting anything', async () => {
  const tool = (await tools({ DSH_HOME: 'C:\\tmp' })).voiceover_create ?? {}
  const execute = tool.execute as (args: Record<string, unknown>) => Promise<unknown>

  await assert.rejects(() => execute({}), /Provide either sourcePath or sourceText/)
  await assert.rejects(() => execute({ sourcePath: 'C:\\doc.pdf' }), /Only \.md and \.txt/)
})

test('voiceover_create derives a deterministic project id from the normalised text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-tools-'))
  try {
    const audio = join(root, 'clip.mp3')
    await writeFile(audio, Buffer.from('ID3'))
    const create = (await tools({ DSH_HOME: root }, fakeTts(audio))).voiceover_create ?? {}
    const execute = create.execute as (args: Record<string, unknown>) => Promise<Record<string, unknown>>
    const text = '# 标题\n\n正文第一段。'

    const result = await execute({ sourceText: text, voice: 'zh-CN-YunxiNeural', style: 'lecture' })
    const expected = projectKey({
      text: normalizeSource(text),
      voice: 'zh-CN-YunxiNeural',
      rate: '+0%',
      style: 'lecture',
    })
    assert.equal(result.projectId, expected)
    assert.equal(result.status, 'running')
    assert.equal(result.projectDir, join(root, 'voiceover', expected))

    const rendered = renderOf(create)({}, result)
    assert.match(rendered[0]?.text ?? '', /projectId: /)

    // The run continues in the background; its manifest marks completion.
    await waitForFile(join(root, 'voiceover', expected, 'manifest.json'))
  } finally {
    await removeWithRetry(root)
  }
})

test('voiceover_create reads a file source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-tools-'))
  try {
    const audio = join(root, 'clip.mp3')
    await writeFile(audio, Buffer.from('ID3'))
    const source = join(root, '我的文章.md')
    await writeFile(source, '一段正文。\n\n另一段。', 'utf8')

    const create = (await tools({ DSH_HOME: root }, fakeTts(audio))).voiceover_create ?? {}
    const result = (await (create.execute as (args: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      sourcePath: source,
    })) as Record<string, unknown>

    assert.ok(String(result.projectId).length >= 8)
    await waitForFile(join(root, 'voiceover', String(result.projectId), 'manifest.json'))
  } finally {
    await removeWithRetry(root)
  }
})

test('voiceover_status answers from persisted state and renders the project id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-tools-'))
  try {
    await seed(join(root, 'voiceover'))
    const status = (await tools({ DSH_HOME: root })).voiceover_status ?? {}
    const execute = status.execute as (args: Record<string, unknown>) => Promise<Record<string, unknown>>

    const result = await execute({ projectId: PROJECT_ID })
    assert.equal(result.done, 1)
    assert.equal(result.total, 1)
    const chapters = result.chapters as Record<string, unknown>[]
    assert.equal(chapters[0]?.status, 'done')
    assert.equal(chapters[0]?.durationMs, 1000)
    assert.equal(chapters[0]?.subtitles, 'audio/ch-01.srt')

    const rendered = renderOf(status)({}, result)
    assert.match(rendered[0]?.text ?? '', new RegExp(`projectId: ${PROJECT_ID}`))

    await assert.rejects(() => execute({ projectId: 'deadbeef00' }), /Unknown project/)
  } finally {
    await removeWithRetry(root)
  }
})

test('voiceover_export lists absolute artifact paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-tools-'))
  try {
    await seed(join(root, 'voiceover'))
    const exportTool = (await tools({ DSH_HOME: root })).voiceover_export ?? {}
    const execute = exportTool.execute as (args: Record<string, unknown>) => Promise<Record<string, unknown>>

    const result = await execute({ projectId: PROJECT_ID })
    assert.deepEqual(result.audio, [join(root, 'voiceover', PROJECT_ID, 'audio', 'ch-01.mp3')])
    assert.equal(result.manifest, join(root, 'voiceover', PROJECT_ID, 'manifest.json'))
    await assert.rejects(() => execute({ projectId: 'nope' }), /Unknown project/)
  } finally {
    await removeWithRetry(root)
  }
})

test('voiceover_rerun validates the chapter id and returns immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-tools-'))
  try {
    const rerun = (await tools({ DSH_HOME: root })).voiceover_rerun ?? {}
    const execute = rerun.execute as (args: Record<string, unknown>) => Promise<Record<string, unknown>>

    await assert.rejects(() => execute({ projectId: PROJECT_ID, chapter: 'nope' }), /chapter must look like ch-03/)

    const result = await execute({ projectId: PROJECT_ID, chapter: 'ch-02' })
    assert.equal(result.status, 'running')
    assert.equal(result.projectId, PROJECT_ID)

    const rendered = renderOf(rerun)({}, result)
    assert.match(rendered[0]?.text ?? '', /Resuming project/)
  } finally {
    await removeWithRetry(root)
  }
})
