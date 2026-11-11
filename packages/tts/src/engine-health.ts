/**
 * In-memory engine health state machine for the fallback chain.
 *
 * It never decides which engine is *first*, and it never changes the fallback
 * trigger — it only answers "should this engine be skipped right now?". A
 * skipped engine is one that recently failed hard enough to open its circuit;
 * once the cooldown elapses a single half-open probe is allowed through, and a
 * success closes the circuit again.
 *
 * State is deliberately process-local. Persisting "unhealthy" across restarts
 * could keep blocking a recovered network, so a plugin restart resets every
 * engine to `healthy`.
 */
import type { TtsEngine } from './config.ts'
import { ErrorCode, isProtocolDrift, TtsError } from './errors.ts'

/** Circuit state exposed to callers. Half-open is implicit (`probePending`). */
export type EngineHealthState = 'healthy' | 'degraded' | 'open'

/** Tunables, all overridable through the DSH config layer. */
export interface EngineHealthConfig {
  /** When false every engine is always attempted. */
  enabled: boolean
  /** Consecutive transient failures that open the circuit. */
  failureThreshold: number
  /** Cooldown after a handshake/403 failure. */
  driftCooldownMs: number
  /** Cooldown after the transient failure threshold is reached. */
  transientCooldownMs: number
  /** Upper bound for the doubled cooldown after a failed half-open probe. */
  maxCooldownMs: number
}

/** Defaults shared by the config schema and `resolveConfig`. */
export const DEFAULT_ENGINE_HEALTH: Readonly<EngineHealthConfig> = Object.freeze({
  enabled: true,
  failureThreshold: 3,
  driftCooldownMs: 300_000,
  transientCooldownMs: 60_000,
  maxCooldownMs: 600_000,
})

/** Mutable per-engine record. */
export interface EngineHealth {
  state: EngineHealthState
  consecutiveFailures: number
  /** When the circuit opened; the cooldown is measured from here. */
  openedAt?: number
  lastErrorCode?: string
  /** Cooldown currently in force for this engine. */
  cooldownMs: number
  /** Set when a half-open probe has been let through. */
  probePending: boolean
}

/**
 * JSON-safe snapshot shape. `lastErrorCode` is a separate branch instead of an
 * optional property so every variant is plain JSON.
 */
export type EngineHealthSnapshot =
  | { state: EngineHealthState; consecutiveFailures: number }
  | {
      state: EngineHealthState
      consecutiveFailures: number
      lastErrorCode: string
    }

/** Engines that participate in health tracking, in chain order. */
const TRACKED_ENGINES: readonly TtsEngine[] = ['edge-tts', 'sapi', 'speechSynthesis']

/** Failure codes that say "the engine failed", as opposed to "the caller erred". */
const COUNTED_FAILURES: ReadonlySet<string> = new Set([
  ErrorCode.EdgeTtsFailed,
  ErrorCode.SynthesisTimeout,
  ErrorCode.EmptyAudio,
  ErrorCode.SpawnFailed,
])

/**
 * Whether a failure should move the circuit. Validation, config, cache and
 * abort errors describe the request, not the engine; `SPAWN_EPERM` and a
 * missing binary are environment/install problems that a circuit cannot fix.
 */
export function countsAsEngineFailure(error: unknown): boolean {
  if (error instanceof TtsError) return COUNTED_FAILURES.has(error.code)
  // An engine that threw something unclassified still failed to produce audio.
  return error instanceof Error
}

/** Result of planning one attempt against the current health. */
export interface EngineHealthPlan {
  /** Engines to skip for this attempt. Never contains the forced last engine. */
  skip: ReadonlySet<TtsEngine>
  /** Clock reading used for the plan, in epoch milliseconds. */
  observedAt: number
}

/** Reading side used by the fallback chain. */
export interface EngineHealthHooks {
  recordSuccess(engine: TtsEngine): void
  recordFailure(engine: TtsEngine, error: unknown): void
  stateOf(engine: TtsEngine): EngineHealthState
}

function freshRecord(transientCooldownMs: number): EngineHealth {
  return {
    state: 'healthy',
    consecutiveFailures: 0,
    cooldownMs: transientCooldownMs,
    probePending: false,
  }
}

/**
 * One mutable registry per tool instance. `now` is injectable so tests can
 * advance the cooldown without sleeping.
 */
export class EngineHealthRegistry implements EngineHealthHooks {
  readonly #config: EngineHealthConfig
  readonly #now: () => Date
  readonly #engines = new Map<TtsEngine, EngineHealth>()

  constructor(
    config: EngineHealthConfig = { ...DEFAULT_ENGINE_HEALTH },
    now: () => Date = () => new Date(),
  ) {
    this.#config = config
    this.#now = now
  }

  /** Current state without side effects; unknown engines are `healthy`. */
  stateOf(engine: TtsEngine): EngineHealthState {
    return this.#record(engine).state
  }

  /** Full record, exposed for diagnostics and unit tests. */
  healthOf(engine: TtsEngine): Readonly<EngineHealth> {
    return this.#record(engine)
  }

  /**
   * Whether `engine` must be skipped for this attempt. When an open circuit's
   * cooldown has elapsed the call is let through and marked as a probe.
   */
  shouldSkip(engine: TtsEngine): boolean {
    if (!this.#config.enabled) return false
    const record = this.#record(engine)
    if (record.state !== 'open') return false

    const openedAt = record.openedAt ?? 0
    if (this.#nowMs() < openedAt + record.cooldownMs) return true

    record.probePending = true
    return false
  }

  /**
   * Plan a whole chain at once. If every engine is open the last one is forced
   * through: a fully open chain must still attempt something rather than fail
   * silently with an empty result.
   */
  plan(chain: readonly TtsEngine[]): EngineHealthPlan {
    const observedAt = this.#nowMs()
    const skip = new Set<TtsEngine>()
    if (!this.#config.enabled) return { skip, observedAt }

    const unique = [...new Set(chain)]
    for (const engine of unique) {
      if (this.shouldSkip(engine)) skip.add(engine)
    }

    if (unique.length > 0 && skip.size === unique.length) {
      const last = unique[unique.length - 1]
      if (last !== undefined) skip.delete(last)
    }

    return { skip, observedAt }
  }

  /** A successful attempt closes the circuit and clears the failure streak. */
  recordSuccess(engine: TtsEngine): void {
    const record = this.#record(engine)
    record.state = 'healthy'
    record.consecutiveFailures = 0
    record.probePending = false
    delete record.openedAt
    record.cooldownMs = this.#config.transientCooldownMs
  }

  /**
   * Record a failed attempt. Drift opens immediately with the long cooldown;
   * transient failures accumulate until `failureThreshold`. A failed half-open
   * probe re-opens with a doubled cooldown, capped at `maxCooldownMs`.
   */
  recordFailure(engine: TtsEngine, error: unknown): void {
    if (!this.#config.enabled || !countsAsEngineFailure(error)) return

    const record = this.#record(engine)
    const now = this.#nowMs()
    record.consecutiveFailures += 1
    if (error instanceof TtsError) record.lastErrorCode = error.code

    if (record.probePending) {
      record.probePending = false
      record.state = 'open'
      record.openedAt = now
      record.cooldownMs = Math.min(
        record.cooldownMs * 2,
        this.#config.maxCooldownMs,
      )
      return
    }

    if (isProtocolDrift(error)) {
      record.state = 'open'
      record.openedAt = now
      record.cooldownMs = this.#config.driftCooldownMs
      return
    }

    if (record.consecutiveFailures >= this.#config.failureThreshold) {
      record.state = 'open'
      record.openedAt = now
      record.cooldownMs = this.#config.transientCooldownMs
      return
    }

    record.state = 'degraded'
  }

  /** Snapshot for `tts_self_check`; never performs I/O. */
  snapshot(): Record<string, EngineHealthSnapshot> {
    const out: Record<string, EngineHealthSnapshot> = {}
    for (const engine of TRACKED_ENGINES) {
      const record = this.#record(engine)
      out[engine] =
        record.lastErrorCode === undefined
          ? {
              state: record.state,
              consecutiveFailures: record.consecutiveFailures,
            }
          : {
              state: record.state,
              consecutiveFailures: record.consecutiveFailures,
              lastErrorCode: record.lastErrorCode,
            }
    }
    return out
  }

  #nowMs(): number {
    return this.#now().getTime()
  }

  #record(engine: TtsEngine): EngineHealth {
    let record = this.#engines.get(engine)
    if (record === undefined) {
      record = freshRecord(this.#config.transientCooldownMs)
      this.#engines.set(engine, record)
    }
    return record
  }
}
