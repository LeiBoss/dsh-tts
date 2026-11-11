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
import type { TtsEngine } from './config.ts';
/** Circuit state exposed to callers. Half-open is implicit (`probePending`). */
export type EngineHealthState = 'healthy' | 'degraded' | 'open';
/** Tunables, all overridable through the DSH config layer. */
export interface EngineHealthConfig {
    /** When false every engine is always attempted. */
    enabled: boolean;
    /** Consecutive transient failures that open the circuit. */
    failureThreshold: number;
    /** Cooldown after a handshake/403 failure. */
    driftCooldownMs: number;
    /** Cooldown after the transient failure threshold is reached. */
    transientCooldownMs: number;
    /** Upper bound for the doubled cooldown after a failed half-open probe. */
    maxCooldownMs: number;
}
/** Defaults shared by the config schema and `resolveConfig`. */
export declare const DEFAULT_ENGINE_HEALTH: Readonly<EngineHealthConfig>;
/** Mutable per-engine record. */
export interface EngineHealth {
    state: EngineHealthState;
    consecutiveFailures: number;
    /** When the circuit opened; the cooldown is measured from here. */
    openedAt?: number;
    lastErrorCode?: string;
    /** Cooldown currently in force for this engine. */
    cooldownMs: number;
    /** Set when a half-open probe has been let through. */
    probePending: boolean;
}
/**
 * JSON-safe snapshot shape. `lastErrorCode` is a separate branch instead of an
 * optional property so every variant is plain JSON.
 */
export type EngineHealthSnapshot = {
    state: EngineHealthState;
    consecutiveFailures: number;
} | {
    state: EngineHealthState;
    consecutiveFailures: number;
    lastErrorCode: string;
};
/**
 * Whether a failure should move the circuit. Validation, config, cache and
 * abort errors describe the request, not the engine; `SPAWN_EPERM` and a
 * missing binary are environment/install problems that a circuit cannot fix.
 */
export declare function countsAsEngineFailure(error: unknown): boolean;
/** Result of planning one attempt against the current health. */
export interface EngineHealthPlan {
    /** Engines to skip for this attempt. Never contains the forced last engine. */
    skip: ReadonlySet<TtsEngine>;
    /** Clock reading used for the plan, in epoch milliseconds. */
    observedAt: number;
}
/** Reading side used by the fallback chain. */
export interface EngineHealthHooks {
    recordSuccess(engine: TtsEngine): void;
    recordFailure(engine: TtsEngine, error: unknown): void;
    stateOf(engine: TtsEngine): EngineHealthState;
}
/**
 * One mutable registry per tool instance. `now` is injectable so tests can
 * advance the cooldown without sleeping.
 */
export declare class EngineHealthRegistry implements EngineHealthHooks {
    #private;
    constructor(config?: EngineHealthConfig, now?: () => Date);
    /** Current state without side effects; unknown engines are `healthy`. */
    stateOf(engine: TtsEngine): EngineHealthState;
    /** Full record, exposed for diagnostics and unit tests. */
    healthOf(engine: TtsEngine): Readonly<EngineHealth>;
    /**
     * Whether `engine` must be skipped for this attempt. When an open circuit's
     * cooldown has elapsed the call is let through and marked as a probe.
     */
    shouldSkip(engine: TtsEngine): boolean;
    /**
     * Plan a whole chain at once. If every engine is open the last one is forced
     * through: a fully open chain must still attempt something rather than fail
     * silently with an empty result.
     */
    plan(chain: readonly TtsEngine[]): EngineHealthPlan;
    /** A successful attempt closes the circuit and clears the failure streak. */
    recordSuccess(engine: TtsEngine): void;
    /**
     * Record a failed attempt. Drift opens immediately with the long cooldown;
     * transient failures accumulate until `failureThreshold`. A failed half-open
     * probe re-opens with a doubled cooldown, capped at `maxCooldownMs`.
     */
    recordFailure(engine: TtsEngine, error: unknown): void;
    /** Snapshot for `tts_self_check`; never performs I/O. */
    snapshot(): Record<string, EngineHealthSnapshot>;
}
//# sourceMappingURL=engine-health.d.ts.map