import { ErrorCode, TtsError } from "./errors.js";
import { isSapiSupported, synthesizeSapi, } from "./sapi-tts.js";
/** Codes that mean "the engine failed", not "the request is invalid". */
const FALLBACK_ELIGIBLE = new Set([
    ErrorCode.EdgeTtsNotFound,
    ErrorCode.SpawnEperm,
    ErrorCode.SpawnFailed,
    ErrorCode.EdgeTtsFailed,
    ErrorCode.SynthesisTimeout,
    ErrorCode.EmptyAudio,
]);
/** Whether a failed Edge-TTS attempt is worth retrying with another engine. */
export function isFallbackEligible(error) {
    return error instanceof TtsError && FALLBACK_ELIGIBLE.has(error.code);
}
/** Reason recorded when the health circuit skips an engine. */
export const SKIPPED_BY_HEALTH = 'skipped: circuit open (cooldown)';
function describe(error) {
    if (error instanceof TtsError)
        return `${error.code}: ${error.detail}`;
    return error instanceof Error ? error.message : String(error);
}
function allFailed(order, attempts, primaryError) {
    const reasons = attempts
        .map((attempt) => `${attempt.engine} (${attempt.reason})`)
        .join('; ');
    return new TtsError(ErrorCode.AllFallbacksFailed, `All configured TTS fallbacks failed. Chain: ${order.join(' -> ')}. Tried: ${reasons}. Engines: ${JSON.stringify(order)}.`, 'Install edge-tts and restore network access, or include `speechSynthesis` in `fallbackOrder`.', { cause: primaryError });
}
/**
 * Run the configured engines after Edge-TTS already failed. `edge-tts` in
 * `fallbackOrder` marks the primary attempt rather than a retry.
 */
export async function runFallback(options, deps = {}) {
    const platform = deps.platform ?? process.platform;
    const sapiImpl = deps.synthesizeSapiImpl ?? synthesizeSapi;
    const attempts = [
        {
            engine: 'edge-tts',
            reason: options.primaryReason ??
                `primary engine failed: ${describe(options.primaryError)}`,
        },
    ];
    // Local array narrowing keeps the literal union readable in the loop.
    const order = options.fallbackOrder;
    for (const engine of order) {
        if (engine === 'edge-tts')
            continue;
        if (options.skip?.has(engine)) {
            attempts.push({ engine, reason: SKIPPED_BY_HEALTH });
            continue;
        }
        if (engine === 'sapi') {
            if (!isSapiSupported(platform)) {
                attempts.push({ engine, reason: `skipped: SAPI is Windows-only (${platform})` });
                continue;
            }
            try {
                const audio = await sapiImpl(options.text, {
                    rate: options.rate,
                    outputDir: options.outputDir,
                    hash: options.hash,
                    timeoutMs: options.timeoutMs,
                    signal: options.signal,
                    spawnImpl: deps.spawnImpl,
                    now: options.now,
                    platform,
                    powershellBinary: deps.powershellBinary,
                    ffmpegBinary: deps.ffmpegBinary,
                });
                const engineState = deps.health?.stateOf(engine) ?? 'healthy';
                deps.health?.recordSuccess(engine);
                attempts.push({ engine, reason: 'succeeded' });
                return { kind: 'audio', audio, engine, engineState, attempts };
            }
            catch (error) {
                if (error instanceof TtsError && error.code === ErrorCode.Aborted)
                    throw error;
                deps.health?.recordFailure(engine, error);
                attempts.push({ engine, reason: describe(error) });
                continue;
            }
        }
        if (engine === 'speechSynthesis') {
            return { kind: 'speechSynthesis', engine: 'speechSynthesis', attempts };
        }
    }
    throw allFailed(order, attempts, options.primaryError);
}
//# sourceMappingURL=fallback.js.map