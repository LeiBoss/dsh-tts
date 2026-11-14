import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig, type ResolvedConfig } from '../src/config.ts'
import { setEdgeJsLoader } from '../src/engines/edge-js.ts'
import { ErrorCode, TtsError } from '../src/errors.ts'
import { TtsService } from '../src/service.ts'

/** One 144-byte MPEG-2 Layer III frame at 24 kHz (576 samples). */
function frame(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xf3, 0x64, 0xc0]), Buffer.alloc(140)])
}

/** A config rooted at a temp dir, with overrides. */
function config(outputDir: string, overrides: Record<string, unknown> = {}): ResolvedConfig {
  return resolveConfig({ outputDir, ...overrides }, {})
}

/** Raise the given code from a service call. */
async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof TtsError && error.code === code)
}

test('rejects malformed requests before touching the engine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-service-'))
  try {
    const service = new TtsService(config(dir))

    await rejectsWithCode(service.synthesize({ text: '   ' }), ErrorCode.EmptyText)
    await rejectsWithCode(service.synthesize({ text: 'hi', voice: 'not-a-voice' }), ErrorCode.InvalidVoice)
    await rejectsWithCode(service.synthesize({ text: 'hi', rate: '10%' }), ErrorCode.InvalidRate)
    await rejectsWithCode(service.synthesize({ text: 'hi', pitch: '10' }), ErrorCode.InvalidPitch)
    await rejectsWithCode(service.synthesize({ text: 'hi', volume: 'loud' }), ErrorCode.InvalidVolume)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reports a missing output directory instead of failing later', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-service-'))
  try {
    const broken: ResolvedConfig = { ...config(dir), outputDir: '' }
    await rejectsWithCode(new TtsService(broken).synthesize({ text: 'hi' }), ErrorCode.DshHomeNotSet)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('capabilities stay conservative until the backend is resolved', () => {
  const service = new TtsService(config('C:\\tmp'))
  // Unknown yet: claiming word boundaries before the engine is chosen would be
  // a promise the CLI backend cannot keep.
  assert.equal(service.capabilities.wordBoundaries, false)
  assert.deepEqual(service.capabilities.formats, ['mp3'])
})

test('engine=sapi uses the local engine instead of the Edge CLI', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-service-'))
  try {
    const filePath = join(dir, 'sapi.mp3')
    await writeFile(filePath, Buffer.concat(Array.from({ length: 10 }, () => frame())))

    const service = new TtsService(config(dir, { engine: 'sapi' }), {
      platform: 'win32',
      synthesizeSapiImpl: async () => ({ filePath, format: 'mp3' }),
    })

    const result = await service.synthesize({ text: '本地语音' })
    assert.equal(result.kind, 'audio')
    if (result.kind !== 'audio') return
    assert.equal(result.engine, 'sapi')
    assert.ok(result.durationMs > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('engine=sapi without sapi in the fallback order fails loudly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-service-'))
  try {
    const service = new TtsService(config(dir, { engine: 'sapi', fallbackOrder: ['edge-tts'] }))
    await rejectsWithCode(service.synthesize({ text: 'hi' }), ErrorCode.EngineUnavailable)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a cached result is returned without touching the backend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-service-'))
  let calls = 0
  setEdgeJsLoader(async () => ({
    EdgeTTS: class {
      constructor(config2: Record<string, unknown>) {
        void config2
      }

      async *streamAudio(text: string): AsyncGenerator<Buffer | { part: string; start: number; end: number }> {
        calls += 1
        yield Buffer.concat(Array.from({ length: 10 }, () => frame()))
        yield { part: text.slice(0, 1), start: 0, end: 400 }
      }

      async ttsPromise(): Promise<void> {}
    },
  }))
  try {
    const service = new TtsService(config(dir, { engine: 'edge-js' }))
    const first = await service.synthesize({ text: '缓存测试' })
    assert.equal(first.kind, 'audio')
    assert.equal(calls, 1)

    const second = await service.synthesize({ text: '缓存测试' })
    assert.equal(second.kind, 'audio')
    if (second.kind !== 'audio') return
    assert.equal(second.fromCache, true)
    assert.equal(calls, 1, 'a cache hit must not start another synthesis')
    assert.equal(second.engine, 'edge-js')
  } finally {
    setEdgeJsLoader(undefined)
    await rm(dir, { recursive: true, force: true })
  }
})

test('pitch and volume participate in the cache key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-service-'))
  let calls = 0
  setEdgeJsLoader(async () => ({
    EdgeTTS: class {
      constructor(config2: Record<string, unknown>) {
        void config2
      }

      async *streamAudio(): AsyncGenerator<Buffer> {
        calls += 1
        yield Buffer.concat(Array.from({ length: 10 }, () => frame()))
      }

      async ttsPromise(): Promise<void> {}
    },
  }))
  try {
    const service = new TtsService(config(dir, { engine: 'edge-js' }))
    await service.synthesize({ text: '韵律', pitch: '+0Hz' })
    await service.synthesize({ text: '韵律', pitch: '+10Hz' })
    assert.equal(calls, 2, 'a different pitch must not reuse the first file')
  } finally {
    setEdgeJsLoader(undefined)
    await rm(dir, { recursive: true, force: true })
  }
})
