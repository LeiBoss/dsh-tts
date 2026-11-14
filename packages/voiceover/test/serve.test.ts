import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveOptions, start } from '../src/cli.ts'

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
