import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { setEdgeJsLoader } from '../src/engines/edge-js.ts'
import { ErrorCode, TtsError } from '../src/errors.ts'
import { TtsService } from '../src/service.ts'

/** One 144-byte MPEG-2 Layer III frame at 24 kHz (576 samples). */
function frame(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xf3, 0x64, 0xc0]), Buffer.alloc(140)])
}

/**
 * Fake backend that throttles the first `failures` calls, then succeeds.
 * `calls()` counts backend attempts across retries.
 */
function throttlingBackend(failures: number): { module: unknown; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    module: {
      EdgeTTS: class {
        constructor(config: Record<string, unknown>) {
          void config
        }

        async *streamAudio(text: string): AsyncGenerator<Buffer | { part: string; start: number; end: number }> {
          calls += 1
          if (calls <= failures) throw new Error('Unexpected server response: 429')
          yield Buffer.concat(Array.from({ length: 10 }, () => frame()))
          yield { part: text.slice(0, 1), start: 0, end: 400 }
        }

        async ttsPromise(): Promise<void> {}
      },
    },
  }
}

test('backs off on 429 and retries the good engine before succeeding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-throttle-'))
  const backend = throttlingBackend(2)
  setEdgeJsLoader(async () => backend.module)
  try {
    const delays: number[] = []
    const service = new TtsService(resolveConfig({ outputDir: dir, engine: 'edge-js' }, {}), {
      sleep: async (ms) => {
        delays.push(ms)
      },
    })

    const result = await service.synthesize({ text: '限流重试' })
    assert.equal(result.kind, 'audio')
    if (result.kind === 'audio') assert.equal(result.engine, 'edge-js')
    // Two throttled attempts, then success: the engine never fell back.
    assert.equal(backend.calls(), 3)
    assert.deepEqual(delays, [2000, 6000])
  } finally {
    setEdgeJsLoader(undefined)
    await rm(dir, { recursive: true, force: true })
  }
})

test('gives up as UPSTREAM_THROTTLED after the backoff budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-throttle-'))
  const backend = throttlingBackend(99)
  setEdgeJsLoader(async () => backend.module)
  try {
    const delays: number[] = []
    const service = new TtsService(resolveConfig({ outputDir: dir, engine: 'edge-js', fallbackEnabled: false }, {}), {
      sleep: async (ms) => {
        delays.push(ms)
      },
    })

    await assert.rejects(
      () => service.synthesize({ text: '一直限流' }),
      (error: unknown) => error instanceof TtsError && error.code === ErrorCode.UpstreamThrottled,
    )
    // One initial attempt plus one per backoff step, then stop.
    assert.equal(backend.calls(), 4)
    assert.deepEqual(delays, [2000, 6000, 18000])
  } finally {
    setEdgeJsLoader(undefined)
    await rm(dir, { recursive: true, force: true })
  }
})

test('an aborted request stops waiting during a backoff', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-throttle-'))
  const backend = throttlingBackend(99)
  setEdgeJsLoader(async () => backend.module)
  try {
    // No injected sleep: the real backoff must notice the abort signal.
    const service = new TtsService(resolveConfig({ outputDir: dir, engine: 'edge-js', fallbackEnabled: false }, {}))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30)
    try {
      await assert.rejects(
        () => service.synthesize({ text: '中断', signal: controller.signal }),
        (error: unknown) => error instanceof TtsError && error.code === ErrorCode.Aborted,
      )
    } finally {
      clearTimeout(timer)
    }
  } finally {
    setEdgeJsLoader(undefined)
    await rm(dir, { recursive: true, force: true })
  }
})
