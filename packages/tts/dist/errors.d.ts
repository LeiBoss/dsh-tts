import { HarnessError } from '@deepseek-ai/dsh-llm';
/**
 * Stable, machine-readable failure codes. Callers route on these codes instead
 * of parsing human-facing messages.
 */
export declare const ErrorCode: {
    readonly EmptyText: "EMPTY_TEXT";
    readonly InvalidVoice: "INVALID_VOICE";
    readonly InvalidRate: "INVALID_RATE";
    readonly InvalidPitch: "INVALID_PITCH";
    readonly InvalidVolume: "INVALID_VOLUME";
    readonly InvalidConfig: "INVALID_CONFIG";
    readonly DshHomeNotSet: "DSH_HOME_NOT_SET";
    readonly OutputDirNotWritable: "OUTPUT_DIR_NOT_WRITABLE";
    readonly EdgeTtsNotFound: "EDGE_TTS_NOT_FOUND";
    readonly SpawnEperm: "SPAWN_EPERM";
    readonly SpawnFailed: "SPAWN_FAILED";
    readonly EdgeTtsFailed: "EDGE_TTS_FAILED";
    readonly SynthesisTimeout: "SYNTHESIS_TIMEOUT";
    readonly EmptyAudio: "EMPTY_AUDIO";
    readonly Aborted: "ABORTED";
    readonly TtsBusy: "TTS_BUSY";
    readonly AllFallbacksFailed: "ALL_FALLBACKS_FAILED";
    readonly SpeechSynthesisRequired: "SPEECH_SYNTHESIS_REQUIRED";
};
export type TtsErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
/** Whether captured subprocess output looks like protocol drift, not jitter. */
export declare function looksLikeProtocolDrift(text: string): boolean;
/** Options accepted by {@link TtsError}. */
export interface TtsErrorOptions extends ErrorOptions {
    /** Marks a failure caused by upstream protocol drift rather than jitter. */
    protocolDrift?: boolean;
}
/**
 * Structured plugin error: a routable `code`, a human-readable message, and an
 * actionable suggestion. Extends the harness error base so the tool registry
 * can retain the code in its failure metadata.
 */
export declare class TtsError extends HarnessError {
    /** Pre-suggestion message, kept verbatim for structured consumers. */
    readonly detail: string;
    /** Action the caller (or the user) can take to resolve the failure. */
    readonly suggestion?: string;
    /** Set when the failure is a handshake/protocol rejection, not a timeout. */
    readonly protocolDrift: boolean;
    constructor(code: TtsErrorCode, message: string, suggestion?: string, options?: TtsErrorOptions);
}
/**
 * Classify a failure as protocol drift. The explicit flag wins; the text
 * fallback keeps errors re-wrapped by callers (for example per-chunk failures)
 * classifiable without extra plumbing.
 */
export declare function isProtocolDrift(error: unknown): boolean;
/** Read a Node `SystemError` code without assuming the thrown value's shape. */
export declare function errnoCode(error: unknown): string | undefined;
/**
 * Translate a failed `spawn()` attempt into a structured error. `EPERM` is
 * deliberately distinct: it means the sandbox refused process creation, not
 * that the output directory is unwritable.
 */
export declare function spawnFailure(error: unknown): TtsError;
//# sourceMappingURL=errors.d.ts.map