import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig, type TtsConfig } from '../src/config.ts'
import type { SpawnFunction, SynthesizedAudio } from '../src/edge-tts.ts'
import { ErrorCode } from '../src/errors.ts'
import { createTtsTools } from '../src/index.ts'
import type { SapiOptions } from '../src/sapi-tts.ts'
import {
  executionContext,
  failingSpawn,
  hangingSpawn,
  successfulSpawn,
  versionSpawn,
  type SpawnRecord,
} from './helpers.ts'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-health-integration-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

interface SetupOptions {
  spawnImpl: SpawnFunction
  platform?: NodeJS.Platform
  sapiSynthesize?: (
    text: string,
    options: SapiOptions,
  ) => Promise<SynthesizedAudio>
  config?: Partial<TtsConfig>
  now?: () => Date
}

function setup(dir: string, options: SetupOptions) {
  const versionCalls: SpawnRecord[] = []
  const network = { calls: 0 }
  const spawnImpl: SpawnFunction = (command, args, spawnOptions) => {
    if (args.includes('--version')) {
      versionCalls.push({ command, args: [...args] })
      return versionSpawn('7.3.1')(command, args, spawnOptions)
    }
    return options.spawnImpl(command, args, spawnOptions)
  }
  const tools = createTtsTools(
    resolveConfig({ outputDir: dir, ...options.config }, {}),
    {
      spawnImpl,
      platform: options.platform,
      sapiSynthesize: options.sapiSynthesize,
      chunkDelayMs: 0,
      now: options.now,
      probeConnect: () => {
        network.calls += 1
        throw new Error('Network access is forbidden in this test.')
      },
    },
  )
  const [generate, check] = tools
  assert.ok(generate)
  assert.ok(check)
  return { generate, check, versionCalls, network }
}

function sapiStub(counter: { calls: number }) {
  return async (
    _text: string,
    options: SapiOptions,
  ): Promise<SynthesizedAudio> => {
    counter.calls += 1
    mkdirSync(options.outputDir, { recursive: true })
    const filePath = join(options.outputDir, `sapi-${counter.calls}.mp3`)
    writeFileSync(filePath, Buffer.from('ID3sapi'))
    return { filePath, format: 'mp3' }
  }
}

test('integration: an open Edge-TTS circuit is skipped without spawning it', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const sapi = { calls: 0 }
    const { generate } = setup(dir, {
      spawnImpl: failingSpawn(calls, 1, 'Invalid response status: 403'),
      platform: 'win32',
      sapiSynthesize: sapiStub(sapi),
    })

    const first = await generate.execute(
      { text: 'open the Edge-TTS circuit' },
      executionContext(),
    )
    assert.equal(first.engine, 'sapi')
    assert.equal(calls.length, 1)
    assert.equal(sapi.calls, 1)

    const second = await generate.execute(
      { text: 'skip the open Edge-TTS circuit' },
      executionContext(),
    )
    assert.equal(calls.length, 1, 'no Edge-TTS subprocess on the second call')
    assert.equal(sapi.calls, 2)
    assert.equal(second.engine, 'sapi')
    assert.equal(second.engineHealth.usedEngineState, 'healthy')
    assert.deepEqual(second.engineHealth.skippedEngines, ['edge-tts'])
  })
})

test('integration: successful synthesis keeps the engine healthy with zero failures', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const { generate, check } = setup(dir, {
      spawnImpl: successfulSpawn(calls),
    })

    const result = await generate.execute(
      { text: 'healthy synthesis' },
      executionContext(),
    )
    assert.equal(result.format, 'mp3')
    assert.equal(calls.length, 1)
    assert.equal(
      result.engineHealth,
      undefined,
      'the plain healthy Edge-TTS result keeps its minimal shape',
    )

    const snapshot = await check.execute({}, executionContext())
    assert.equal(snapshot.engineHealth['edge-tts'].state, 'healthy')
    assert.equal(snapshot.engineHealth['edge-tts'].consecutiveFailures, 0)
  })
})

test('integration: protocol drift falls back and self-check exposes the open circuit', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const { generate, check } = setup(dir, {
      spawnImpl: failingSpawn(calls, 1, 'Invalid response status: 403'),
      platform: 'linux',
      config: { fallbackOrder: ['edge-tts', 'speechSynthesis'] },
    })

    const result = await generate.execute(
      { text: 'protocol drift fallback' },
      executionContext(),
    )
    assert.equal(result.fallback, 'speechSynthesis')
    assert.equal(result.text, 'protocol drift fallback')
    assert.match(String(result.fallbackReason), /EDGE_TTS_FAILED/)
    assert.equal(calls.length, 1)

    const snapshot = await check.execute({}, executionContext())
    assert.equal(snapshot.engineHealth['edge-tts'].state, 'open')
    assert.equal(snapshot.engineHealth['edge-tts'].consecutiveFailures, 1)
    assert.equal(
      snapshot.engineHealth['edge-tts'].lastErrorCode,
      ErrorCode.EdgeTtsFailed,
    )
  })
})

test('integration: self-check returns an offline snapshot with no network or synthesis', async () => {
  await withTempDir(async (dir) => {
    const synthesisCalls: SpawnRecord[] = []
    const { check, versionCalls, network } = setup(dir, {
      spawnImpl: successfulSpawn(synthesisCalls),
    })

    const snapshot = await check.execute({}, executionContext())

    assert.deepEqual(Object.keys(snapshot.engineHealth).sort(), [
      'edge-tts',
      'sapi',
      'speechSynthesis',
    ])
    for (const engine of ['edge-tts', 'sapi', 'speechSynthesis']) {
      assert.equal(snapshot.engineHealth[engine].state, 'healthy')
      assert.equal(snapshot.engineHealth[engine].consecutiveFailures, 0)
    }
    assert.equal(network.calls, 0, 'self-check never invokes the network probe')
    assert.equal(synthesisCalls.length, 0, 'self-check never synthesizes audio')
    assert.equal(versionCalls.length, 1, 'the documented local version check runs once')
    assert.deepEqual(versionCalls[0]?.args, ['--version'])
  })
})

test('integration: failureThreshold 1 opens on the first transient timeout', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const hanging = hangingSpawn(calls)
    const { generate, check } = setup(dir, {
      spawnImpl: hanging.spawn,
      platform: 'linux',
      config: {
        timeoutMs: 5,
        engineHealth: { failureThreshold: 1 },
        fallbackOrder: ['edge-tts', 'speechSynthesis'],
      },
    })

    const result = await generate.execute(
      { text: 'one timeout opens the configured circuit' },
      executionContext(),
    )
    assert.equal(result.fallback, 'speechSynthesis')
    assert.equal(calls.length, 1)

    const snapshot = await check.execute({}, executionContext())
    assert.equal(snapshot.engineHealth['edge-tts'].state, 'open')
    assert.equal(snapshot.engineHealth['edge-tts'].consecutiveFailures, 1)
    assert.equal(
      snapshot.engineHealth['edge-tts'].lastErrorCode,
      ErrorCode.SynthesisTimeout,
    )
  })
})

test('integration: a cache hit bypasses an open circuit without changing health', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    let attempt = 0
    const spawnImpl: SpawnFunction = (command, args, options) => {
      attempt += 1
      return attempt === 1
        ? successfulSpawn(calls)(command, args, options)
        : failingSpawn(calls, 1, 'Invalid response status: 403')(
            command,
            args,
            options,
          )
    }
    const { generate, check } = setup(dir, {
      spawnImpl,
      platform: 'linux',
      config: { fallbackOrder: ['edge-tts', 'speechSynthesis'] },
    })
    const args = { text: 'cached text', voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%' }

    const first = await generate.execute(args, executionContext())
    assert.equal(first.format, 'mp3')
    assert.equal(calls.length, 1)

    const drift = await generate.execute(
      { ...args, text: 'different text opens the circuit' },
      executionContext(),
    )
    assert.equal(drift.fallback, 'speechSynthesis')
    assert.equal(calls.length, 2)
    const before = await check.execute({}, executionContext())
    assert.equal(before.engineHealth['edge-tts'].state, 'open')

    const cached = await generate.execute(args, executionContext())
    assert.equal(cached.filePath, first.filePath)
    assert.equal(calls.length, 2, 'the cache hit does not spawn Edge-TTS')
    assert.equal(cached.engineHealth.usedEngineState, 'open')
    assert.deepEqual(cached.engineHealth.skippedEngines ?? [], [])

    const after = await check.execute({}, executionContext())
    assert.deepEqual(after.engineHealth['edge-tts'], before.engineHealth['edge-tts'])
  })
})
