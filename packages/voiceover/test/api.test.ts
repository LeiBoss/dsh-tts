import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { handleRequest, type ApiContext, type ApiRequest, type ApiResponse } from '../src/api.ts'

const PROJECT_ID = 'abcdef123456'
const TOKEN = 'test-token'

/** Persist a project with one finished chapter, one audio file and subtitles. */
async function seedProject(root: string): Promise<void> {
  const project = join(root, PROJECT_ID)
  await mkdir(join(project, 'state'), { recursive: true })
  await mkdir(join(project, 'audio'), { recursive: true })
  await writeFile(join(project, 'audio', 'ch-01.mp3'), Buffer.from('ID3-fake-audio-bytes'))
  await writeFile(join(project, 'audio', 'ch-01.srt'), '1\n00:00:00,000 --> 00:00:01,000\n第一屏\n')
  await writeFile(
    join(project, 'state', 'state.json'),
    JSON.stringify({
      projectId: PROJECT_ID,
      sourceHash: 'a'.repeat(64),
      promptVersion: 'p1.3',
      engine: { name: 'edge-js', voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%' },
      capability: { llm: true, network: true, wordBoundaries: true, timingQuality: 'exact' },
      style: 'news',
      outline: {
        title: '接口测试',
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
          audio: { path: 'audio/ch-01.mp3', bytes: 20, durationMs: 1000, timingQuality: 'exact', format: 'mp3' },
          subtitles: { path: 'audio/ch-01.srt', units: 1, timingQuality: 'exact' },
        },
        { id: 'ch-02', order: 2, title: '结尾', chars: 10, sourceRange: [2, 3], status: 'failed', error: { code: 'EDGE_TTS_FAILED', message: 'boom', retryable: true } },
      ],
      inputHashes: {},
      warnings: ['ch-02 failed'],
      createdAt: '2026-11-14T00:00:00.000Z',
    }),
  )
}

/** Context with one overridable operation per test. */
function makeContext(root: string, overrides: Partial<ApiContext> = {}): ApiContext {
  return {
    outputDir: root,
    token: TOKEN,
    version: 'test',
    startedAt: Date.now() - 1000,
    async synthesize() {
      return { filePath: join(root, 'x.mp3'), format: 'mp3', durationMs: 1200, timingQuality: 'exact' as const, engine: 'edge-js' }
    },
    async createProject() {
      return { projectId: PROJECT_ID }
    },
    async rerunProject() {},
    async doctor() {
      return { ok: true }
    },
    ...overrides,
  }
}

/** Build a request with the bearer token unless told otherwise. */
function request(
  method: string,
  url: string,
  options: { token?: string | null; body?: unknown; range?: string } = {},
): ApiRequest {
  const headers: Record<string, string> = {}
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`
  if (options.range !== undefined) headers.range = options.range
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  return {
    method,
    url,
    headers,
    ...(options.body === undefined ? {} : { body: Buffer.from(JSON.stringify(options.body)) }),
  }
}

/** Parse a JSON response body. */
function jsonOf(response: ApiResponse): Record<string, unknown> {
  return JSON.parse(response.body.toString('utf8')) as Record<string, unknown>
}

test('healthz answers without a token and reports uptime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-api-'))
  try {
    const response = await handleRequest(makeContext(root), request('GET', '/healthz', { token: null }))
    assert.equal(response.status, 200)
    assert.equal(jsonOf(response).ok, true)
    assert.equal(jsonOf(response).version, 'test')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('every other route requires the bearer token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-api-'))
  try {
    const context = makeContext(root)
    for (const call of [
      request('GET', `/v1/projects/${PROJECT_ID}`, { token: null }),
      request('GET', '/v1/doctor', { token: null }),
      request('POST', '/v1/tts', { token: null, body: { text: 'hi' } }),
    ]) {
      const response = await handleRequest(context, call)
      assert.equal(response.status, 401, call.url)
    }
    const wrong = await handleRequest(context, request('GET', '/v1/doctor', { token: 'nope' }))
    assert.equal(wrong.status, 401)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('POST /v1/tts validates input and surfaces engine failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-api-'))
  try {
    const context = makeContext(root)
    const ok = await handleRequest(context, request('POST', '/v1/tts', { body: { text: '你好' } }))
    assert.equal(ok.status, 200)
    assert.equal(jsonOf(ok).engine, 'edge-js')

    const empty = await handleRequest(context, request('POST', '/v1/tts', { body: { text: '  ' } }))
    assert.equal(empty.status, 400)

    const long = await handleRequest(context, request('POST', '/v1/tts', { body: { text: 'x'.repeat(10_001) } }))
    assert.equal(long.status, 413)

    const failing = makeContext(root, {
      async synthesize() {
        throw new Error('engine offline')
      },
    })
    const failed = await handleRequest(failing, request('POST', '/v1/tts', { body: { text: 'hi' } }))
    assert.equal(failed.status, 422)
    assert.match(String(jsonOf(failed).error), /engine offline/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('POST /v1/voiceover accepts exactly one source and returns 202', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-api-'))
  try {
    const context = makeContext(root)
    const ok = await handleRequest(context, request('POST', '/v1/voiceover', { body: { sourceText: '一段正文。' } }))
    assert.equal(ok.status, 202)
    assert.equal(jsonOf(ok).projectId, PROJECT_ID)
    assert.equal(jsonOf(ok).statusUrl, `/v1/projects/${PROJECT_ID}`)

    const both = await handleRequest(
      context,
      request('POST', '/v1/voiceover', { body: { sourceText: 'x', sourcePath: 'y' } }),
    )
    assert.equal(both.status, 400)

    const neither = await handleRequest(context, request('POST', '/v1/voiceover', { body: {} }))
    assert.equal(neither.status, 400)

    const badStyle = await handleRequest(
      context,
      request('POST', '/v1/voiceover', { body: { sourceText: 'x', style: 'opera' } }),
    )
    assert.equal(badStyle.status, 400)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('project status, manifest and rerun follow the persisted state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-api-'))
  try {
    await seedProject(root)
    const reruns: string[] = []
    const context = makeContext(root, {
      async rerunProject(projectId) {
        reruns.push(projectId)
      },
    })

    const status = await handleRequest(context, request('GET', `/v1/projects/${PROJECT_ID}`))
    assert.equal(status.status, 200)
    const snapshot = jsonOf(status)
    assert.equal(snapshot.done, 1)
    assert.equal(snapshot.failed, 1)
    assert.equal(snapshot.pending, 0)

    const manifest = await handleRequest(context, request('GET', `/v1/projects/${PROJECT_ID}/manifest`))
    assert.equal(manifest.status, 404, 'no manifest was written in this fixture')

    const rerun = await handleRequest(context, request('POST', `/v1/projects/${PROJECT_ID}/rerun`))
    assert.equal(rerun.status, 202)
    assert.deepEqual(reruns, [PROJECT_ID])

    const unknown = await handleRequest(context, request('GET', '/v1/projects/deadbeef00'))
    assert.equal(unknown.status, 404)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('audio supports Range requests and refuses path escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-api-'))
  try {
    await seedProject(root)
    const context = makeContext(root)

    const full = await handleRequest(context, request('GET', `/v1/projects/${PROJECT_ID}/audio/ch-01.mp3`))
    assert.equal(full.status, 200)
    assert.equal(full.headers['content-type'], 'audio/mpeg')
    assert.equal(full.headers['accept-ranges'], 'bytes')

    const partial = await handleRequest(
      context,
      request('GET', `/v1/projects/${PROJECT_ID}/audio/ch-01.mp3`, { range: 'bytes=0-3' }),
    )
    assert.equal(partial.status, 206)
    assert.equal(partial.headers['content-range'], `bytes 0-3/${Buffer.byteLength('ID3-fake-audio-bytes')}`)
    assert.equal(partial.body.toString('utf8'), 'ID3-')

    const bad = await handleRequest(
      context,
      request('GET', `/v1/projects/${PROJECT_ID}/audio/ch-01.mp3`, { range: 'bytes=999-1000' }),
    )
    assert.equal(bad.status, 416)

    const escape = await handleRequest(context, request('GET', `/v1/projects/${PROJECT_ID}/audio/..%2Fstate%2Fstate.json`))
    assert.equal(escape.status, 404)

    const missing = await handleRequest(context, request('GET', `/v1/projects/${PROJECT_ID}/audio/ch-09.mp3`))
    assert.equal(missing.status, 404)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('subtitles are served as text and unknown endpoints stay 404', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-api-'))
  try {
    await seedProject(root)
    const context = makeContext(root)

    const srt = await handleRequest(context, request('GET', `/v1/projects/${PROJECT_ID}/subtitles/ch-01.srt`))
    assert.equal(srt.status, 200)
    assert.match(srt.headers['content-type'], /text\/plain/)

    const est = await handleRequest(context, request('GET', `/v1/projects/${PROJECT_ID}/subtitles/ch-01.est.srt`))
    assert.equal(est.status, 404, 'the fixture only has the exact variant')

    const nope = await handleRequest(context, request('GET', `/v1/projects/${PROJECT_ID}/nope`))
    assert.equal(nope.status, 404)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('maps upstream throttling to 429 with Retry-After', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-api-'))
  try {
    const throttled = makeContext(root, {
      async synthesize() {
        const error = new Error('The Edge endpoint is throttling requests: 429')
        Object.assign(error, { code: 'UPSTREAM_THROTTLED' })
        throw error
      },
    })
    const response = await handleRequest(throttled, request('POST', '/v1/tts', { body: { text: 'hi' } }))
    assert.equal(response.status, 429)
    assert.equal(response.headers['retry-after'], '30')
    assert.equal(jsonOf(response).code, 'UPSTREAM_THROTTLED')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('the daemon rerun accepts a chapter and rejects a malformed one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-api-'))
  try {
    await seedProject(root)
    const calls: string[] = []
    const context = makeContext(root, {
      async rerunProject(projectId, chapter) {
        calls.push(`${projectId}:${chapter ?? 'all'}`)
      },
    })

    const one = await handleRequest(
      context,
      request('POST', `/v1/projects/${PROJECT_ID}/rerun`, { body: { chapter: 'ch-02' } }),
    )
    assert.equal(one.status, 202)
    assert.equal(jsonOf(one).chapter, 'ch-02')

    const bad = await handleRequest(
      context,
      request('POST', `/v1/projects/${PROJECT_ID}/rerun`, { body: { chapter: 'nope' } }),
    )
    assert.equal(bad.status, 400)

    assert.deepEqual(calls, [`${PROJECT_ID}:ch-02`])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})