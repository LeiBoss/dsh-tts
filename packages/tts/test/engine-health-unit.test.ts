import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_ENGINE_HEALTH,
  EngineHealthRegistry,
  type EngineHealthConfig,
} from '../src/engine-health.ts'
import { ErrorCode, TtsError } from '../src/errors.ts'

const START = Date.UTC(2026, 10, 11, 12, 0, 0)

function timeoutError(): TtsError {
  return new TtsError(ErrorCode.SynthesisTimeout, 'Edge-TTS timed out.')
}

function driftError(): TtsError {
  return new TtsError(
    ErrorCode.EdgeTtsFailed,
    'Edge-TTS exited with code 1.\nstderr:\nInvalid response status: 403',
    'Upgrade edge-tts.',
    { protocolDrift: true },
  )
}

function setup(overrides: Partial<EngineHealthConfig> = {}) {
  let clock = START
  const registry = new EngineHealthRegistry(
    { ...DEFAULT_ENGINE_HEALTH, ...overrides },
    () => new Date(clock),
  )
  return {
    registry,
    advance(ms: number): void {
      clock += ms
    },
  }
}

test('unit: one protocol drift failure opens immediately with the drift cooldown', () => {
  const { registry } = setup({ driftCooldownMs: 300_000 })

  registry.recordFailure('edge-tts', driftError())

  const health = registry.healthOf('edge-tts')
  assert.equal(health.state, 'open')
  assert.equal(health.consecutiveFailures, 1)
  assert.equal(health.lastErrorCode, ErrorCode.EdgeTtsFailed)
  assert.equal(health.cooldownMs, 300_000)
  assert.equal(health.openedAt, START)
  assert.equal(registry.shouldSkip('edge-tts'), true)
})

test('unit: two timeouts degrade and the third opens with the transient cooldown', () => {
  const { registry } = setup({
    failureThreshold: 3,
    transientCooldownMs: 60_000,
  })

  registry.recordFailure('edge-tts', timeoutError())
  assert.equal(registry.healthOf('edge-tts').state, 'degraded')
  assert.equal(registry.healthOf('edge-tts').consecutiveFailures, 1)

  registry.recordFailure('edge-tts', timeoutError())
  assert.equal(registry.healthOf('edge-tts').state, 'degraded')
  assert.equal(registry.healthOf('edge-tts').consecutiveFailures, 2)
  assert.equal(registry.shouldSkip('edge-tts'), false)

  registry.recordFailure('edge-tts', timeoutError())
  const opened = registry.healthOf('edge-tts')
  assert.equal(opened.state, 'open')
  assert.equal(opened.consecutiveFailures, 3)
  assert.equal(opened.cooldownMs, 60_000)
  assert.equal(opened.openedAt, START)
  assert.equal(registry.shouldSkip('edge-tts'), true)
})

test('unit: a successful half-open probe restores a healthy zero-failure state', () => {
  const { registry, advance } = setup({
    failureThreshold: 1,
    transientCooldownMs: 60_000,
  })
  registry.recordFailure('edge-tts', timeoutError())
  assert.equal(registry.healthOf('edge-tts').openedAt, START)

  advance(60_001)
  assert.equal(registry.shouldSkip('edge-tts'), false)
  assert.equal(registry.healthOf('edge-tts').probePending, true)

  registry.recordSuccess('edge-tts')
  const healed = registry.healthOf('edge-tts')
  assert.equal(healed.state, 'healthy')
  assert.equal(healed.consecutiveFailures, 0)
  assert.equal(healed.probePending, false)
  assert.equal(healed.openedAt, undefined)
})

test('unit: failed half-open probes double the cooldown up to the configured cap', () => {
  const { registry, advance } = setup({
    failureThreshold: 1,
    transientCooldownMs: 1_000,
    maxCooldownMs: 2_500,
  })
  registry.recordFailure('edge-tts', timeoutError())
  assert.equal(registry.healthOf('edge-tts').cooldownMs, 1_000)

  advance(1_001)
  assert.equal(registry.shouldSkip('edge-tts'), false)
  registry.recordFailure('edge-tts', timeoutError())
  assert.equal(registry.healthOf('edge-tts').state, 'open')
  assert.equal(registry.healthOf('edge-tts').cooldownMs, 2_000)
  assert.equal(registry.healthOf('edge-tts').probePending, false)

  advance(2_001)
  assert.equal(registry.shouldSkip('edge-tts'), false)
  registry.recordFailure('edge-tts', timeoutError())
  assert.equal(registry.healthOf('edge-tts').cooldownMs, 2_500)

  advance(2_501)
  assert.equal(registry.shouldSkip('edge-tts'), false)
  registry.recordFailure('edge-tts', timeoutError())
  assert.equal(registry.healthOf('edge-tts').state, 'open')
  assert.equal(registry.healthOf('edge-tts').cooldownMs, 2_500)
})

test('unit: environment and validation errors do not change engine health', () => {
  const { registry } = setup()

  registry.recordFailure(
    'edge-tts',
    new TtsError(ErrorCode.SpawnEperm, 'Sandbox denied subprocess creation.'),
  )
  registry.recordFailure(
    'edge-tts',
    new TtsError(ErrorCode.EmptyText, 'Text must not be empty.'),
  )

  assert.equal(registry.healthOf('edge-tts').state, 'healthy')
  assert.equal(registry.healthOf('edge-tts').consecutiveFailures, 0)
  assert.equal(registry.healthOf('edge-tts').openedAt, undefined)
  assert.equal(registry.shouldSkip('edge-tts'), false)
})

test('unit: an all-open two-engine plan still permits the last engine', () => {
  const { registry } = setup()
  registry.recordFailure('edge-tts', driftError())
  registry.recordFailure('sapi', driftError())

  const chain = ['edge-tts', 'sapi'] as const
  const plan = registry.plan(chain)
  const available = chain.filter((engine) => !plan.skip.has(engine))

  assert.deepEqual(available, ['sapi'])
  assert.equal(plan.skip.has('sapi'), false)
})
