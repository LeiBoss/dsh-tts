/**
 * The model boundary. The pipeline depends on this narrow `Completer` port, not
 * on any particular provider, so it runs identically inside DSH (host adapter),
 * against an OpenAI-compatible endpoint, and in tests (a scripted fake).
 */
import { type Prompt } from './prompts.ts';
/** One completion request. */
export interface CompletionRequest {
    system: string;
    user: string;
    temperature?: number;
    signal?: AbortSignal;
}
/** Anything that can answer one prompt. */
export interface Completer {
    complete(request: CompletionRequest): Promise<string>;
    /** Human-facing identity recorded in the manifest, for example `deepseek-chat`. */
    readonly model?: string;
}
/** Failure with a routable code; callers distinguish retryable from terminal. */
export declare class LlmError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    constructor(code: string, message: string, retryable: boolean);
}
/**
 * Pull one JSON value out of a model reply. Tolerates fences and leading prose,
 * but never invents structure: a reply without a JSON object is an error.
 */
export declare function extractJson(text: string): unknown;
/** Options for {@link callJson}. */
export interface CallJsonOptions {
    temperature?: number;
    signal?: AbortSignal;
    /** Extra attempts that only repair structure; defaults to 1. */
    repairRounds?: number;
}
/**
 * Ask for JSON, validate it, and repair structure once before giving up. The
 * repair pass never re-runs the task, only the shape, so a bad outline cannot
 * silently become a different outline.
 */
export declare function callJson<T>(completer: Completer, prompt: Prompt, validate: (value: unknown) => T, options?: CallJsonOptions): Promise<T>;
/** Options for {@link httpCompleter}. */
export interface HttpCompleterOptions {
    /** Base URL including `/v1`, for example `https://api.deepseek.com/v1`. */
    baseUrl: string;
    model: string;
    apiKey?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    /** Recorded in the manifest; defaults to `model`. */
    label?: string;
}
/**
 * OpenAI-compatible chat completions. Injecting `fetchImpl` keeps every test
 * offline and lets the same adapter serve a local gateway.
 */
export declare function httpCompleter(options: HttpCompleterOptions): Completer;
//# sourceMappingURL=llm.d.ts.map