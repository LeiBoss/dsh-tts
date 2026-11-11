/**
 * The model boundary. The pipeline depends on this narrow `Completer` port, not
 * on any particular provider, so it runs identically inside DSH (host adapter),
 * against an OpenAI-compatible endpoint, and in tests (a scripted fake).
 */
import { repairPrompt, type Prompt } from './prompts.ts'
import { ValidationError } from './validate.ts'

/** One completion request. */
export interface CompletionRequest {
  system: string
  user: string
  temperature?: number
  signal?: AbortSignal
}

/** Anything that can answer one prompt. */
export interface Completer {
  complete(request: CompletionRequest): Promise<string>
  /** Human-facing identity recorded in the manifest, for example `deepseek-chat`. */
  readonly model?: string
}

/** Failure with a routable code; callers distinguish retryable from terminal. */
export class LlmError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable: boolean) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.retryable = retryable
  }
}

/**
 * Pull one JSON value out of a model reply. Tolerates fences and leading prose,
 * but never invents structure: a reply without a JSON object is an error.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = (fenced?.[1] ?? text).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new LlmError('LLM_BAD_JSON', 'The model reply contained no JSON object.', true)
  }
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown
  } catch (error) {
    throw new LlmError('LLM_BAD_JSON', `The model reply was not valid JSON: ${String(error)}`, true)
  }
}

/** Options for {@link callJson}. */
export interface CallJsonOptions {
  temperature?: number
  signal?: AbortSignal
  /** Extra attempts that only repair structure; defaults to 1. */
  repairRounds?: number
}

/**
 * Ask for JSON, validate it, and repair structure once before giving up. The
 * repair pass never re-runs the task, only the shape, so a bad outline cannot
 * silently become a different outline.
 */
export async function callJson<T>(
  completer: Completer,
  prompt: Prompt,
  validate: (value: unknown) => T,
  options: CallJsonOptions = {},
): Promise<T> {
  const repairRounds = options.repairRounds ?? 1
  let previous = await completer.complete({
    system: prompt.system,
    user: prompt.user,
    temperature: options.temperature,
    signal: options.signal,
  })

  let lastError: unknown
  for (let attempt = 0; attempt <= repairRounds; attempt += 1) {
    try {
      return validate(extractJson(previous))
    } catch (error) {
      lastError = error
      if (attempt === repairRounds) break
      const detail = error instanceof ValidationError ? error.message : String(error)
      const repair = repairPrompt({ error: detail, previous })
      previous = await completer.complete({
        system: repair.system,
        user: repair.user,
        temperature: 0,
        signal: options.signal,
      })
    }
  }

  const detail = lastError instanceof ValidationError ? lastError.message : String(lastError)
  throw new LlmError('LLM_SCHEMA_INVALID', `The model reply did not satisfy the schema: ${detail}`, true)
}

/** Options for {@link httpCompleter}. */
export interface HttpCompleterOptions {
  /** Base URL including `/v1`, for example `https://api.deepseek.com/v1`. */
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Recorded in the manifest; defaults to `model`. */
  label?: string
}

/**
 * OpenAI-compatible chat completions. Injecting `fetchImpl` keeps every test
 * offline and lets the same adapter serve a local gateway.
 */
export function httpCompleter(options: HttpCompleterOptions): Completer {
  const doFetch = options.fetchImpl ?? fetch
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`

  return {
    model: options.label ?? options.model,
    async complete(request: CompletionRequest): Promise<string> {
      const signal = request.signal ?? AbortSignal.timeout(options.timeoutMs ?? 120_000)
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
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new LlmError(
          'LLM_HTTP_FAILED',
          `The model endpoint returned ${response.status}: ${body.slice(0, 200)}`,
          response.status >= 500 || response.status === 429,
        )
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[]
      }
      const content = payload.choices?.[0]?.message?.content
      if (typeof content !== 'string' || content.length === 0) {
        throw new LlmError('LLM_EMPTY_REPLY', 'The model endpoint returned an empty message.', true)
      }
      return content
    },
  }
}
