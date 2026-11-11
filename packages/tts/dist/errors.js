import { HarnessError } from '@deepseek-ai/dsh-llm';
/**
 * Stable, machine-readable failure codes. Callers route on these codes instead
 * of parsing human-facing messages.
 */
export const ErrorCode = {
    EmptyText: 'EMPTY_TEXT',
    InvalidVoice: 'INVALID_VOICE',
    InvalidRate: 'INVALID_RATE',
    InvalidPitch: 'INVALID_PITCH',
    InvalidVolume: 'INVALID_VOLUME',
    InvalidConfig: 'INVALID_CONFIG',
    DshHomeNotSet: 'DSH_HOME_NOT_SET',
    OutputDirNotWritable: 'OUTPUT_DIR_NOT_WRITABLE',
    EdgeTtsNotFound: 'EDGE_TTS_NOT_FOUND',
    SpawnEperm: 'SPAWN_EPERM',
    SpawnFailed: 'SPAWN_FAILED',
    EdgeTtsFailed: 'EDGE_TTS_FAILED',
    SynthesisTimeout: 'SYNTHESIS_TIMEOUT',
    EmptyAudio: 'EMPTY_AUDIO',
    Aborted: 'ABORTED',
    TtsBusy: 'TTS_BUSY',
    AllFallbacksFailed: 'ALL_FALLBACKS_FAILED',
    SpeechSynthesisRequired: 'SPEECH_SYNTHESIS_REQUIRED',
};
/**
 * Substrings that mean the upstream Edge-TTS protocol changed under us: a
 * rejected WebSocket handshake, a rotated `Sec-MS-GEC` token generation, or a
 * generic HTTP 403. These are not retryable jitter — the installed edge-tts
 * version and the service disagree about the handshake.
 */
const PROTOCOL_DRIFT_PATTERNS = [
    /403/,
    /invalid response status/i,
    /wsserverhandshakeerror/i,
    /sec-ms-gec/i,
    /handshake/i,
];
/** Whether captured subprocess output looks like protocol drift, not jitter. */
export function looksLikeProtocolDrift(text) {
    return PROTOCOL_DRIFT_PATTERNS.some((pattern) => pattern.test(text));
}
/**
 * Structured plugin error: a routable `code`, a human-readable message, and an
 * actionable suggestion. Extends the harness error base so the tool registry
 * can retain the code in its failure metadata.
 */
export class TtsError extends HarnessError {
    /** Pre-suggestion message, kept verbatim for structured consumers. */
    detail;
    /** Action the caller (or the user) can take to resolve the failure. */
    suggestion;
    /** Set when the failure is a handshake/protocol rejection, not a timeout. */
    protocolDrift;
    constructor(code, message, suggestion, options) {
        super(suggestion ? `${message}\nSuggestion: ${suggestion}` : message, code, options);
        this.name = 'TtsError';
        this.detail = message;
        this.suggestion = suggestion;
        this.protocolDrift = options?.protocolDrift === true;
    }
}
/**
 * Classify a failure as protocol drift. The explicit flag wins; the text
 * fallback keeps errors re-wrapped by callers (for example per-chunk failures)
 * classifiable without extra plumbing.
 */
export function isProtocolDrift(error) {
    if (!(error instanceof TtsError))
        return false;
    return error.protocolDrift || looksLikeProtocolDrift(error.detail);
}
/** Read a Node `SystemError` code without assuming the thrown value's shape. */
export function errnoCode(error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = error.code;
        if (typeof code === 'string')
            return code;
    }
    return undefined;
}
/**
 * Translate a failed `spawn()` attempt into a structured error. `EPERM` is
 * deliberately distinct: it means the sandbox refused process creation, not
 * that the output directory is unwritable.
 */
export function spawnFailure(error) {
    const code = errnoCode(error);
    const detail = error instanceof Error ? error.message : String(error);
    if (code === 'ENOENT') {
        return new TtsError(ErrorCode.EdgeTtsNotFound, `Cannot start Edge-TTS: ${detail}`, 'Install it with `pip install edge-tts`, or point `edgeTtsBinary` at the executable.', { cause: error });
    }
    if (code === 'EPERM') {
        return new TtsError(ErrorCode.SpawnEperm, `The DSH sandbox denied process creation for Edge-TTS (spawn EPERM): ${detail}`, 'Raise the DSH sandbox process/file policy and retry. This is a sandbox policy denial, not a missing or unwritable output directory.', { cause: error });
    }
    return new TtsError(ErrorCode.SpawnFailed, `Failed to spawn Edge-TTS (${code ?? 'unknown error'}): ${detail}`, 'Check that `edgeTtsBinary` names an existing, executable Edge-TTS CLI.', { cause: error });
}
//# sourceMappingURL=errors.js.map