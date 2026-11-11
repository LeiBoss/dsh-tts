import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { cacheKey } from '../src/cache.ts'
import { splitText } from '../src/chunker.ts'
import { synthesizeChunked } from '../src/chunked-tts.ts'
import { resolveConfig } from '../src/config.ts'
import type { SpawnFunction } from '../src/edge-tts.ts'
import { ErrorCode, TtsError } from '../src/errors.ts'
import { createTtsTools } from '../src/index.ts'
import { FakeChild, executionContext, successfulSpawn } from './helpers.ts'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-chunker-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function mediaPath(args: readonly string[]): string | undefined {
  const option = args.find((arg) => arg.startsWith('--write-media='))
  return option?.slice('--write-media='.length)
}

test('short text stays in one chunk', () => {
  assert.deepEqual(splitText('只有一句话。', 1_200), ['只有一句话。'])
  assert.deepEqual(splitText('', 1_200), [])
})

test('long text splits at sentence boundaries without losing content', () => {
  const text = '第一句话在这里。第二句话在这里！第三句话在这里？'.repeat(40)
  const chunks = splitText(text, 100)

  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(Array.from(chunk).length <= 100, `chunk too long: ${chunk.length}`)
    assert.match(chunk, /[。！？]$/)
  }
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''))
})

test('a run-on line falls back to a hard cut at the size limit', () => {
  const chunks = splitText('a'.repeat(2_500), 1_000)
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [1_000, 1_000, 500],
  )
})

test('code-point slicing never splits a surrogate pair', () => {
  const text = '😀'.repeat(50)
  const chunks = splitText(text, 10)

  assert.equal(chunks.join(''), text)
  for (const chunk of chunks) {
    assert.equal(Array.from(chunk).length, 10)
    assert.doesNotMatch(chunk, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  }
})

test('an invalid chunk size is rejected', () => {
  assert.throws(() => splitText('text', 0), RangeError)
  assert.throws(() => splitText('text', -5), RangeError)
  assert.throws(() => splitText('text', 1.5), RangeError)
})

test('chunked synthesis writes one concatenated file at the full-text cache path', async () => {
  await withTempDir(async (dir) => {
    const text = '这是第一句话。这是第二句话。这是第三句话。'.repeat(12)
    const chunkSize = 100
    const chunks = splitText(text, chunkSize)
    assert.ok(chunks.length > 1)

    const calls: Parameters<typeof successfulSpawn>[0] = []
    const bytes = Buffer.from('ID3chunk-audio')
    const config = resolveConfig({ outputDir: dir, chunkSize }, {})
    const [generate] = createTtsTools(config, {
      spawnImpl: successfulSpawn(calls, bytes),
      chunkDelayMs: 0,
    })
    assert.ok(generate)

    const result = await generate.execute({ text }, executionContext())

    assert.equal(calls.length, chunks.length, 'one subprocess per chunk')
    assert.deepEqual(Object.keys(result).sort(), ['filePath', 'format'])
    assert.equal(result.format, 'mp3')

    const hash = cacheKey(text, 'zh-CN-XiaoxiaoNeural', '+0%')
    assert.match(basename(result.filePath), new RegExp(`^${hash}-\\d+\\.mp3$`))

    const written = await readFile(result.filePath)
    assert.deepEqual(written, Buffer.concat(chunks.map(() => bytes)))
    assert.equal((await stat(result.filePath)).size, chunks.length * bytes.length)

    const again = await generate.execute({ text }, executionContext())
    assert.equal(calls.length, chunks.length, 'the second call must use the cache')
    assert.deepEqual(again, result)
  })
})

test('chunk failures name the index and keep the original code', async () => {
  await withTempDir(async (dir) => {
    const text = '这是第一句话。这是第二句话。这是第三句话。'.repeat(12)
    const bytes = Buffer.from('ID3chunk-audio')
    let calls = 0

    const spawn: SpawnFunction = (command, args) => {
      calls += 1
      const child = new FakeChild()
      if (calls === 2) {
        queueMicrotask(() => {
          child.stderr.write('voice exploded')
          child.emit('close', 2, null)
        })
      } else {
        queueMicrotask(() => {
          const target = mediaPath(args)
          if (target) writeFileSync(target, bytes)
          child.emit('close', 0, null)
        })
      }
      return child
    }

    await assert.rejects(
      synthesizeChunked(text, {
        voice: 'zh-CN-XiaoxiaoNeural',
        rate: '+0%',
        binary: 'edge-tts',
        outputDir: dir,
        hash: cacheKey(text, 'zh-CN-XiaoxiaoNeural', '+0%'),
        timeoutMs: 1_000,
        chunkSize: 100,
        spawnImpl: spawn,
        interChunkDelayMs: 0,
      }),
      (error: unknown) =>
        error instanceof TtsError &&
        error.code === ErrorCode.EdgeTtsFailed &&
        /Chunk 2\/\d+/.test(error.detail) &&
        /voice exploded/.test(error.message),
    )
  })
})

test('chunks are synthesized serially, never in parallel', async () => {
  await withTempDir(async (dir) => {
    const text = '串行合成测试句子。'.repeat(60)
    let active = 0
    let maxActive = 0

    const spawn: SpawnFunction = (command, args) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      const child = new FakeChild()
      queueMicrotask(() => {
        const target = mediaPath(args)
        if (target) writeFileSync(target, Buffer.from('ID3'))
        active -= 1
        child.emit('close', 0, null)
      })
      return child
    }

    await synthesizeChunked(text, {
      voice: 'zh-CN-XiaoxiaoNeural',
      rate: '+0%',
      binary: 'edge-tts',
      outputDir: dir,
      hash: cacheKey(text, 'zh-CN-XiaoxiaoNeural', '+0%'),
      timeoutMs: 1_000,
      chunkSize: 80,
      spawnImpl: spawn,
      interChunkDelayMs: 0,
    })

    assert.equal(maxActive, 1)
  })
})
