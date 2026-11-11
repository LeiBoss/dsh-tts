import { HarnessError } from '@deepseek-ai/dsh-llm';
/**
 * Stable, machine-readable failure codes. Callers route on these codes instead
 * of parsing human-facing messages.
 */
export declare const ErrorCode: {
    readonly EmptyText: "EMPTY_TEXT";
    readonly InvalidVoice: "INVALID_VOICE";
    readonly InvalidRate: "INVALID_RATE";
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
    readonly AllFallbacksFailed: "ALL_FALLBACKS_FAILED";
    readonly SpeechSynthesisRequired: "SPEECH_SYNTHESIS_REQUIRED";
};
export type TtsErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
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
    constructor(code: TtsErrorCode, message: string, suggestion?: string, options?: ErrorOptions);
}
/** Read a Node `SystemError` code without assuming the thrown value's shape. */
export declare function errnoCode(error: unknown): string | undefined;
/**
 * Translate a failed `spawn()` attempt into a structured error. `EPERM` is
 * deliberately distinct: it means the sandbox refused process creation, not
 * that the output directory is unwritable.
 */
export declare function spawnFailure(error: unknown): TtsError;
//# sourceMappingURL=errors.d.ts.map