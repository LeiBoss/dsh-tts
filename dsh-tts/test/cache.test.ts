import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { cacheKey, dateDirName, findCachedFile } from '../src/cache.ts'
import { resolveConfig } from '../src/config.ts'
import { createTtsTools } from '../src/index.ts'
import { executionContext, successfulSpawn } from './helpers.ts'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-cache-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('cacheKey is stable and covers text, voice, and rate', () => {
  const base = cacheKey('hello', 'zh-CN-XiaoxiaoNeural', '+0%')

  assert.equal(base, cacheKey('hello', 'zh-CN-XiaoxiaoNeural', '+0%'))
  assert.match(base, /^[0-9a-f]{16}$/)
  assert.notEqual(base, cacheKey('hello!', 'zh-CN-XiaoxiaoNeural', '+0%'))
  assert.notEqual(base, cacheKey('hello', 'en-US-AriaNeural', '+0%'))
  assert.notEqual(base, cacheKey('hello', 'zh-CN-XiaoxiaoNeural', '-10%'))
})

test('findCachedFile only accepts non-empty hash-prefixed audio files', async () => {
  await withTempDir(async (dir) => {
    const hash = cacheKey('cached text', 'zh-CN-XiaoxiaoNeural', '+0%')
    const today = join(dir, dateDirName())
    await mkdir(today, { recursive: true })

    const empty = join(today, `${hash}-1.mp3`)
    await writeFile(empty, '')
    assert.equal(await findCachedFile(dir, hash), undefined)

    const valid = join(today, `${hash}-2.mp3`)
    await writeFile(valid, 'audio')
    assert.equal(await findCachedFile(dir, hash), valid)

    const otherHash = join(today, `${cacheKey('other', 'zh-CN-XiaoxiaoNeural', '+0%')}-3.mp3`)
    await writeFile(otherHash, 'audio')
    assert.equal(await findCachedFile(dir, hash), valid)
  })
})

test('a second identical call hits the cache and never spawns again', async () => {
  await withTempDir(async (dir) => {
    const calls: Parameters<typeof successfulSpawn>[0] = []
    const config = resolveConfig({ outputDir: dir }, {})
    const [generate] = createTtsTools(config, { spawnImpl: successfulSpawn(calls) })
    assert.ok(generate)

    const first = await generate.execute(
      { text: 'same text', voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%' },
      executionContext(),
    )
    assert.equal(calls.length, 1)

    const second = await generate.execute(
      { text: 'same text', voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%' },
      executionContext(),
    )

    assert.equal(calls.length, 1, 'the second call must not spawn a child process')
    assert.deepEqual(second, first)

    const hash = cacheKey('same text', 'zh-CN-XiaoxiaoNeural', '+0%')
    assert.match(basename(first.filePath), new RegExp(`^${hash}-\\d+\\.mp3$`))
  })
})

test('a different rate is a different cache entry', async () => {
  await withTempDir(async (dir) => {
    const calls: Parameters<typeof successfulSpawn>[0] = []
    const config = resolveConfig({ outputDir: dir }, {})
    const [generate] = createTtsTools(config, { spawnImpl: successfulSpawn(calls) })
    assert.ok(generate)

    const first = await generate.execute(
      { text: 'rate changes', rate: '+0%' },
      executionContext(),
    )
    const second = await generate.execute(
      { text: 'rate changes', rate: '-10%' },
      executionContext(),
    )

    assert.equal(calls.length, 2)
    assert.notEqual(second.filePath, first.filePath)
  })
})
