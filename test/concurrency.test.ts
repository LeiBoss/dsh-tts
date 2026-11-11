import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConcurrencyLimiter } from '../src/concurrency.ts'
import { resolveConfig } from '../src/config.ts'
import type { SpawnFunction } from '../src/edge-tts.ts'
import { ErrorCode, TtsError } from '../src/errors.ts'
import { createTtsTools } from '../src/index.ts'
import {
  FakeChild,
  executionContext,
  failingSpawn,
  hangingSpawn,
} from './helpers.ts'

interface PendingSpawn {
  child: FakeChild
  args: string[]
  complete: (bytes?: Buffer) => void
}

function controlledSpawn(pending: PendingSpawn[]): SpawnFunction {
  return (_command, args) => {
    const child = new FakeChild()
    pending.push({
      child,
      args: [...args],
      complete(bytes = Buffer.from('ID3controlled')) {
        const media = args.find((arg) => arg.startsWith('--write-media='))
        if (media) writeFileSync(media.slice('--write-media='.length), bytes)
        child.emit('close', 0, null)
      },
    })
    return child
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('condition was not reached in time')
    }
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-concurrency-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('two identical concurrent requests spawn only once and share the path', async () => {
  await withTempDir(async (dir) => {
    const pending: PendingSpawn[] = []
    const limiter = new ConcurrencyLimiter({
      maxConcurrent: 2,
      queueSize: 4,
      queueTimeoutMs: 1_000,
    })
    const config = resolveConfig({ outputDir: dir }, {})
    const [generate] = createTtsTools(config, {
      spawnImpl: controlledSpawn(pending),
      limiter,
    })
    assert.ok(generate)

    const first = generate.execute({ text: 'same request' }, executionContext())
    const second = generate.execute({ text: 'same request' }, executionContext())

    await waitFor(() => pending.length === 1)
    assert.deepEqual(limiter.stats, { running: 1, queued: 0 })
    pending[0]?.complete()

    const [a, b] = await Promise.all([first, second])
    assert.equal(a.filePath, b.filePath)
    assert.equal(pending.length, 1)
  })
})

test('cancelling one merged waiter leaves the other request alive', async () => {
  await withTempDir(async (dir) => {
    const pending: PendingSpawn[] = []
    const limiter = new ConcurrencyLimiter({
      maxConcurrent: 2,
      queueSize: 4,
      queueTimeoutMs: 1_000,
    })
    const config = resolveConfig({ outputDir: dir }, {})
    const [generate] = createTtsTools(config, {
      spawnImpl: controlledSpawn(pending),
      limiter,
    })
    assert.ok(generate)

    const first = new AbortController()
    const second = new AbortController()
    const a = generate.execute(
      { text: 'cancel one waiter' },
      executionContext(first.signal),
    )
    const b = generate.execute(
      { text: 'cancel one waiter' },
      executionContext(second.signal),
    )

    await waitFor(() => pending.length === 1)
    first.abort()
    await assert.rejects(a, (error: unknown) => {
      assert.ok(error instanceof TtsError)
      assert.equal(error.code, ErrorCode.Aborted)
      return true
    })
    assert.equal(pending[0]?.child.kills.length, 0)
    assert.deepEqual(limiter.stats, { running: 1, queued: 0 })

    pending[0]?.complete()
    const result = await b
    assert.equal(result.format, 'mp3')
    assert.equal(pending.length, 1)
  })
})

test('a third distinct request waits when maxConcurrent is 2', async () => {
  await withTempDir(async (dir) => {
    const pending: PendingSpawn[] = []
    const limiter = new ConcurrencyLimiter({
      maxConcurrent: 2,
      queueSize: 4,
      queueTimeoutMs: 2_000,
    })
    const config = resolveConfig({ outputDir: dir }, {})
    const [generate] = createTtsTools(config, {
      spawnImpl: controlledSpawn(pending),
      limiter,
    })
    assert.ok(generate)

    const requests = ['alpha', 'bravo', 'charlie'].map((text) =>
      generate.execute({ text }, executionContext()),
    )

    await waitFor(() => pending.length === 2)
    assert.deepEqual(limiter.stats, { running: 2, queued: 1 })
    assert.equal(pending.length, 2, 'third request must not spawn yet')

    pending[0]?.complete()
    await waitFor(() => pending.length === 3)
    assert.deepEqual(limiter.stats, { running: 2, queued: 0 })

    pending[1]?.complete()
    pending[2]?.complete()
    const results = await Promise.all(requests)
    assert.equal(results.length, 3)
  })
})

test('a full queue with queueSize=0 rejects with TTS_BUSY', async () => {
  await withTempDir(async (dir) => {
    const pending: PendingSpawn[] = []
    const limiter = new ConcurrencyLimiter({
      maxConcurrent: 1,
      queueSize: 0,
      queueTimeoutMs: 1_000,
    })
    const config = resolveConfig({ outputDir: dir }, {})
    const [generate] = createTtsTools(config, {
      spawnImpl: controlledSpawn(pending),
      limiter,
    })
    assert.ok(generate)

    const running = generate.execute({ text: 'holds the slot' }, executionContext())
    await waitFor(() => pending.length === 1)

    await assert.rejects(
      generate.execute({ text: 'must be rejected' }, executionContext()),
      (error: unknown) =>
        error instanceof TtsError &&
        error.code === ErrorCode.TtsBusy &&
        /running=1/.test(error.message) &&
        /queued=0/.test(error.message),
    )

    pending[0]?.complete()
    await running
  })
})

test('queue wait timeout rejects with TTS_BUSY', async () => {
  await withTempDir(async (dir) => {
    const pending: PendingSpawn[] = []
    const limiter = new ConcurrencyLimiter({
      maxConcurrent: 1,
      queueSize: 2,
      queueTimeoutMs: 20,
    })
    const config = resolveConfig({ outputDir: dir }, {})
    const [generate] = createTtsTools(config, {
      spawnImpl: controlledSpawn(pending),
      limiter,
    })
    assert.ok(generate)

    const running = generate.execute({ text: 'slow' }, executionContext())
    await waitFor(() => pending.length === 1)

    await assert.rejects(
      generate.execute({ text: 'waits too long' }, executionContext()),
      (error: unknown) =>
        error instanceof TtsError &&
        error.code === ErrorCode.TtsBusy &&
        /queue wait timed out/.test(error.message),
    )

    pending[0]?.complete()
    await running
  })
})

test('a cache hit returns while the only slot is occupied', async () => {
  await withTempDir(async (dir) => {
    const pending: PendingSpawn[] = []
    const limiter = new ConcurrencyLimiter({
      maxConcurrent: 1,
      queueSize: 0,
      queueTimeoutMs: 1_000,
    })
    const config = resolveConfig({ outputDir: dir }, {})
    const [generate] = createTtsTools(config, {
      spawnImpl: controlledSpawn(pending),
      limiter,
    })
    assert.ok(generate)

    const primed = generate.execute({ text: 'cached text' }, executionContext())
    await waitFor(() => pending.length === 1)
    pending[0]?.complete()
    const first = await primed

    const busy = generate.execute({ text: 'occupies slot' }, executionContext())
    await waitFor(() => pending.length === 2)

    const second = await generate.execute(
      { text: 'cached text' },
      executionContext(),
    )
    assert.equal(second.filePath, first.filePath)
    assert.equal(pending.length, 2, 'cache hit must not spawn')

    pending[1]?.complete()
    await busy
  })
})

test('fallback timing is logged after an Edge-TTS timeout', async () => {
  await withTempDir(async (dir) => {
    const logs: string[] = []
    const hanging = hangingSpawn([])
    const config = resolveConfig({ outputDir: dir, timeoutMs: 20 }, {})
    const [generate] = createTtsTools(config, {
      spawnImpl: hanging.spawn,
      platform: 'win32',
      log: (message) => logs.push(message),
      sapiSynthesize: async (_text, options) => {
        const filePath = join(options.outputDir, 'fallback-sapi.mp3')
        writeFileSync(filePath, Buffer.from('ID3sapi'))
        return { filePath, format: 'mp3' }
      },
    })
    assert.ok(generate)

    const result = await generate.execute({ text: 'timeout then sapi' }, executionContext())

    assert.equal(result.engine, 'sapi')
    const timing = logs.find((line) => line.includes('fallback engine=sapi'))
    assert.ok(timing)
    assert.match(timing ?? '', /elapsedMs=\d+/)
  })
})

test('ALL_FALLBACKS_FAILED lists the attempted engine chain', async () => {
  await withTempDir(async (dir) => {
    const config = resolveConfig(
      { outputDir: dir, fallbackOrder: ['edge-tts', 'sapi'] },
      {},
    )
    const [generate] = createTtsTools(config, {
      spawnImpl: failingSpawn([], 2, 'edge down'),
      platform: 'linux',
    })
    assert.ok(generate)

    await assert.rejects(
      generate.execute({ text: 'no engine left' }, executionContext()),
      (error: unknown) =>
        error instanceof TtsError &&
        error.code === ErrorCode.AllFallbacksFailed &&
        /Engines: \["edge-tts","sapi"\]/.test(error.message) &&
        /sapi \(skipped/.test(error.message),
    )
  })
})
