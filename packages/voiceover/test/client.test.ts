import assert from 'node:assert/strict'
import test from 'node:test'

/** Shape of one registered lazy factory. */
interface LoadedModule {
  id: string
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

let captured: LoadedModule | undefined

/** The client file is a plain script: it needs the loader global before import. */
async function loadClient(): Promise<Record<string, unknown>> {
  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = {
    __ModuleLoader__: {
      load: (module: LoadedModule) => {
        captured = module
      },
    },
  }
  await import('../client/client.js')
  assert.ok(captured, 'the client bundle must register a factory')
  assert.equal(captured.id, '@leiboss/dsh-voiceover')
  const react = { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {} }
  return captured.factory((specifier: string) => {
    assert.equal(specifier, 'react')
    return react
  })
}

test('parses the project id out of a rendered tool result', async () => {
  const client = await loadClient()
  const projectIdFrom = client.projectIdFrom as (blocks: { text?: string }[]) => string | undefined

  assert.equal(
    projectIdFrom([{ text: 'Voiceover project abc123456789 started.\nprojectId: abc123456789' }]),
    'abc123456789',
  )
  assert.equal(projectIdFrom([{ text: 'other output' }]), undefined)
  assert.equal(projectIdFrom([]), undefined)
  // A non-hex token must not be mistaken for a project id.
  assert.equal(projectIdFrom([{ text: 'projectId: ../../../etc' }]), undefined)
})

test('formats chapter durations as m:ss', async () => {
  const client = await loadClient()
  const formatDuration = client.formatDuration as (ms?: number) => string

  assert.equal(formatDuration(61000), '1:01')
  assert.equal(formatDuration(6384), '0:06')
  assert.equal(formatDuration(125000), '2:05')
  assert.equal(formatDuration(undefined), '')
  assert.equal(formatDuration(0), '')
})

test('registers a view for both voiceover tools and nothing else', async () => {
  const client = await loadClient()
  const apply = client.apply as (ctx: unknown) => void
  const keys: string[] = []

  const ctx = {
    slots: {
      inject: (_name: string, generator: () => Generator<unknown>) => {
        for (const _ of generator()) {
          // Draining the generator is what registers the occupants.
        }
      },
      register: (options: { key: string }) => {
        keys.push(options.key)
        return () => {}
      },
    },
  }
  apply(ctx)

  assert.deepEqual(keys, ['voiceover_create', 'voiceover_status'])
})

test('distinguishes running, done and ended-with-failures', async () => {
  const client = await loadClient()
  const stateWord = client.stateWord as (snapshot: Record<string, unknown>) => string

  assert.equal(
    stateWord({ pending: 2, failed: 0, done: 1, total: 3, chapters: [{ id: 'ch-02', status: 'synthesized' }] }),
    '生成中 · ch-02 合成',
  )
  // 6 done + 2 failed must not read as "still working".
  assert.equal(stateWord({ pending: 0, failed: 2, done: 6, total: 8, chapters: [] }), '已结束 · 2 章失败')
  assert.equal(stateWord({ pending: 0, failed: 0, done: 8, total: 8, chapters: [] }), '已完成')
  assert.equal(stateWord({ pending: 0, failed: 0, done: 0, total: 0, chapters: [] }), '准备中')
})

test('maps pipeline warnings to user sentences and leaves unknown ones readable', async () => {
  const client = await loadClient()
  const warningText = client.warningText as (warning: string) => string

  assert.equal(
    warningText('capability.llm=false: chapters were split by length, no spoken-script adaptation ran'),
    '未配置模型：按原文朗读，未做口语化改写',
  )
  assert.equal(warningText('outline merge failed (Error: boom)'), '章节规划失败，已按长度均分')
  assert.equal(warningText('ch-03: failed with EDGE_TTS_FAILED'), 'ch-03: failed with EDGE_TTS_FAILED')
})

test('treats an unparsable timestamp as unknown instead of fresh', async () => {
  const client = await loadClient()
  const formatClock = client.formatClock as (iso?: string) => string

  assert.equal(formatClock(undefined), '')
  assert.equal(formatClock('1970-01-01T00:00:00.000Z'), '')
  assert.match(formatClock(new Date().toISOString()), /^\d{2}:\d{2}:\d{2}$/)
})
