import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cacheKey } from '../src/cache.ts'
import { resolveConfig } from '../src/config.ts'
import { outputFilePath } from '../src/cache.ts'
import type { SpawnFunction, SynthesizedAudio } from '../src/edge-tts.ts'
import { ErrorCode, TtsError } from '../src/errors.ts'
import { isFallbackEligible } from '../src/fallback.ts'
import { createTtsTools } from '../src/index.ts'
import {
  isSapiSupported,
  sapiRate,
  synthesizeSapi,
  type SapiOptions,
} from '../src/sapi-tts.ts'
import {
  FakeChild,
  executionContext,
  failingSpawn,
  hangingSpawn,
  successfulSpawn,
  type SpawnRecord,
} from './helpers.ts'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-fallback-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function setup(
  dir: string,
  options: {
    spawnImpl: SpawnFunction
    platform?: NodeJS.Platform
    sapiSynthesize?: (
      text: string,
      options: SapiOptions,
    ) => Promise<SynthesizedAudio>
    config?: Record<string, unknown>
  },
) {
  const config = resolveConfig({ outputDir: dir, ...options.config }, {})
  const tools = createTtsTools(config, {
    spawnImpl: options.spawnImpl,
    platform: options.platform,
    sapiSynthesize: options.sapiSynthesize,
    chunkDelayMs: 0,
  })
  const generate = tools[0]
  assert.ok(generate)
  return generate
}

test('fallback eligibility excludes validation, config, and abort errors', () => {
  const eligible = [
    ErrorCode.EdgeTtsNotFound,
    ErrorCode.SpawnEperm,
    ErrorCode.SpawnFailed,
    ErrorCode.EdgeTtsFailed,
    ErrorCode.SynthesisTimeout,
    ErrorCode.EmptyAudio,
  ]
  for (const code of eligible) {
    assert.equal(isFallbackEligible(new TtsError(code, 'engine failed')), true, code)
  }

  const excluded = [
    ErrorCode.EmptyText,
    ErrorCode.InvalidVoice,
    ErrorCode.InvalidRate,
    ErrorCode.InvalidConfig,
    ErrorCode.DshHomeNotSet,
    ErrorCode.OutputDirNotWritable,
    ErrorCode.Aborted,
  ]
  for (const code of excluded) {
    assert.equal(isFallbackEligible(new TtsError(code, 'not an engine failure')), false, code)
  }
  assert.equal(isFallbackEligible(new Error('plain')), false)
})

test('a non-Windows Edge-TTS failure returns the speechSynthesis marker', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const generate = setup(dir, {
      spawnImpl: failingSpawn(calls, 2, 'network unreachable'),
      platform: 'linux',
    })

    const result = await generate.execute({ text: 'fallback marker' }, executionContext())

    assert.deepEqual(Object.keys(result).sort(), ['engine', 'fallback', 'filePath', 'format'])
    assert.equal(result.filePath, '')
    assert.equal(result.format, '')
    assert.equal(result.engine, 'speechSynthesis')
    assert.equal(result.fallback, 'speechSynthesis')
    assert.equal(calls.length, 1, 'SAPI must be skipped on Linux')
  })
})

test('a chain without speechSynthesis ends as ALL_FALLBACKS_FAILED', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const generate = setup(dir, {
      spawnImpl: failingSpawn(calls, 2, 'edge is down'),
      platform: 'linux',
      config: { fallbackOrder: ['edge-tts'] },
    })

    await assert.rejects(
      generate.execute({ text: 'chain exhausted' }, executionContext()),
      (error: unknown) =>
        error instanceof TtsError &&
        error.code === ErrorCode.AllFallbacksFailed &&
        /Chain: edge-tts/.test(error.message) &&
        /EDGE_TTS_FAILED/.test(error.message),
    )
  })
})

test('fallbackEnabled=false keeps the original EDGE_TTS_FAILED error', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const generate = setup(dir, {
      spawnImpl: failingSpawn(calls, 2, 'edge is down'),
      platform: 'linux',
      config: { fallbackEnabled: false },
    })

    await assert.rejects(
      generate.execute({ text: 'no fallback' }, executionContext()),
      (error: unknown) =>
        error instanceof TtsError && error.code === ErrorCode.EdgeTtsFailed,
    )
    assert.equal(calls.length, 1)
  })
})

test('validation failures never enter the fallback chain', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const generate = setup(dir, { spawnImpl: failingSpawn(calls, 2, 'never reached') })

    await assert.rejects(
      generate.execute({ text: '   ' }, executionContext()),
      (error: unknown) => error instanceof TtsError && error.code === ErrorCode.EmptyText,
    )
    assert.equal(calls.length, 0)
  })
})

test('an aborted Edge-TTS call propagates ABORTED instead of falling back', async () => {
  await withTempDir(async (dir) => {
    const hanging = hangingSpawn([])
    const config = resolveConfig({ outputDir: dir }, {})
    const [generate] = createTtsTools(config, {
      spawnImpl: hanging.spawn,
      platform: 'linux',
    })
    assert.ok(generate)

    const controller = new AbortController()
    const pending = generate.execute(
      { text: 'abort me' },
      executionContext(controller.signal),
    )
    controller.abort()

    await assert.rejects(
      pending,
      (error: unknown) => error instanceof TtsError && error.code === ErrorCode.Aborted,
    )
  })
})

test('an empty Edge-TTS audio file triggers the fallback chain', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const generate = setup(dir, {
      spawnImpl: successfulSpawn(calls, Buffer.alloc(0)),
      platform: 'linux',
    })

    const result = await generate.execute({ text: 'empty audio' }, executionContext())
    assert.equal(result.fallback, 'speechSynthesis')
    assert.equal(calls.length, 1)
  })
})

test('Windows falls back to SAPI and reports engine=sapi', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    let sapiCalls = 0

    const generate = setup(dir, {
      spawnImpl: failingSpawn(calls, 2, 'edge is down'),
      platform: 'win32',
      sapiSynthesize: async (text, options) => {
        sapiCalls += 1
        const filePath = join(options.outputDir, 'sapi.mp3')
        writeFileSync(filePath, Buffer.from(`ID3sapi:${text}`))
        return { filePath, format: 'mp3' }
      },
    })

    const result = await generate.execute({ text: 'spoken by sapi' }, executionContext())

    assert.equal(sapiCalls, 1)
    assert.equal(result.engine, 'sapi')
    assert.equal(result.format, 'mp3')
    assert.equal('fallback' in result, false)
    assert.equal(await readFile(result.filePath, 'utf8'), 'ID3sapi:spoken by sapi')
  })
})

test('a failed SAPI attempt continues to the speechSynthesis marker', async () => {
  await withTempDir(async (dir) => {
    let sapiCalls = 0
    const generate = setup(dir, {
      spawnImpl: failingSpawn([], 2, 'edge is down'),
      platform: 'win32',
      sapiSynthesize: async () => {
        sapiCalls += 1
        throw new Error('ffmpeg is missing')
      },
    })

    const result = await generate.execute({ text: 'sapi failed' }, executionContext())
    assert.equal(sapiCalls, 1)
    assert.equal(result.fallback, 'speechSynthesis')
  })
})

test('fallbackOrder is honoured: speechSynthesis before sapi skips SAPI', async () => {
  await withTempDir(async (dir) => {
    let sapiCalls = 0
    const generate = setup(dir, {
      spawnImpl: failingSpawn([], 2, 'edge is down'),
      platform: 'win32',
      config: { fallbackOrder: ['edge-tts', 'speechSynthesis', 'sapi'] },
      sapiSynthesize: async () => {
        sapiCalls += 1
        throw new Error('should not run')
      },
    })

    const result = await generate.execute({ text: 'order matters' }, executionContext())
    assert.equal(result.fallback, 'speechSynthesis')
    assert.equal(sapiCalls, 0)
  })
})

test('a cache hit never invokes the fallback chain', async () => {
  await withTempDir(async (dir) => {
    let calls = 0
    const spawn: SpawnFunction = (command, args) => {
      calls += 1
      const child = new FakeChild()
      if (calls > 1) {
        queueMicrotask(() => {
          child.stderr.write('edge went away')
          child.emit('close', 2, null)
        })
        return child
      }
      const media = args.find((arg) => arg.startsWith('--write-media='))
      queueMicrotask(() => {
        if (media) writeFileSync(media.slice('--write-media='.length), Buffer.from('ID3'))
        child.emit('close', 0, null)
      })
      return child
    }

    const generate = setup(dir, { spawnImpl: spawn, platform: 'linux' })
    const first = await generate.execute({ text: 'cached' }, executionContext())
    const second = await generate.execute({ text: 'cached' }, executionContext())

    assert.equal(calls, 1)
    assert.deepEqual(second, first)
    assert.equal('fallback' in second, false)
  })
})

test('sapiRate maps Edge percentages onto the SAPI -10..10 scale', () => {
  assert.equal(sapiRate('+0%'), 0)
  assert.equal(sapiRate('+25%'), 3)
  assert.equal(sapiRate('-10%'), -1)
  assert.equal(sapiRate('-100%'), -10)
  assert.equal(sapiRate('+150%'), 10)
  assert.equal(sapiRate('fast'), 0)
  assert.equal(isSapiSupported('win32'), true)
  assert.equal(isSapiSupported('linux'), false)
})

test('SAPI orchestration runs PowerShell then ffmpeg and publishes an MP3', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const spawn: SpawnFunction = (command, args) => {
      calls.push({ command, args: [...args] })
      const child = new FakeChild()
      queueMicrotask(() => {
        if (command === 'powershell.exe') {
          const script = args[args.length - 1] ?? ''
          const match = /SetOutputToWaveFile\('([^']+)'\)/.exec(script)
          assert.ok(match)
          writeFileSync(match[1] ?? '', Buffer.from('RIFFwav'))
        } else if (command === 'ffmpeg') {
          writeFileSync(args[args.length - 1] ?? '', Buffer.from('ID3converted'))
        }
        child.emit('close', 0, null)
      })
      return child
    }

    const now = new Date(2026, 10, 11, 12, 0, 0)
    const hash = cacheKey('sapi text', 'zh-CN-XiaoxiaoNeural', '+0%')
    const audio = await synthesizeSapi('sapi text', {
      rate: '+0%',
      outputDir: dir,
      hash,
      timeoutMs: 1_000,
      spawnImpl: spawn,
      platform: 'win32',
      now,
    })

    assert.equal(audio.filePath, outputFilePath(dir, hash, now))
    assert.equal(audio.format, 'mp3')
    assert.equal(await readFile(audio.filePath, 'utf8'), 'ID3converted')
    assert.ok((await stat(audio.filePath)).size > 0)
    assert.deepEqual(
      calls.map((call) => call.command),
      ['powershell.exe', 'ffmpeg'],
    )
  })
})

test('SAPI refuses to run on non-Windows platforms', async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      synthesizeSapi('nope', {
        rate: '+0%',
        outputDir: dir,
        hash: 'abc',
        timeoutMs: 1_000,
        platform: 'linux',
      }),
      /only available on Windows/,
    )
  })
})
