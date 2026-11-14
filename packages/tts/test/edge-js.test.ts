import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { measureMp3 } from '../src/audio/mp3-duration.ts'
import { resolveConfig } from '../src/config.ts'
import { setEdgeJsLoader, synthesizeWithEdgeJs } from '../src/engines/edge-js.ts'
import { ErrorCode, TtsError } from '../src/errors.ts'
import { TtsService } from '../src/service.ts'

/** One 144-byte MPEG-2 Layer III frame: 576 samples at 24 kHz. */
function mp3Frame(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xf3, 0x64, 0xc0]), Buffer.alloc(140)])
}

/** Audio for `frames` worth of time, so duration is exactly measurable. */
function audioOf(frames: number): Buffer {
  return Buffer.concat(Array.from({ length: frames }, mp3Frame))
}

/** Fake `node-edge-tts` module: yields audio then two word boundaries. */
function fakeModule(options: { frames?: number; text?: string } = {}): unknown {
  return {
    EdgeTTS: class {
      constructor(config: Record<string, unknown>) {
        void config
      }

      async *streamAudio(text: string): AsyncGenerator<Buffer | { part: string; start: number; end: number }> {
        const body = options.text ?? text
        yield audioOf(options.frames ?? 50)
        yield { part: body.slice(0, 1), start: 0, end: 400 }
        yield { part: body.slice(1), start: 400, end: 1000 }
      }

      async ttsPromise(): Promise<void> {}
    },
  }
}

/** Fake module whose stream rejects, for the protocol-drift mapping. */
function failingModule(message: string): unknown {
  return {
    EdgeTTS: class {
      constructor(config: Record<string, unknown>) {
        void config
      }

      async *streamAudio(): AsyncGenerator<Buffer> {
        throw new Error(message)
      }

      async ttsPromise(): Promise<void> {}
    },
  }
}

test('returns audio plus word boundaries from the pure-JS backend', async () => {
  setEdgeJsLoader(async () => fakeModule())
  try {
    const result = await synthesizeWithEdgeJs({ text: '你好世界', voice: 'zh-CN-XiaoxiaoNeural' })
    assert.ok(result.audio.length > 0)
    assert.equal(result.words.length, 2)
    assert.equal(result.words[1]?.offsetMs, 400)
    assert.equal(result.words[1]?.durationMs, 600)
    assert.equal(measureMp3(result.audio)?.durationMs, 1200)
  } finally {
    setEdgeJsLoader(undefined)
  }
})

test('reports ENGINE_UNAVAILABLE when the optional dependency is missing', async () => {
  setEdgeJsLoader(async () => ({ notEdgeTts: true }))
  try {
    await assert.rejects(
      () => synthesizeWithEdgeJs({ text: 'x', voice: 'zh-CN-XiaoxiaoNeural' }),
      (error: unknown) => error instanceof TtsError && error.code === ErrorCode.EngineUnavailable,
    )
  } finally {
    setEdgeJsLoader(undefined)
  }
})

test('maps a rejected handshake to a protocol-drift error', async () => {
  setEdgeJsLoader(async () => failingModule('WebSocketError: 403 Forbidden'))
  try {
    await assert.rejects(
      () => synthesizeWithEdgeJs({ text: 'x', voice: 'zh-CN-XiaoxiaoNeural' }),
      (error: unknown) => error instanceof TtsError && error.protocolDrift,
    )
  } finally {
    setEdgeJsLoader(undefined)
  }
})

test('the service selects the pure-JS backend on auto and caches the result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-engine-'))
  setEdgeJsLoader(async () => fakeModule())
  try {
    const config = resolveConfig({ outputDir: dir, engine: 'auto' }, {})
    const service = new TtsService(config)

    const first = await service.synthesize({ text: '一段测试文本' })
    assert.equal(first.kind, 'audio')
    if (first.kind !== 'audio') return
    assert.equal(first.engine, 'edge-js')
    assert.equal(first.fromCache, false)
    assert.equal(first.timingQuality, 'exact')
    assert.ok(first.words !== undefined && first.words.length > 0)

    const second = await service.synthesize({ text: '一段测试文本' })
    assert.equal(second.kind, 'audio')
    if (second.kind !== 'audio') return
    assert.equal(second.fromCache, true)
    assert.equal(second.filePath, first.filePath)
    // A cache hit must keep the persisted word timings: losing them would
    // silently downgrade subtitle timing from exact to estimated.
    assert.ok(second.words !== undefined && second.words.length > 0)
    assert.deepEqual(second.words, first.words)
  } finally {
    setEdgeJsLoader(undefined)
    await rm(dir, { recursive: true, force: true })
  }
})

test('chunked synthesis shifts word offsets by the preceding chunk duration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-chunk-'))
  setEdgeJsLoader(async () => fakeModule({ frames: 50 }))
  try {
    // chunkSize 4 splits the eight characters into two chunks of four.
    const config = resolveConfig({ outputDir: dir, engine: 'edge-js', chunkSize: 4, chunkingEnabled: true }, {})
    const service = new TtsService(config)

    const result = await service.synthesize({ text: '一二三四五六七八' })
    assert.equal(result.kind, 'audio')
    if (result.kind !== 'audio') return
    assert.ok(result.words !== undefined)
    // Each chunk measures 1200 ms, so the second chunk starts at 1200 ms.
    const starts = (result.words ?? []).map((word) => word.offsetMs)
    assert.ok(starts.some((offset) => offset === 1200), `expected a 1200 ms offset, got ${starts.join(',')}`)
    assert.equal(result.durationMs, 2400)
  } finally {
    setEdgeJsLoader(undefined)
    await rm(dir, { recursive: true, force: true })
  }
})
