import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { main, resolveOptions, start } from '../src/cli.ts'

const TOKEN = 'serve-test-token'

/** Boot the daemon on an ephemeral port and return its base URL. */
async function boot(outputDir: string): Promise<{ base: string; close: () => Promise<void> }> {
  const { server } = await start({
    port: 0,
    host: '127.0.0.1',
    outputDir,
    token: TOKEN,
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+0%',
    style: 'news',
    llmModel: 'unused',
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('no address')
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('the daemon serves health, enforces the token, and routes projects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-serve-'))
  const daemon = await boot(root)
  try {
    const health = await fetch(`${daemon.base}/healthz`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).ok, true)

    const anonymous = await fetch(`${daemon.base}/v1/doctor`)
    assert.equal(anonymous.status, 401)

    const authorized = await fetch(`${daemon.base}/v1/doctor`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    assert.equal(authorized.status, 200)

    const unknown = await fetch(`${daemon.base}/v1/projects/deadbeef00`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    assert.equal(unknown.status, 404)
  } finally {
    await daemon.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('options resolve from flags and environment, with loopback defaults', () => {
  const defaults = resolveOptions([], { DSH_HOME: 'C:\\dsh' })
  assert.equal(defaults.port, 7801)
  assert.equal(defaults.host, '127.0.0.1')
  assert.equal(defaults.style, 'news')
  assert.equal(defaults.token, undefined, 'a token must be supplied explicitly')

  const flagged = resolveOptions(['--port', '9000', '--host', '0.0.0.0', '--style', 'lecture'], {
    DSH_VOICEOVER_TOKEN: 'from-env',
  })
  assert.equal(flagged.port, 9000)
  assert.equal(flagged.host, '0.0.0.0')
  assert.equal(flagged.style, 'lecture')
  assert.equal(flagged.token, 'from-env')

  assert.throws(() => resolveOptions(['--style', 'opera'], {}), /unknown style/)
  assert.throws(() => resolveOptions(['--port'], {}), /needs a value/)
})

/** A fake engine good enough for the daemon wiring. */
function fakeEngine(audioPath: string): unknown {
  return {
    capabilities: { wordBoundaries: true, formats: ['mp3'], offline: false },
    async synthesize() {
      return {
        kind: 'audio',
        filePath: audioPath,
        format: 'mp3',
        durationMs: 1200,
        timingQuality: 'exact',
        engine: 'edge-js',
        fromCache: false,
      }
    },
    async doctor() {
      return { ok: true, note: 'fake' }
    },
  }
}

test('the daemon creates a project, reports progress and serves the manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vo-daemon-'))
  const audio = join(root, 'clip.mp3')
  await writeFile(audio, Buffer.concat([Buffer.from([0xff, 0xf3, 0x64, 0xc0]), Buffer.alloc(140)]))
  const { server } = await start(
    {
      port: 0,
      host: '127.0.0.1',
      outputDir: root,
      token: 'tok',
      voice: 'zh-CN-XiaoxiaoNeural',
      rate: '+0%',
      style: 'news',
      llmModel: 'unused',
      chapterChars: 200,
    },
    { engine: fakeEngine(audio) },
  )
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
  const auth = { authorization: 'Bearer tok' }
  try {
    const tts = await fetch(`${base}/v1/tts`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '一句话' }),
    })
    assert.equal(tts.status, 200)
    assert.equal((await tts.json()).engine, 'edge-js')

    const created = await fetch(`${base}/v1/voiceover`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ sourceText: '第一段。\n\n第二段。\n\n第三段。\n\n第四段。', title: '演示' }),
    })
    assert.equal(created.status, 202)
    const { projectId } = (await created.json()) as { projectId: string }

    // Wait for the background run to finish.
    let snapshot: Record<string, unknown> | undefined
    for (let i = 0; i < 100; i += 1) {
      const res = await fetch(`${base}/v1/projects/${projectId}`, { headers: auth })
      if (res.status === 200) {
        snapshot = (await res.json()) as Record<string, unknown>
        if (snapshot.pending === 0) break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(snapshot, 'the project must appear')
    assert.equal(snapshot?.done, snapshot?.total)
    assert.equal(snapshot?.engine && (snapshot.engine as Record<string, unknown>).name, 'edge-js')

    const manifest = await fetch(`${base}/v1/projects/${projectId}/manifest`, { headers: auth })
    assert.equal(manifest.status, 200)

    const rerun = await fetch(`${base}/v1/projects/${projectId}/rerun`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(rerun.status, 202)

    const doctor = await fetch(`${base}/v1/doctor`, { headers: auth })
    assert.equal(doctor.status, 200)
    assert.equal((await doctor.json()).note, 'fake')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
test('the CLI prints usage on --help and refuses to start without a token', async () => {
  const argv = process.argv
  const exitCode = process.exitCode
  const previousToken = process.env.DSH_VOICEOVER_TOKEN
  const stderrWrite = process.stderr.write
  const stdoutWrite = process.stdout.write
  let out = ''
  let err = ''
  process.stderr.write = ((chunk: string) => {
    err += chunk
    return true
  }) as typeof process.stderr.write
  process.stdout.write = ((chunk: string) => {
    out += chunk
    return true
  }) as typeof process.stdout.write
  delete process.env.DSH_VOICEOVER_TOKEN
  try {
    process.argv = ['node', 'cli', '--help']
    await main()
    assert.match(out, /Usage: dsh-voiceover/)

    process.argv = ['node', 'cli']
    process.exitCode = 0
    await main()
    assert.match(err, /Refusing to start without a token/)
    assert.equal(process.exitCode, 2)
  } finally {
    process.argv = argv
    process.exitCode = exitCode
    process.stderr.write = stderrWrite
    process.stdout.write = stdoutWrite
    if (previousToken !== undefined) process.env.DSH_VOICEOVER_TOKEN = previousToken
  }
})