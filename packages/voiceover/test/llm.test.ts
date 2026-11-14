import assert from 'node:assert/strict'
import test from 'node:test'
import { httpCompleter, LlmError } from '../src/llm.ts'

/** A fetch double that records the request and answers once. */
function fetchOnce(answer: {
  ok?: boolean
  status?: number
  json?: unknown
  text?: string
}): { impl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return {
      ok: answer.ok ?? true,
      status: answer.status ?? 200,
      json: async () => answer.json,
      text: async () => answer.text ?? '',
    }
  }) as unknown as typeof fetch
  return { impl, calls }
}

test('posts the model, messages and temperature to the chat endpoint', async () => {
  const { impl, calls } = fetchOnce({ json: { choices: [{ message: { content: 'hello' } }] } })
  const completer = httpCompleter({ baseUrl: 'https://api.example.com/v1/', model: 'm1', apiKey: 'k', fetchImpl: impl })

  const reply = await completer.complete({ system: 'sys', user: 'usr', temperature: 0.2 })
  assert.equal(reply, 'hello')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'https://api.example.com/v1/chat/completions')
  const headers = calls[0]?.init.headers as Record<string, string>
  assert.equal(headers.authorization, 'Bearer k')
  const body = JSON.parse(String(calls[0]?.init.body)) as {
    model: string
    temperature: number
    messages: { role: string; content: string }[]
  }
  assert.equal(body.model, 'm1')
  assert.equal(body.temperature, 0.2)
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'usr' },
  ])
})

test('omits the authorization header when no key is configured', async () => {
  const { impl, calls } = fetchOnce({ json: { choices: [{ message: { content: 'x' } }] } })
  const completer = httpCompleter({ baseUrl: 'http://127.0.0.1:8080/v1', model: 'm', fetchImpl: impl })
  await completer.complete({ system: 's', user: 'u' })
  const headers = calls[0]?.init.headers as Record<string, string>
  assert.equal(headers.authorization, undefined)
})

test('a server error is retryable, a client error is not', async () => {
  const server = httpCompleter({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetchImpl: fetchOnce({ ok: false, status: 503, text: 'busy' }).impl,
  })
  await assert.rejects(
    () => server.complete({ system: 's', user: 'u' }),
    (error: unknown) => error instanceof LlmError && error.code === 'LLM_HTTP_FAILED' && error.retryable,
  )

  const client = httpCompleter({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetchImpl: fetchOnce({ ok: false, status: 400, text: 'bad request' }).impl,
  })
  await assert.rejects(
    () => client.complete({ system: 's', user: 'u' }),
    (error: unknown) => error instanceof LlmError && error.code === 'LLM_HTTP_FAILED' && !error.retryable,
  )
})

test('an empty reply is a retryable failure, not an empty outline', async () => {
  const completer = httpCompleter({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetchImpl: fetchOnce({ json: { choices: [{ message: { content: '' } }] } }).impl,
  })
  await assert.rejects(
    () => completer.complete({ system: 's', user: 'u' }),
    (error: unknown) => error instanceof LlmError && error.code === 'LLM_EMPTY_REPLY' && error.retryable,
  )
})

test('a reply without choices is treated as empty', async () => {
  const completer = httpCompleter({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetchImpl: fetchOnce({ json: {} }).impl,
  })
  await assert.rejects(
    () => completer.complete({ system: 's', user: 'u' }),
    (error: unknown) => error instanceof LlmError && error.code === 'LLM_EMPTY_REPLY',
  )
})
