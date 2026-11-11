import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'
import {
  DEFAULT_ENGINE_HEALTH,
  EngineHealthRegistry,
} from '../src/engine-health.ts'
import { synthesize, type SpawnFunction, type SynthesizedAudio } from '../src/edge-tts.ts'
import { ErrorCode, TtsError, looksLikeProtocolDrift } from '../src/errors.ts'
import { createTtsTools } from '../src/index.ts'
import type { SapiOptions } from '../src/sapi-tts.ts'
import {
  FakeChild,
  executionContext,
  failingSpawn,
  hangingSpawn,
  throwingSpawn,
  versionSpawn,
  type SpawnRecord,
} from './helpers.ts'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-health-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const START = Date.UTC(2026, 10, 11, 12, 0, 0)

/** Make `edge-tts --version` succeed without polluting the call log. */
function versionAware(
  base: SpawnFunction,
  versionCalls: string[],
): SpawnFunction {
  return (command, args, options) => {
    if (args.includes('--version')) {
      versionCalls.push(command)
      return versionSpawn('7.3.1')(command, args, options)
    }
    return base(command, args, options)
  }
}

interface SetupOptions {
  spawnImpl: SpawnFunction
  platform?: NodeJS.Platform
  sapiSynthesize?: (
    text: string,
    options: SapiOptions,
  ) => Promise<SynthesizedAudio>
  config?: Record<string, unknown>
  now?: () => Date
}

function setup(dir: string, options: SetupOptions) {
  const versionCalls: string[] = []
  const config = resolveConfig({ outputDir: dir, ...options.config }, {})
  const tools = createTtsTools(config, {
    spawnImpl: versionAware(options.spawnImpl, versionCalls),
    platform: options.platform,
    sapiSynthesize: options.sapiSynthesize,
    chunkDelayMs: 0,
    now: options.now,
  })
  const [generate, check] = tools
  assert.ok(generate)
  assert.ok(check)
  return { generate, check, versionCalls }
}

/** SAPI stub that writes a real file so metadata/format checks succeed. */
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

/** Edge-TTS double: first call fails with a drift signature, later ones succeed. */
function driftThenSuccess(): SpawnFunction {
  let call = 0
  return (_command, args) => {
    call += 1
    const child = new FakeChild()
    const media = args.find((arg) => arg.startsWith('--write-media='))
    queueMicrotask(() => {
      if (call === 1) {
        child.stderr.write('Invalid response status: 403 Forbidden')
        child.emit('close', 1, null)
        return
      }
      if (media !== undefined) {
        writeFileSync(media.slice('--write-media='.length), Buffer.from('ID3edge'))
      }
      child.emit('close', 0, null)
    })
    return child
  }
}

function driftError(): TtsError {
  return new TtsError(
    ErrorCode.EdgeTtsFailed,
    'Edge-TTS exited with code 1.\nstderr:\nWSServerHandshakeError: 403',
    'upgrade edge-tts',
    { protocolDrift: true },
  )
}

test('protocol drift patterns are recognised case-insensitively', () => {
  for (const text of [
    'HTTP 403 Forbidden',
    'Invalid response status',
    'wsserverhandshakeerror: ...',
    'Sec-MS-GEC token rejected',
    'handshake failed',
  ]) {
    assert.equal(looksLikeProtocolDrift(text), true, text)
  }
  assert.equal(looksLikeProtocolDrift('connection timed out'), false)
})

test('drift errors suggest upgrading edge-tts while timeouts suggest network/proxy', async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      synthesize('hello', {
        voice: 'zh-CN-XiaoxiaoNeural',
        rate: '+0%',
        binary: 'edge-tts',
        outputDir: dir,
        hash: 'drift',
        timeoutMs: 1_000,
        spawnImpl: failingSpawn([], 1, 'Invalid response status: 403'),
      }),
      (error: unknown) =>
        error instanceof TtsError &&
        error.code === ErrorCode.EdgeTtsFailed &&
        error.protocolDrift &&
        /升级 edge-tts/.test(error.suggestion ?? ''),
    )

    const hanging = hangingSpawn([])
    await assert.rejects(
      synthesize('hello', {
        voice: 'zh-CN-XiaoxiaoNeural',
        rate: '+0%',
        binary: 'edge-tts',
        outputDir: dir,
        hash: 'timeout',
        timeoutMs: 20,
        spawnImpl: hanging.spawn,
      }),
      (error: unknown) =>
        error instanceof TtsError &&
        error.code === ErrorCode.SynthesisTimeout &&
        /HTTPS_PROXY/.test(error.suggestion ?? '') &&
        !/升级 edge-tts/.test(error.suggestion ?? ''),
    )
  })
})

test('protocol drift opens the circuit and the next call skips Edge-TTS', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const sapi = { calls: 0 }
    const { generate, check } = setup(dir, {
      spawnImpl: failingSpawn(calls, 1, 'Invalid response status: 403 Forbidden'),
      platform: 'win32',
      sapiSynthesize: sapiStub(sapi),
    })

    const first = await generate.execute({ text: 'drift one' }, executionContext())
    assert.equal(calls.length, 1)
    assert.equal(first.engine, 'sapi')
    assert.equal(sapi.calls, 1)

    const opened = await check.execute({}, executionContext())
    assert.equal(opened.engineHealth['edge-tts'].state, 'open')
    assert.equal(
      opened.engineHealth['edge-tts'].lastErrorCode,
      ErrorCode.EdgeTtsFailed,
    )
    assert.equal(opened.engineHealth['sapi'].state, 'healthy')

    const second = await generate.execute({ text: 'drift two' }, executionContext())
    assert.equal(calls.length, 1, 'Edge-TTS must be skipped during the cooldown')
    assert.equal(sapi.calls, 2)
    assert.deepEqual(second.engineHealth.skippedEngines, ['edge-tts'])
    assert.equal(second.engineHealth.usedEngine, 'sapi')
  })
})

test('three transient failures open the circuit and the fourth call is skipped', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const hanging = hangingSpawn(calls)
    const { generate, check } = setup(dir, {
      spawnImpl: hanging.spawn,
      platform: 'linux',
      config: { timeoutMs: 20, fallbackOrder: ['edge-tts', 'speechSynthesis'] },
    })

    for (const text of ['timeout one', 'timeout two', 'timeout three']) {
      const result = await generate.execute({ text }, executionContext())
      assert.equal(result.fallback, 'speechSynthesis')
    }
    assert.equal(calls.length, 3, 'one attempt per transient failure')

    const opened = await check.execute({}, executionContext())
    assert.equal(opened.engineHealth['edge-tts'].state, 'open')
    assert.equal(opened.engineHealth['edge-tts'].consecutiveFailures, 3)

    const fourth = await generate.execute({ text: 'timeout four' }, executionContext())
    assert.equal(calls.length, 3, 'the open circuit must skip Edge-TTS')
    assert.equal(fourth.fallback, 'speechSynthesis')
    assert.match(String(fourth.fallbackReason), /circuit open/)
  })
})

test('a half-open probe recovers the engine, and a failed probe doubles the cooldown', async () => {
  await withTempDir(async (dir) => {
    let clock = START
    const sapi = { calls: 0 }
    const { generate, check } = setup(dir, {
      spawnImpl: driftThenSuccess(),
      platform: 'win32',
      sapiSynthesize: sapiStub(sapi),
      now: () => new Date(clock),
    })

    const first = await generate.execute({ text: 'probe start' }, executionContext())
    assert.equal(first.engine, 'sapi')
    assert.equal(sapi.calls, 1)

    // Still inside the drift cooldown (5 minutes): Edge-TTS stays skipped.
    const cooling = await generate.execute({ text: 'probe cooling' }, executionContext())
    assert.equal(cooling.engineHealth.skippedEngines.includes('edge-tts'), true)
    assert.equal(sapi.calls, 2)

    clock += DEFAULT_ENGINE_HEALTH.driftCooldownMs + 1
    const probed = await generate.execute({ text: 'probe after cooldown' }, executionContext())
    assert.equal('engine' in probed, false, 'Edge-TTS must be retried by the probe')

    const healed = await check.execute({}, executionContext())
    assert.equal(healed.engineHealth['edge-tts'].state, 'healthy')
    assert.equal(healed.engineHealth['edge-tts'].consecutiveFailures, 0)
  })

  // A failed probe re-opens with a doubled cooldown, capped at maxCooldownMs.
  let clock = START
  const registry = new EngineHealthRegistry(
    {
      ...DEFAULT_ENGINE_HEALTH,
      driftCooldownMs: 1_000,
      maxCooldownMs: 3_000,
    },
    () => new Date(clock),
  )
  registry.recordFailure('edge-tts', driftError())
  assert.equal(registry.healthOf('edge-tts').cooldownMs, 1_000)
  assert.equal(registry.shouldSkip('edge-tts'), true)

  clock += 1_001
  assert.equal(registry.shouldSkip('edge-tts'), false, 'half-open lets one probe through')
  registry.recordFailure('edge-tts', driftError())
  const reopened = registry.healthOf('edge-tts')
  assert.equal(reopened.state, 'open')
  assert.equal(reopened.cooldownMs, 2_000)

  clock += 2_001
  assert.equal(registry.shouldSkip('edge-tts'), false)
  registry.recordFailure('edge-tts', driftError())
  assert.equal(registry.healthOf('edge-tts').cooldownMs, 3_000, 'capped')
})

test('drift cooldown is longer than the transient cooldown', () => {
  const clock = START
  const drift = new EngineHealthRegistry(
    { ...DEFAULT_ENGINE_HEALTH, driftCooldownMs: 300_000, transientCooldownMs: 60_000 },
    () => new Date(clock),
  )
  drift.recordFailure('edge-tts', driftError())

  const transient = new EngineHealthRegistry(
    { ...DEFAULT_ENGINE_HEALTH, driftCooldownMs: 300_000, transientCooldownMs: 60_000 },
    () => new Date(clock),
  )
  for (let i = 0; i < 3; i += 1) {
    transient.recordFailure(
      'edge-tts',
      new TtsError(ErrorCode.SynthesisTimeout, 'timed out'),
    )
  }

  assert.equal(drift.healthOf('edge-tts').state, 'open')
  assert.equal(transient.healthOf('edge-tts').state, 'open')
  assert.ok(
    drift.healthOf('edge-tts').cooldownMs > transient.healthOf('edge-tts').cooldownMs,
  )
})

test('an all-open chain still attempts its last engine', async () => {
  const clock = START
  const registry = new EngineHealthRegistry(
    { ...DEFAULT_ENGINE_HEALTH, failureThreshold: 1 },
    () => new Date(clock),
  )
  for (const engine of ['edge-tts', 'sapi', 'speechSynthesis'] as const) {
    registry.recordFailure(engine, driftError())
  }

  const plan = registry.plan(['edge-tts', 'sapi', 'speechSynthesis'])
  assert.equal(plan.skip.size, 2)
  assert.equal(plan.skip.has('speechSynthesis'), false, 'the last engine is forced')

  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const sapi = { calls: 0 }
    const { generate } = setup(dir, {
      spawnImpl: failingSpawn(calls, 1, 'Invalid response status: 403'),
      platform: 'win32',
      config: { fallbackOrder: ['edge-tts', 'sapi'] },
      sapiSynthesize: async () => {
        sapi.calls += 1
        throw new TtsError(ErrorCode.SynthesisTimeout, 'sapi timed out')
      },
    })

    for (const text of ['all open one', 'all open two', 'all open three']) {
      await assert.rejects(generate.execute({ text }, executionContext()))
    }
    assert.equal(sapi.calls, 3)

    // Both engines are open now; the chain still tries its last engine (SAPI)
    // instead of returning an empty "everything is open" result.
    await assert.rejects(
      generate.execute({ text: 'all open four' }, executionContext()),
      (error: unknown) =>
        error instanceof TtsError && error.code === ErrorCode.AllFallbacksFailed,
    )
    assert.equal(calls.length, 1, 'Edge-TTS stays skipped after the first failure')
    assert.equal(sapi.calls, 4, 'SAPI is forced through and fails')
  })
})

test('validation failures do not change engine health', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const { generate, check } = setup(dir, { spawnImpl: failingSpawn(calls, 1, '403') })

    await assert.rejects(
      generate.execute({ text: '   ' }, executionContext()),
      (error: unknown) => error instanceof TtsError && error.code === ErrorCode.EmptyText,
    )
    await assert.rejects(
      generate.execute({ text: 'hi', voice: 'not-a-voice' }, executionContext()),
      (error: unknown) =>
        error instanceof TtsError && error.code === ErrorCode.InvalidVoice,
    )
    assert.equal(calls.length, 0)

    const snapshot = await check.execute({}, executionContext())
    for (const engine of ['edge-tts', 'sapi', 'speechSynthesis']) {
      assert.equal(snapshot.engineHealth[engine].state, 'healthy', engine)
      assert.equal(snapshot.engineHealth[engine].consecutiveFailures, 0, engine)
    }
  })
})

test('SPAWN_EPERM is reported but never opens the circuit', async () => {
  await withTempDir(async (dir) => {
    const sapi = { calls: 0 }
    const { generate, check } = setup(dir, {
      spawnImpl: throwingSpawn('EPERM'),
      platform: 'win32',
      sapiSynthesize: sapiStub(sapi),
    })

    for (const text of ['eperm one', 'eperm two', 'eperm three']) {
      const result = await generate.execute({ text }, executionContext())
      assert.equal(result.engine, 'sapi')
    }
    assert.equal(sapi.calls, 3)

    const snapshot = await check.execute({}, executionContext())
    assert.equal(snapshot.engineHealth['edge-tts'].state, 'healthy')
    assert.equal(snapshot.engineHealth['edge-tts'].consecutiveFailures, 0)
  })
})

test('tts_self_check returns the in-memory snapshot without extra network calls', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnRecord[] = []
    const { generate, check, versionCalls } = setup(dir, {
      spawnImpl: failingSpawn(calls, 1, 'Invalid response status: 403'),
      platform: 'linux',
      config: { fallbackOrder: ['edge-tts', 'speechSynthesis'] },
    })

    await generate.execute({ text: 'self check drift' }, executionContext())
    const spawnedBefore = calls.length

    const snapshot = await check.execute({}, executionContext())
    assert.equal(calls.length, spawnedBefore, 'self_check must not synthesize')
    assert.equal(versionCalls.length, 1, 'only the local --version probe runs')
    assert.deepEqual(Object.keys(snapshot.engineHealth).sort(), [
      'edge-tts',
      'sapi',
      'speechSynthesis',
    ])
    assert.equal(snapshot.engineHealth['edge-tts'].state, 'open')
  })
})
