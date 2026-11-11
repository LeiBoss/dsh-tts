import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { createTtsTools } from '../src/index.ts'
import { MAX_PROBE_TIMEOUT_MS, probeEndpoint } from '../src/probe.ts'
import { executionContext, successfulSpawn } from './helpers.ts'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-probe-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('the probe reports reachable for a listening local socket', async () => {
  const server = createServer((socket) => socket.end())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  try {
    const result = await probeEndpoint({
      host: '127.0.0.1',
      port: address.port,
      timeoutMs: 2_000,
    })
    assert.equal(result.reachable, true)
    assert.equal(result.host, '127.0.0.1')
    assert.equal(result.port, address.port)
    assert.ok(result.elapsedMs >= 0)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('the probe reports unreachable when the connection never settles', async () => {
  // A socket double that never emits `connect`; no real packet is sent.
  const silent = (): Socket => new Socket()

  const result = await probeEndpoint({
    host: '127.0.0.1',
    port: 9,
    timeoutMs: 60,
    connectImpl: silent,
  })

  assert.equal(result.reachable, false)
  assert.ok(result.elapsedMs >= 50, `elapsed too small: ${result.elapsedMs}`)
  assert.ok(result.elapsedMs < 1_000, `elapsed too large: ${result.elapsedMs}`)
})

test('the probe clamps oversized timeouts to five seconds', async () => {
  const silent = (): Socket => new Socket()
  const started = Date.now()
  const result = await probeEndpoint({
    host: '127.0.0.1',
    port: 9,
    timeoutMs: 60_000,
    signal: AbortSignal.timeout(30),
    connectImpl: silent,
  })

  assert.equal(result.reachable, false)
  assert.ok(Date.now() - started < MAX_PROBE_TIMEOUT_MS + 500)
})

test('tts_probe_network returns the documented shape and flags the proxy', async () => {
  await withTempDir(async (dir) => {
    const server = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')

    try {
      const config = resolveConfig(
        { outputDir: dir, proxy: 'http://127.0.0.1:7890' },
        {},
      )
      const tools = createTtsTools(config, {
        spawnImpl: successfulSpawn([]),
        probeConnect: ({ host, port }) => {
          const socket = new Socket()
          socket.connect({ host: '127.0.0.1', port: address.port })
          return socket
        },
      })
      const probe = tools[2]
      assert.ok(probe)

      const result = await probe.execute(
        { timeoutMs: 2_000 },
        executionContext(),
      )

      assert.equal(result.host, 'speech.platform.bing.com')
      assert.equal(result.port, 443)
      assert.equal(result.reachable, true)
      assert.equal(result.proxyConfigured, true)
      assert.equal(typeof result.elapsedMs, 'number')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
