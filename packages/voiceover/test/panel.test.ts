import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PANEL_ROUTE_PREFIX, PanelRoute, type RegisterableRoute } from '../src/panel.ts'

const PROJECT_ID = 'abcdef123456'

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
    end(payload?: string) {
      state.body = payload ?? ''
      return res
    },
  } as unknown as ServerResponse
  return { res, status: () => state.status, body: () => state.body }
}

/** Minimal request double. */
function fakeRequest(url: string, method = 'GET'): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage
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