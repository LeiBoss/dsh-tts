import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'
import type { SpawnFunction } from '../src/edge-tts.ts'
import { createTtsTools } from '../src/index.ts'
import { AVAILABLE_VOICES, VOICES } from '../src/voices.ts'
import {
  executionContext,
  successfulSpawn,
  type SpawnRecord,
} from './helpers.ts'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-voices-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function setup(
  dir: string,
  spawnImpl: SpawnFunction,
  extra: Record<string, unknown> = {},
) {
  const config = resolveConfig({ outputDir: dir, ...extra }, {})
  const tools = createTtsTools(config, { spawnImpl, chunkDelayMs: 0 })
  const generate = tools[0]
  const check = tools[1]
  assert.ok(generate)
  assert.ok(check)
  return { generate, check }
}

test('the static catalogue has at least ten unique voices including the default', () => {
  assert.ok(VOICES.length >= 10)
  assert.equal(VOICES.length, AVAILABLE_VOICES.length)
  assert.equal(new Set(AVAILABLE_VOICES).size, AVAILABLE_VOICES.length)
  assert.ok(AVAILABLE_VOICES.includes('zh-CN-XiaoxiaoNeural'))
  for (const voice of VOICES) {
    assert.ok(voice.name.endsWith('Neural'))
    assert.ok(voice.gender === 'Female' || voice.gender === 'Male')
    assert.ok(voice.locale.length > 0)
    assert.ok(voice.description.length > 0)
  }
})

test('tts_self_check returns availableVoices without extra subprocesses', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const { check } = setup(dir, successfulSpawn(calls))

    const result = await check.execute({}, executionContext())

    assert.ok(Array.isArray(result.availableVoices))
    assert.ok(result.availableVoices.length >= 10)
    assert.ok(result.availableVoices.includes('zh-CN-XiaoxiaoNeural'))
    assert.deepEqual(result.availableVoices, [...AVAILABLE_VOICES])
    assert.equal(calls.length, 1, 'only the --version probe may spawn')
  })
})

test('pitch is forwarded as --pitch', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const { generate } = setup(dir, successfulSpawn(calls))

    await generate.execute(
      { text: 'pitch test', pitch: '+10Hz' },
      executionContext(),
    )

    assert.ok(calls[0]?.args.includes('--pitch=+10Hz'))
    assert.ok(calls[0]?.args.includes('--volume=+0%'))
  })
})

test('volume is forwarded as --volume', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const { generate } = setup(dir, successfulSpawn(calls))

    await generate.execute(
      { text: 'volume test', volume: '-20%' },
      executionContext(),
    )

    assert.ok(calls[0]?.args.includes('--volume=-20%'))
    assert.ok(calls[0]?.args.includes('--pitch=+0Hz'))
  })
})

test('omitting pitch and volume uses the documented defaults', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const { generate } = setup(dir, successfulSpawn(calls))

    await generate.execute({ text: 'defaults' }, executionContext())

    assert.ok(calls[0]?.args.includes('--pitch=+0Hz'))
    assert.ok(calls[0]?.args.includes('--volume=+0%'))
  })
})

test('a different pitch still hits the (text, voice, rate) cache', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const { generate } = setup(dir, successfulSpawn(calls))

    const first = await generate.execute(
      { text: 'cache me', pitch: '+10Hz' },
      executionContext(),
    )
    const second = await generate.execute(
      { text: 'cache me', pitch: '-20Hz', volume: '+20%' },
      executionContext(),
    )

    assert.equal(calls.length, 1)
    assert.deepEqual(second, first)
  })
})

test('chunked synthesis forwards pitch and volume to every chunk', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const text = '第一句话需要足够长。第二句话也需要足够长。第三句话同样需要足够长。第四句话仍然需要足够长。'
    const { generate } = setup(dir, successfulSpawn(calls), {
      chunkSize: 20,
    })

    const result = await generate.execute(
      { text, pitch: '+5Hz', volume: '+10%' },
      executionContext(),
    )

    assert.ok(calls.length >= 2, 'text must be split into multiple chunks')
    for (const call of calls) {
      assert.ok(call.args.includes('--pitch=+5Hz'))
      assert.ok(call.args.includes('--volume=+10%'))
    }
    assert.equal(result.format, 'mp3')
    const bytes = await readFile(result.filePath)
    assert.equal(
      bytes.length,
      calls.length * Buffer.byteLength('ID3fake-mp3-bytes'),
      'chunks must be concatenated into one file',
    )
  })
})
