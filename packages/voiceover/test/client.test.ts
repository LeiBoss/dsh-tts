import assert from 'node:assert/strict'
import test from 'node:test'

/** Shape of one registered lazy factory. */
interface LoadedModule {
  id: string
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

let captured: LoadedModule | undefined

/** The client file is a plain script: it needs the loader global before import. */
async function loadClient(reactOverride?: Record<string, unknown>): Promise<Record<string, unknown>> {
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
  const react = reactOverride ?? {
    createElement: () => null,
    useState: () => [null, () => {}],
    useEffect: () => {},
  }
  return captured.factory((specifier: string) => {
    assert.equal(specifier, 'react')
    return react
  })
}

/** One element produced by the recording React shim. */
interface Element {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

/**
 * Minimal React shim: records elements instead of rendering, and keeps hook
 * slots so a single component call sees stable state.
 */
function recordingReact(): { react: Record<string, unknown>; reset: () => void } {
  const cells: unknown[] = []
  let cursor = 0
  return {
    reset: () => {
      cursor = 0
    },
    react: {
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({
        type,
        props: props ?? {},
        children,
      }),
      useState: (initial: unknown) => {
        const index = cursor
        cursor += 1
        if (!(index in cells)) {
          cells[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
        }
        return [cells[index], () => {}]
      },
      useEffect: () => {},
    },
  }
}

/** Flatten a rendered tree into every element node. */
function collect(node: unknown, out: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if (typeof node !== 'object' || node === null) return out
  const element = node as Element
  out.push(element)
  for (const child of element.children ?? []) collect(child, out)
  return out
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

test('renders progress semantics, a live region and a keyboard focus style', async () => {
  const { react, reset } = recordingReact()
  const client = await loadClient(react)
  const seed = client.__seedSnapshot as (id: string, snapshot: unknown) => void
  const panel = client.VoiceoverPanel as (props: unknown) => unknown

  const projectId = 'abcdef123456'
  seed(projectId, {
    projectId,
    title: '接口测试',
    done: 1,
    total: 2,
    pending: 0,
    failed: 1,
    capability: { llm: true, network: true, wordBoundaries: true, timingQuality: 'exact' },
    engine: { name: 'edge-js', voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%' },
    chapters: [
      { id: 'ch-01', order: 1, title: '开头', status: 'done', durationMs: 61000, audioUrl: '/voiceover/audio/x' },
      { id: 'ch-02', order: 2, title: '结尾', status: 'failed', error: 'EDGE_TTS_FAILED' },
    ],
    warnings: [],
    warningCount: 0,
    stateUpdatedAt: new Date().toISOString(),
    servedAt: new Date().toISOString(),
  })
  reset()

  const tree = panel({ phase: 'result', block: { content: [{ text: `projectId: ${projectId}` }] } })
  const nodes = collect(tree)

  const progress = nodes.find((node) => node.props.role === 'progressbar')
  assert.ok(progress, 'the progress bar must expose a role')
  assert.equal(progress.props['aria-valuenow'], 1)
  assert.equal(progress.props['aria-valuemax'], 2)
  assert.match(String(progress.props['aria-valuetext']), /2 章中完成 1 章/)

  assert.ok(
    nodes.some((node) => node.props['aria-live'] === 'polite'),
    'progress changes must be announced',
  )
  assert.ok(
    nodes.some((node) => node.type === 'style' && String(node.children[0]).includes('focus-visible')),
    'keyboard focus must be visible',
  )

  const bulk = nodes.find((node) => node.type === 'button' && node.props.className === 'dsh-vo-btn')
  assert.ok(bulk, 'the retry button is a native, focusable button')
  assert.equal(bulk.props.disabled, false)
})
test('both dictionaries cover exactly the same keys', async () => {
  const client = await loadClient()
  const messages = client.__messages as Record<string, Record<string, string>>
  const zh = Object.keys(messages.zh).sort()
  const en = Object.keys(messages.en).sort()
  assert.deepEqual(en, zh, 'a translation must not drift from the source language')
  for (const key of zh) {
    assert.ok((messages.zh[key] ?? '').length > 0, `zh.${key} is empty`)
    assert.ok((messages.en[key] ?? '').length > 0, `en.${key} is empty`)
  }
})

test('registers both locales under its namespace and follows changes', async () => {
  const client = await loadClient()
  const apply = client.apply as (ctx: unknown) => void

  const registered: string[] = []
  const boundTo: string[] = []
  const slotKeys: string[] = []
  let subscribed = false
  const catalog: Record<string, string> = { 'group.label': 'Voiceover progress' }
  const locale = {
    register(namespace: string, code: string) {
      registered.push(`${namespace}:${code}`)
      return () => {}
    },
    bind(namespace: string) {
      boundTo.push(namespace)
      return (key: string) => catalog[key] ?? key
    },
    getSnapshot() {
      return { active: 'en', locales: [], revision: 1 }
    },
    subscribe() {
      subscribed = true
      return () => {}
    },
  }

  apply({
    get: (key: string) => (key === 'locale' ? locale : undefined),
    slots: {
      inject: (_name: string, generator: () => Generator<unknown>) => {
        for (const _ of generator()) {
          // Drain to run the registrations.
        }
      },
      register: (options: { key: string }) => {
        slotKeys.push(options.key)
        return () => {}
      },
    },
  })

  assert.deepEqual(registered.sort(), ['voiceover:en', 'voiceover:zh'])
  assert.deepEqual(boundTo, ['voiceover'])
  assert.ok(subscribed, 'the panel follows live locale switches')
  assert.deepEqual(slotKeys, ['voiceover_create', 'voiceover_status'])
})
test('parses SRT into cues and finds the line at a clock position', async () => {
  const client = await loadClient()
  const parseSrt = client.parseSrt as (text: string) => { startMs: number; endMs: number; text: string }[]
  const cueAt = client.cueAt as (cues: unknown, ms: number) => string

  const cues = parseSrt(
    '1\r\n00:00:00,050 --> 00:00:01,737\r\n第一屏\r\n\r\n2\r\n00:00:02,000 --> 00:00:05,975\r\n第二屏\r\n第二行\r\n',
  )
  assert.equal(cues.length, 2)
  assert.deepEqual(cues[0], { startMs: 50, endMs: 1737, text: '第一屏' })
  assert.equal(cues[1]?.text, '第二屏\n第二行')

  assert.equal(cueAt(cues, 1000), '第一屏')
  assert.equal(cueAt(cues, 1800), '', 'between cues nothing is shown')
  assert.equal(cueAt(cues, 3000), '第二屏\n第二行')

  // Malformed input must not throw or invent cues.
  assert.deepEqual(parseSrt('not a subtitle'), [])
  assert.deepEqual(parseSrt(''), [])
  assert.equal(cueAt(undefined, 0), '')
})