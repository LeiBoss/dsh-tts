import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { cacheKey, dateDirName } from '../src/cache.ts'
import { resolveConfig } from '../src/config.ts'
import { synthesize } from '../src/edge-tts.ts'
import { ErrorCode, TtsError } from '../src/errors.ts'
import { createTtsTools } from '../src/index.ts'
import { selfCheck } from '../src/self-check.ts'
import {
  erroringSpawn,
  executionContext,
  failingSpawn,
  hangingSpawn,
  successfulSpawn,
  throwingSpawn,
  versionSpawn,
  type SpawnRecord,
} from './helpers.ts'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-edge-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const HASH = cacheKey('hello world', 'zh-CN-XiaoxiaoNeural', '+0%')
const FIXED_NOW = new Date(2026, 10, 11, 12, 0, 0)

function baseOptions(dir: string, overrides: Record<string, unknown> = {}) {
  return {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+0%',
    binary: 'edge-tts',
    outputDir: dir,
    hash: HASH,
    timeoutMs: 1_000,
    now: FIXED_NOW,
    ...overrides,
  }
}

test('synthesize writes an mp3 at the dated path and passes the canonical CLI args', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const audio = await synthesize('hello world', {
      ...baseOptions(dir),
      spawnImpl: successfulSpawn(calls),
    })

    const expected = join(
      dir,
      dateDirName(FIXED_NOW),
      `${HASH}-${FIXED_NOW.getTime()}.mp3`,
    )
    assert.equal(audio.filePath, expected)
    assert.equal(audio.format, 'mp3')
    assert.equal(await readFile(expected, 'utf8'), 'ID3fake-mp3-bytes')

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.command, 'edge-tts')
    assert.ok(calls[0]?.args.includes('--text=hello world'))
    assert.ok(calls[0]?.args.includes('--voice=zh-CN-XiaoxiaoNeural'))
    assert.ok(calls[0]?.args.includes('--rate=+0%'))
    assert.ok(calls[0]?.args.some((arg) => arg.startsWith('--write-media=')))

    const entries = await readdir(join(dir, dateDirName(FIXED_NOW)))
    assert.deepEqual(entries, [`${HASH}-${FIXED_NOW.getTime()}.mp3`])
  })
})

test('a synchronous spawn EPERM becomes SPAWN_EPERM, not a filesystem error', async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      synthesize('hello world', {
        ...baseOptions(dir),
        spawnImpl: throwingSpawn('EPERM'),
      }),
      (error: unknown) =>
        error instanceof TtsError &&
        error.code === ErrorCode.SpawnEperm &&
        /sandbox/i.test(error.message) &&
        /sandbox/i.test(error.suggestion ?? ''),
    )
  })
})

test('an asynchronous spawn EPERM is also classified as SPAWN_EPERM', async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      synthesize('hello world', {
        ...baseOptions(dir),
        spawnImpl: erroringSpawn('EPERM'),
      }),
      (error: unknown) => error instanceof TtsError && error.code === ErrorCode.SpawnEperm,
    )
  })
})

test('a missing edge-tts binary becomes EDGE_TTS_NOT_FOUND', async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      synthesize('hello world', {
        ...baseOptions(dir),
        spawnImpl: throwingSpawn('ENOENT'),
      }),
      (error: unknown) =>
        error instanceof TtsError &&
        error.code === ErrorCode.EdgeTtsNotFound &&
        /pip install edge-tts/.test(error.suggestion ?? ''),
    )
  })
})

test('a non-zero exit reports the exit code and captured stderr', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    await assert.rejects(
      synthesize('hello world', {
        ...baseOptions(dir),
        spawnImpl: failingSpawn(calls, 2, 'Voice not found: nope'),
      }),
      (error: unknown) =>
        error instanceof TtsError &&
        error.code === ErrorCode.EdgeTtsFailed &&
        /code 2/.test(error.message) &&
        /Voice not found: nope/.test(error.message),
    )
  })
})

test('a hanging process is killed and reported as SYNTHESIS_TIMEOUT', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const hanging = hangingSpawn(calls)

    await assert.rejects(
      synthesize('hello world', {
        ...baseOptions(dir, { timeoutMs: 30 }),
        spawnImpl: hanging.spawn,
      }),
      (error: unknown) =>
        error instanceof TtsError && error.code === ErrorCode.SynthesisTimeout,
    )

    assert.equal(hanging.children.length, 1)
    assert.ok((hanging.children[0]?.kills.length ?? 0) > 0, 'the child must be killed')
  })
})

test('an aborted call kills the child and reports ABORTED', async () => {
  await withTempDir(async (dir) => {
    const hanging = hangingSpawn([])
    const controller = new AbortController()
    const pending = synthesize('hello world', {
      ...baseOptions(dir, { timeoutMs: 5_000 }),
      spawnImpl: hanging.spawn,
      signal: controller.signal,
    })

    controller.abort()

    await assert.rejects(
      pending,
      (error: unknown) => error instanceof TtsError && error.code === ErrorCode.Aborted,
    )
    assert.ok((hanging.children[0]?.kills.length ?? 0) > 0)
  })
})

test('an empty media file becomes EMPTY_AUDIO', async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      synthesize('hello world', {
        ...baseOptions(dir),
        spawnImpl: successfulSpawn([], Buffer.alloc(0)),
      }),
      (error: unknown) => error instanceof TtsError && error.code === ErrorCode.EmptyAudio,
    )
  })
})

test('self-check reports an available binary and its version', async () => {
  await withTempDir(async (dir) => {
    const config = resolveConfig({ outputDir: dir }, { DSH_HOME: '/tmp/dsh-home' })
    const result = await selfCheck({ config, spawnImpl: versionSpawn('7.0.2') })

    assert.deepEqual(result, {
      edgeTtsAvailable: true,
      edgeTtsVersion: '7.0.2',
      spawnAllowed: true,
      outputDirWritable: true,
      dshHome: '/tmp/dsh-home',
    })
  })
})

test('self-check distinguishes a missing binary from a denied spawn', async () => {
  await withTempDir(async (dir) => {
    const config = resolveConfig({ outputDir: dir }, {})

    const missing = await selfCheck({ config, spawnImpl: throwingSpawn('ENOENT') })
    assert.equal(missing.edgeTtsAvailable, false)
    assert.equal(missing.spawnAllowed, true)

    const denied = await selfCheck({ config, spawnImpl: throwingSpawn('EPERM') })
    assert.equal(denied.edgeTtsAvailable, false)
    assert.equal(denied.spawnAllowed, false)
  })
})

test('self-check reports an unwritable output directory', async () => {
  await withTempDir(async (dir) => {
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'not a directory')
    const config = resolveConfig(
      { outputDir: join(blocker, 'nested') },
      {},
    )

    const result = await selfCheck({ config, spawnImpl: versionSpawn('7.0.2') })
    assert.equal(result.outputDirWritable, false)
    assert.equal(result.edgeTtsAvailable, true)
  })
})

test('the configured defaultVoice is used when the call omits a voice', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const config = resolveConfig(
      { outputDir: dir, defaultVoice: 'en-US-AriaNeural' },
      {},
    )
    const [generate] = createTtsTools(config, { spawnImpl: successfulSpawn(calls) })
    assert.ok(generate)

    await generate.execute({ text: 'voice override' }, executionContext())

    assert.ok(calls[0]?.args.includes('--voice=en-US-AriaNeural'))
    assert.ok(calls[0]?.args.includes('--rate=+0%'))
  })
})

test('self-check never requires a writable probe file and also works with mkdir', async () => {
  await withTempDir(async (dir) => {
    const nested = join(dir, 'a', 'b')
    await mkdir(nested, { recursive: true })
    const config = resolveConfig({ outputDir: nested }, {})

    const result = await selfCheck({ config, spawnImpl: versionSpawn('7.0.2') })
    assert.equal(result.outputDirWritable, true)
  })
})
