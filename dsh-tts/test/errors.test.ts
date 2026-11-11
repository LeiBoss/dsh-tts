import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { resolveConfig } from '../src/config.ts'
import { createTtsTools } from '../src/index.ts'
import { ErrorCode, TtsError, spawnFailure } from '../src/errors.ts'
import { executionContext, successfulSpawn } from './helpers.ts'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-errors-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function setup(dir: string) {
  const calls: Parameters<typeof successfulSpawn>[0] = []
  const config = resolveConfig({ outputDir: dir }, {})
  const [generate] = createTtsTools(config, { spawnImpl: successfulSpawn(calls) })
  assert.ok(generate)
  return { calls, generate }
}

test('TtsError carries code, message, and suggestion on the HarnessError base', () => {
  const error = new TtsError(ErrorCode.EmptyText, 'text is empty', 'pass some text')

  assert.equal(error.code, ErrorCode.EmptyText)
  assert.equal(error.detail, 'text is empty')
  assert.equal(error.suggestion, 'pass some text')
  assert.match(error.message, /text is empty/)
  assert.match(error.message, /pass some text/)
  assert.ok(error instanceof HarnessError)
  assert.ok(error instanceof Error)
})

test('spawnFailure maps EPERM to SPAWN_EPERM and points at the sandbox', () => {
  const error = spawnFailure(Object.assign(new Error('spawn edge-tts EPERM'), { code: 'EPERM' }))

  assert.equal(error.code, ErrorCode.SpawnEperm)
  assert.equal(error.code, 'SPAWN_EPERM')
  assert.match(error.message, /sandbox/i)
  assert.match(error.suggestion ?? '', /sandbox/i)
  assert.notEqual(error.code, ErrorCode.OutputDirNotWritable)
})

test('spawnFailure maps ENOENT to EDGE_TTS_NOT_FOUND with install guidance', () => {
  const error = spawnFailure(Object.assign(new Error('spawn edge-tts ENOENT'), { code: 'ENOENT' }))

  assert.equal(error.code, ErrorCode.EdgeTtsNotFound)
  assert.equal(error.code, 'EDGE_TTS_NOT_FOUND')
  assert.match(error.suggestion ?? '', /pip install edge-tts/)
})

test('empty text is rejected as EMPTY_TEXT without spawning', async () => {
  await withTempDir(async (dir) => {
    const { calls, generate } = setup(dir)

    await assert.rejects(
      generate.execute({ text: '   ' }, executionContext()),
      (error: unknown) =>
        error instanceof TtsError &&
        error.code === ErrorCode.EmptyText &&
        error.code === 'EMPTY_TEXT',
    )
    assert.equal(calls.length, 0)
  })
})

test('a malformed voice is rejected as INVALID_VOICE without spawning', async () => {
  await withTempDir(async (dir) => {
    const { calls, generate } = setup(dir)

    await assert.rejects(
      generate.execute({ text: 'hello', voice: 'definitely not a voice' }, executionContext()),
      (error: unknown) =>
        error instanceof TtsError &&
        error.code === ErrorCode.InvalidVoice &&
        error.code === 'INVALID_VOICE',
    )
    assert.equal(calls.length, 0)
  })
})

test('a malformed rate is rejected as INVALID_RATE without spawning', async () => {
  await withTempDir(async (dir) => {
    const { calls, generate } = setup(dir)

    await assert.rejects(
      generate.execute({ text: 'hello', rate: 'fast' }, executionContext()),
      (error: unknown) =>
        error instanceof TtsError && error.code === ErrorCode.InvalidRate,
    )
    assert.equal(calls.length, 0)
  })
})

test('canonical output contains only filePath and format', async () => {
  await withTempDir(async (dir) => {
    const { generate } = setup(dir)

    const result = await generate.execute(
      { text: 'canonical output' },
      executionContext(),
    )

    assert.deepEqual(Object.keys(result).sort(), ['filePath', 'format'])
    assert.equal(typeof result.filePath, 'string')
    assert.ok(isAbsolute(result.filePath))
    assert.equal(result.format, 'mp3')
    assert.equal('durationMs' in result, false)
  })
})
