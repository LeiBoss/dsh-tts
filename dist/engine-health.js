import { ErrorCode, isProtocolDrift, TtsError } from "./errors.js";
/** Defaults shared by the config schema and `resolveConfig`. */
export const DEFAULT_ENGINE_HEALTH = Object.freeze({
    enabled: true,
    failureThreshold: 3,
    driftCooldownMs: 300_000,
    transientCooldownMs: 60_000,
    maxCooldownMs: 600_000,
});
/** Engines that participate in health tracking, in chain order. */
const TRACKED_ENGINES = ['edge-tts', 'sapi', 'speechSynthesis'];
/** Failure codes that say "the engine failed", as opposed to "the caller erred". */
const COUNTED_FAILURES = new Set([
    ErrorCode.EdgeTtsFailed,
    ErrorCode.SynthesisTimeout,
    ErrorCode.EmptyAudio,
    ErrorCode.SpawnFailed,
]);
/**
 * Whether a failure should move the circuit. Validation, config, cache and
 * abort errors describe the request, not the engine; `SPAWN_EPERM` and a
 * missing binary are environment/install problems that a circuit cannot fix.
 */
export function countsAsEngineFailure(error) {
    if (error instanceof TtsError)
        return COUNTED_FAILURES.has(error.code);
    // An engine that threw something unclassified still failed to produce audio.
    return error instanceof Error;
}
function freshRecord(transientCooldownMs) {
    return {
        state: 'healthy',
        consecutiveFailures: 0,
        cooldownMs: transientCooldownMs,
        probePending: false,
    };
}
/**
 * One mutable registry per tool instance. `now` is injectable so tests can
 * advance the cooldown without sleeping.
 */
export class EngineHealthRegistry {
    #config;
    #now;
    #engines = new Map();
    constructor(config = { ...DEFAULT_ENGINE_HEALTH }, now = () => new Date()) {
        this.#config = config;
        this.#now = now;
    }
    /** Current state without side effects; unknown engines are `healthy`. */
    stateOf(engine) {
        return this.#record(engine).state;
    }
    /** Full record, exposed for diagnostics and unit tests. */
    healthOf(engine) {
        return this.#record(engine);
    }
    /**
     * Whether `engine` must be skipped for this attempt. When an open circuit's
     * cooldown has elapsed the call is let through and marked as a probe.
     */
    shouldSkip(engine) {
        if (!this.#config.enabled)
            return false;
        const record = this.#record(engine);
        if (record.state !== 'open')
            return false;
        const openedAt = record.openedAt ?? 0;
        if (this.#nowMs() < openedAt + record.cooldownMs)
            return true;
        record.probePending = true;
        return false;
    }
    /**
     * Plan a whole chain at once. If every engine is open the last one is forced
     * through: a fully open chain must still attempt something rather than fail
     * silently with an empty result.
     */
    plan(chain) {
        const observedAt = this.#nowMs();
        const skip = new Set();
        if (!this.#config.enabled)
            return { skip, observedAt };
        const unique = [...new Set(chain)];
        for (const engine of unique) {
            if (this.shouldSkip(engine))
                skip.add(engine);
        }
        if (unique.length > 0 && skip.size === unique.length) {
            const last = unique[unique.length - 1];
            if (last !== undefined)
                skip.delete(last);
        }
        return { skip, observedAt };
    }
    /** A successful attempt closes the circuit and clears the failure streak. */
    recordSuccess(engine) {
        const record = this.#record(engine);
        record.state = 'healthy';
        record.consecutiveFailures = 0;
        record.probePending = false;
        delete record.openedAt;
        record.cooldownMs = this.#config.transientCooldownMs;
    }
    /**
     * Record a failed attempt. Drift opens immediately with the long cooldown;
     * transient failures accumulate until `failureThreshold`. A failed half-open
     * probe re-opens with a doubled cooldown, capped at `maxCooldownMs`.
     */
    recordFailure(engine, error) {
        if (!this.#config.enabled || !countsAsEngineFailure(error))
            return;
        const record = this.#record(engine);
        const now = this.#nowMs();
        record.consecutiveFailures += 1;
        if (error instanceof TtsError)
            record.lastErrorCode = error.code;
        if (record.probePending) {
            record.probePending = false;
            record.state = 'open';
            record.openedAt = now;
            record.cooldownMs = Math.min(record.cooldownMs * 2, this.#config.maxCooldownMs);
            return;
        }
        if (isProtocolDrift(error)) {
            record.state = 'open';
            record.openedAt = now;
            record.cooldownMs = this.#config.driftCooldownMs;
            return;
        }
        if (record.consecutiveFailures >= this.#config.failureThreshold) {
            record.state = 'open';
            record.openedAt = now;
            record.cooldownMs = this.#config.transientCooldownMs;
            return;
        }
        record.state = 'degraded';
    }
    /** Snapshot for `tts_self_check`; never performs I/O. */
    snapshot() {
        const out = {};
        for (const engine of TRACKED_ENGINES) {
            const record = this.#record(engine);
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
                    };
        }
        return out;
    }
    #nowMs() {
        return this.#now().getTime();
    }
    #record(engine) {
        let record = this.#engines.get(engine);
        if (record === undefined) {
            record = freshRecord(this.#config.transientCooldownMs);
            this.#engines.set(engine, record);
        }
        return record;
    }
}
//# sourceMappingURL=engine-health.js.map