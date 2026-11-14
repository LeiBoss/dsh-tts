import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PANEL_ROUTE_PREFIX, PanelRoute, type RegisterableRoute } from '../src/panel.ts'

const PROJECT_ID = 'abcdef123456'

/** Windows keeps a directory busy for a moment after a write. */
async function removeWithRetry(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

/** Persist a minimal but schema-shaped project state. */
async function seedProject(root: string, projectId = PROJECT_ID): Promise<void> {
  const dir = join(root, projectId, 'state')
  await mkdir(dir, { recursive: true })
  const state = {
    projectId,
    sourceHash: 'a'.repeat(64),
    promptVersion: 'p1.3',
    engine: { name: 'edge-js', voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%' },
    capability: { llm: true, network: true, wordBoundaries: true, timingQuality: 'exact' },
    outline: {
      title: '测试文稿',
      chapters: [
        { id: 'ch-01', title: '开头', summary: '', sourceRange: [0, 1], estimatedChars: 10 },
        { id: 'ch-02', title: '结尾', summary: '', sourceRange: [2, 3], estimatedChars: 10 },
      ],
    },
    chapters: [
      {
        id: 'ch-01',
        order: 1,
        title: '开头',
        chars: 10,
        sourceRange: [0, 1],
        status: 'done',
        audio: { path: 'audio/ch-01.mp3', bytes: 10, durationMs: 61000, timingQuality: 'exact', format: 'mp3' },
        subtitles: { path: 'audio/ch-01.srt', units: 3, timingQuality: 'exact' },
      },
      { id: 'ch-02', order: 2, title: '结尾', chars: 10, sourceRange: [2, 3], status: 'synthesized' },
    ],
    inputHashes: {},
    warnings: ['ch-02: retrying'],
    createdAt: '2026-11-14T00:00:00.000Z',
  }
  await writeFile(join(dir, 'state.json'), JSON.stringify(state), 'utf8')
}

/** Capture the single route a registrar receives. */
function fakeServer(): { route: RegisterableRoute; server: { register: (route: RegisterableRoute) => () => void } } {
  const box: { route?: RegisterableRoute } = {}
  return {
    get route() {
      return box.route as RegisterableRoute
    },
    server: {
      register(route: RegisterableRoute) {
        box.route = route
        return () => {}
      },
    },
  } as unknown as { route: RegisterableRoute; server: { register: (route: RegisterableRoute) => () => void } }
}

/** Minimal response double that records status and body. */
function fakeResponse(): { res: ServerResponse; status: () => number; body: () => string } {
  const state = { status: 0, body: '' }
  const res = {
    headersSent: false,
    writeHead(status: number) {
      state.status = status
      return res
    },
    end(payload?: string | Buffer) {
      state.body = payload === undefined ? '' : String(payload)
      return res
    },
  } as unknown as ServerResponse
  return { res, status: () => state.status, body: () => state.body }
}

/** Minimal request double; iterable so the body can be read. */
function fakeRequest(url: string, method = 'GET', body?: unknown): IncomingMessage {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  } as unknown as IncomingMessage
}

test('serves a snapshot with progress, chapters and warnings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-panel-'))
  try {
    await seedProject(root)
    const route = new PanelRoute({ outputDir: root })
    const server = fakeServer()
    route.register(server.server)

    assert.equal(server.route.path, PANEL_ROUTE_PREFIX)
    assert.equal(server.route.kind, 'prefix')

    const { res, status, body } = fakeResponse()
    await server.route.handler(fakeRequest(`${PANEL_ROUTE_PREFIX}/${PROJECT_ID}.json`), res)

    assert.equal(status(), 200)
    const snapshot = JSON.parse(body())
    assert.equal(snapshot.projectId, PROJECT_ID)
    assert.equal(snapshot.title, '测试文稿')
    assert.equal(snapshot.done, 1)
    assert.equal(snapshot.total, 2)
    // One done + one still running: the panel must keep polling.
    assert.equal(snapshot.pending, 1)
    assert.equal(snapshot.chapters[0].durationMs, 61000)
    assert.equal(snapshot.chapters[1].status, 'synthesized')
    assert.deepEqual(snapshot.warnings, ['ch-02: retrying'])
    // `stateUpdatedAt` is the state-file mtime, so it must look recent; a
    // request time (or an epoch fallback) would make a stalled run look fresh.
    assert.equal(snapshot.warningCount, 1)
    assert.ok(Date.parse(snapshot.stateUpdatedAt) > Date.now() - 60_000)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses without the host session fence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-panel-'))
  try {
    await seedProject(root)
    const route = new PanelRoute({ outputDir: root, connection: { requestRejection: () => 401 } })
    const server = fakeServer()
    route.register(server.server)

    const { res, status } = fakeResponse()
    await server.route.handler(fakeRequest(`${PANEL_ROUTE_PREFIX}/${PROJECT_ID}.json`), res)
    assert.equal(status(), 401)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects unknown projects, malformed names and non-GET methods', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-panel-'))
  try {
    await seedProject(root)
    const route = new PanelRoute({ outputDir: root })
    const server = fakeServer()
    route.register(server.server)

    const cases: [string, string, number][] = [
      [`${PANEL_ROUTE_PREFIX}/deadbeef00.json`, 'GET', 404],
      [`${PANEL_ROUTE_PREFIX}/not-a-project.json`, 'GET', 400],
      [`${PANEL_ROUTE_PREFIX}/${PROJECT_ID}.json`, 'POST', 405],
      [`${PANEL_ROUTE_PREFIX}/../${PROJECT_ID}.json`, 'GET', 400],
    ]
    for (const [url, method, expected] of cases) {
      const { res, status } = fakeResponse()
      await server.route.handler(fakeRequest(url, method), res)
      assert.equal(status(), expected, `${method} ${url}`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('snapshot refuses ids that are not hex project keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-panel-'))
  try {
    const route = new PanelRoute({ outputDir: root })
    assert.equal(await route.snapshot('../../etc'), undefined)
    assert.equal(await route.snapshot('ZZZZZZZZ'), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mints a playback URL only when an audio route is mounted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-panel-'))
  try {
    await seedProject(root)

    const withAudio = new PanelRoute({
      outputDir: root,
      audioUrlFor: (filePath) => `/voiceover/audio/${filePath.split(/[\\/]/).pop()}`,
    })
    const snapshot = await withAudio.snapshot(PROJECT_ID)
    assert.ok(snapshot)
    assert.equal(snapshot.chapters[0]?.audioUrl, '/voiceover/audio/ch-01.mp3')
    // A chapter without audio has no URL, not an empty string.
    assert.equal(snapshot.chapters[1]?.audioUrl, undefined)

    const withoutAudio = new PanelRoute({ outputDir: root })
    const plain = await withoutAudio.snapshot(PROJECT_ID)
    assert.equal(plain?.chapters[0]?.audioUrl, undefined)
    assert.equal(Object.prototype.hasOwnProperty.call(plain?.chapters[0] ?? {}, 'audioUrl'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('POST /rerun runs the shared operation and answers 202', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-panel-'))
  try {
    await seedProject(root)
    const calls: string[] = []
    const route = new PanelRoute({
      outputDir: root,
      onRerun: (projectId) => {
        calls.push(projectId)
      },
    })
    const server = fakeServer()
    route.register(server.server)

    const { res, status, body } = fakeResponse()
    await server.route.handler(fakeRequest(`${PANEL_ROUTE_PREFIX}/${PROJECT_ID}/rerun`, 'POST'), res)

    assert.equal(status(), 202)
    assert.deepEqual(calls, [PROJECT_ID])
    assert.equal(JSON.parse(body()).ok, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rerun is unavailable without a host operation, and methods are enforced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-panel-'))
  try {
    await seedProject(root)
    const plain = new PanelRoute({ outputDir: root })
    const server = fakeServer()
    plain.register(server.server)

    const cases: [string, string, number][] = [
      [`${PANEL_ROUTE_PREFIX}/${PROJECT_ID}/rerun`, 'POST', 501],
      [`${PANEL_ROUTE_PREFIX}/${PROJECT_ID}/rerun`, 'GET', 405],
      [`${PANEL_ROUTE_PREFIX}/${PROJECT_ID}.json`, 'POST', 405],
    ]
    for (const [url, method, expected] of cases) {
      const { res, status } = fakeResponse()
      await server.route.handler(fakeRequest(url, method), res)
      assert.equal(status(), expected, `${method} ${url}`)
    }

    // With the operation available, an unknown project is a 404, not a 501.
    const withOp = new PanelRoute({ outputDir: root, onRerun: () => {} })
    const opServer = fakeServer()
    withOp.register(opServer.server)
    const missing = fakeResponse()
    await opServer.route.handler(fakeRequest(`${PANEL_ROUTE_PREFIX}/deadbeef00/rerun`, 'POST'), missing.res)
    assert.equal(missing.status(), 404)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failing rerun answers 500 with the reason instead of hanging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-panel-'))
  try {
    await seedProject(root)
    const route = new PanelRoute({
      outputDir: root,
      onRerun: () => {
        throw new Error('engine unavailable')
      },
    })
    const server = fakeServer()
    route.register(server.server)

    const { res, status, body } = fakeResponse()
    await server.route.handler(fakeRequest(`${PANEL_ROUTE_PREFIX}/${PROJECT_ID}/rerun`, 'POST'), res)
    assert.equal(status(), 500)
    assert.match(JSON.parse(body()).error, /engine unavailable/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('the rerun route accepts a single chapter and rejects a malformed one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-panel-'))
  try {
    await seedProject(root)
    const calls: [string, string | undefined][] = []
    const route = new PanelRoute({
      outputDir: root,
      onRerun: (projectId, chapter) => {
        calls.push([projectId, chapter])
      },
    })
    const server = fakeServer()
    route.register(server.server)

    const one = fakeResponse()
    await server.route.handler(
      fakeRequest(`${PANEL_ROUTE_PREFIX}/${PROJECT_ID}/rerun`, 'POST', { chapter: 'ch-02' }),
      one.res,
    )
    assert.equal(one.status(), 202)
    assert.deepEqual(calls, [[PROJECT_ID, 'ch-02']])

    const whole = fakeResponse()
    await server.route.handler(fakeRequest(`${PANEL_ROUTE_PREFIX}/${PROJECT_ID}/rerun`, 'POST', {}), whole.res)
    assert.equal(whole.status(), 202)
    assert.deepEqual(calls[1], [PROJECT_ID, undefined])

    const bad = fakeResponse()
    await server.route.handler(
      fakeRequest(`${PANEL_ROUTE_PREFIX}/${PROJECT_ID}/rerun`, 'POST', { chapter: '../../etc' }),
      bad.res,
    )
    assert.equal(bad.status(), 400)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('snapshot reports the timing quality the chapters actually have', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-panel-'))
  try {
    await seedProject(root)
    const statePath = join(root, PROJECT_ID, 'state', 'state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      capability: { timingQuality: string }
    }
    // Planning-time guess: the state says "estimated" although the finished
    // chapter was measured exactly. The snapshot must trust the chapters.
    state.capability.timingQuality = 'estimated'
    await writeFile(statePath, JSON.stringify(state), 'utf8')

    const route = new PanelRoute({ outputDir: root })
    const snapshot = await route.snapshot(PROJECT_ID)
    assert.equal(snapshot?.capability.timingQuality, 'exact')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('serves subtitles as SRT and as WebVTT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-panel-'))
  try {
    await seedProject(root)
    await mkdir(join(root, PROJECT_ID, 'audio'), { recursive: true })
    await writeFile(
      join(root, PROJECT_ID, 'audio', 'ch-01.srt'),
      '1\n00:00:00,000 --> 00:00:02,500\n第一屏\n\n2\n00:00:03,000 --> 00:00:05,000\n第二屏\n',
    )
    const route = new PanelRoute({ outputDir: root })
    const server = fakeServer()
    route.register(server.server)

    const srt = fakeResponse()
    await server.route.handler(fakeRequest(`${PANEL_ROUTE_PREFIX}/${PROJECT_ID}/subtitles/ch-01`), srt.res)
    assert.equal(srt.status(), 200)
    assert.match(srt.body(), /00:00:00,000 --> 00:00:02,500/)

    const vtt = fakeResponse()
    await server.route.handler(fakeRequest(`${PANEL_ROUTE_PREFIX}/${PROJECT_ID}/subtitles/ch-01.vtt`), vtt.res)
    assert.equal(vtt.status(), 200)
    assert.match(vtt.body(), /^WEBVTT\n\n/)
    assert.match(vtt.body(), /00:00:00\.000 --> 00:00:02\.500/)

    // The second chapter in the fixture has no subtitle record yet.
    const missing = fakeResponse()
    await server.route.handler(fakeRequest(`${PANEL_ROUTE_PREFIX}/${PROJECT_ID}/subtitles/ch-02`), missing.res)
    assert.equal(missing.status(), 404)

    const post = fakeResponse()
    await server.route.handler(fakeRequest(`${PANEL_ROUTE_PREFIX}/${PROJECT_ID}/subtitles/ch-01`, 'POST'), post.res)
    assert.equal(post.status(), 405)
  } finally {
    await removeWithRetry(root)
  }
})