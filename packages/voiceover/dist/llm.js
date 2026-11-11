/**
 * The model boundary. The pipeline depends on this narrow `Completer` port, not
 * on any particular provider, so it runs identically inside DSH (host adapter),
 * against an OpenAI-compatible endpoint, and in tests (a scripted fake).
 */
import { repairPrompt } from "./prompts.js";
import { ValidationError } from "./validate.js";
/** Failure with a routable code; callers distinguish retryable from terminal. */
export class LlmError extends Error {
    code;
    retryable;
    constructor(code, message, retryable) {
        super(message);
        this.name = 'LlmError';
        this.code = code;
        this.retryable = retryable;
    }
}
/**
 * Pull one JSON value out of a model reply. Tolerates fences and leading prose,
 * but never invents structure: a reply without a JSON object is an error.
 */
export function extractJson(text) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    const body = (fenced?.[1] ?? text).trim();
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) {
        throw new LlmError('LLM_BAD_JSON', 'The model reply contained no JSON object.', true);
    }
    try {
        return JSON.parse(body.slice(start, end + 1));
    }
    catch (error) {
        throw new LlmError('LLM_BAD_JSON', `The model reply was not valid JSON: ${String(error)}`, true);
    }
}
/**
 * Ask for JSON, validate it, and repair structure once before giving up. The
 * repair pass never re-runs the task, only the shape, so a bad outline cannot
 * silently become a different outline.
 */
export async function callJson(completer, prompt, validate, options = {}) {
    const repairRounds = options.repairRounds ?? 1;
    let previous = await completer.complete({
        system: prompt.system,
        user: prompt.user,
        temperature: options.temperature,
        signal: options.signal,
    });
    let lastError;
    for (let attempt = 0; attempt <= repairRounds; attempt += 1) {
        try {
            return validate(extractJson(previous));
        }
        catch (error) {
            lastError = error;
            if (attempt === repairRounds)
                break;
            const detail = error instanceof ValidationError ? error.message : String(error);
            const repair = repairPrompt({ error: detail, previous });
            previous = await completer.complete({
                system: repair.system,
                user: repair.user,
                temperature: 0,
                signal: options.signal,
            });
        }
    }
    const detail = lastError instanceof ValidationError ? lastError.message : String(lastError);
    throw new LlmError('LLM_SCHEMA_INVALID', `The model reply did not satisfy the schema: ${detail}`, true);
}
/**
 * OpenAI-compatible chat completions. Injecting `fetchImpl` keeps every test
 * offline and lets the same adapter serve a local gateway.
 */
export function httpCompleter(options) {
    const doFetch = options.fetchImpl ?? fetch;
    const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    return {
        model: options.label ?? options.model,
        async complete(request) {
            const signal = request.signal ?? AbortSignal.timeout(options.timeoutMs ?? 120_000);
            const response = await doFetch(endpoint, {
                method: 'POST',
                signal,
                headers: {
                    'content-type': 'application/json',
                    ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
                },
                body: JSON.stringify({
                    model: options.model,
                    temperature: request.temperature ?? 0.3,
                    messages: [
                        { role: 'system', content: request.system },
                        { role: 'user', content: request.user },
                    ],
                }),
            });
            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new LlmError('LLM_HTTP_FAILED', `The model endpoint returned ${response.status}: ${body.slice(0, 200)}`, response.status >= 500 || response.status === 429);
            }
            const payload = (await response.json());
            const content = payload.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || content.length === 0) {
                throw new LlmError('LLM_EMPTY_REPLY', 'The model endpoint returned an empty message.', true);
            }
            return content;
        },
    };
}
//# sourceMappingURL=llm.js.map