import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

    assert.deepEqual(Object.keys(result).sort(), [
      'fallback',
      'fallbackReason',
      'rate',
      'text',
      'voice',
    ])
    assert.equal('filePath' in result, false)
    assert.equal('format' in result, false)
    assert.equal(result.fallback, 'speechSynthesis')
    assert.equal(result.text, 'fallback marker')
    assert.equal(result.voice, 'zh-CN-XiaoxiaoNeural')
    assert.equal(result.rate, '+0%')
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

    const ffmpegArgs = calls[1]?.args ?? []
    assert.equal(
      ffmpegArgs.includes('-f'),
      false,
      'ffmpeg must infer the muxer from the .mp3 output extension',
    )
    const outputPath = ffmpegArgs[ffmpegArgs.length - 1] ?? ''
    assert.match(
      outputPath,
      /\.mp3$/,
      'the partial file needs an .mp3 suffix or ffmpeg refuses to pick a format',
    )
  })
})

test(
  'real ffmpeg produces a decodable MP3 (TTS_SAPI_INTEGRATION=1)',
  {
    skip:
      process.env.TTS_SAPI_INTEGRATION !== '1' ||
      process.platform !== 'win32',
  },
  async () => {
    await withTempDir(async (dir) => {
      const now = new Date(2026, 10, 11, 12, 0, 0)
      const hash = cacheKey('real sapi integration', 'zh-CN-XiaoxiaoNeural', '+0%')
      const audio = await synthesizeSapi('real sapi integration', {
        rate: '+0%',
        outputDir: dir,
        hash,
        timeoutMs: 30_000,
        now,
      })

      const bytes = await readFile(audio.filePath)
      assert.ok(bytes.length > 0, 'converted file must not be empty')
      const id3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33
      const frame = bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0
      assert.ok(id3 || frame, `not an MP3: ${bytes.subarray(0, 4).toString('hex')}`)
    })
  },
)

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

test('a SAPI cache hit still reports engine=sapi from its sidecar', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const generate = setup(dir, {
      platform: 'win32',
      spawnImpl: failingSpawn(calls, 2, 'edge down'),
      sapiSynthesize: async (_text, options) => {
        const target = outputFilePath(
          options.outputDir,
          options.hash,
          options.now,
        )
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, 'ID3sapi')
        return { filePath: target, format: 'mp3' }
      },
    })

    const first = await generate.execute(
      { text: 'sapi cache hit' },
      executionContext(),
    )
    assert.equal(first.engine, 'sapi')

    const second = await generate.execute(
      { text: 'sapi cache hit' },
      executionContext(),
    )
    assert.equal(second.filePath, first.filePath)
    assert.equal(second.engine, 'sapi')
    assert.equal(calls.length, 1, 'cache hit must not spawn again')

    const metadata = JSON.parse(
      await readFile(`${first.filePath}.json`, 'utf8'),
    )
    assert.equal(metadata.engine, 'sapi')
  })
})

test('a missing sidecar keeps the legacy cache-hit shape', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const generate = setup(dir, { spawnImpl: successfulSpawn(calls) })

    const first = await generate.execute(
      { text: 'no sidecar' },
      executionContext(),
    )
    await rm(`${first.filePath}.json`, { force: true })

    const second = await generate.execute(
      { text: 'no sidecar' },
      executionContext(),
    )
    assert.equal(second.filePath, first.filePath)
    assert.equal('engine' in second, false)
    assert.equal(calls.length, 1)
  })
})

test('the speechSynthesis fallback reports why every engine failed', async () => {
  await withTempDir(async (dir) => {
    const text = '这段文字不应出现在降级原因里'
    const generate = setup(dir, {
      spawnImpl: hangingSpawn([]).spawn,
      platform: 'win32',
      config: { timeoutMs: 20 },
      sapiSynthesize: async () => {
        throw new Error(
          `ffmpeg exited with code -22: Unable to choose an output format for '${join(dir, 'clip.mp3.partial')}'`,
        )
      },
    })

    const result = await generate.execute({ text }, executionContext())

    assert.equal(result.fallback, 'speechSynthesis')
    const reason = result.fallbackReason
    assert.equal(typeof reason, 'string')
    assert.match(String(reason), /edge-tts:/)
    assert.match(String(reason), /sapi:/)
    assert.equal(String(reason).includes(dir), false, 'must not leak temp paths')
    assert.equal(String(reason).includes(text), false, 'must not echo user text')

    const rendered = String(
      (
        generate as unknown as {
          output: { render: (args: unknown, value: unknown) => Array<{ text: string }> }
        }
      ).output.render({}, result)[0]?.text,
    )
    assert.match(rendered, /Reason: /)
    assert.match(rendered, /edge-tts:/)
  })
})
