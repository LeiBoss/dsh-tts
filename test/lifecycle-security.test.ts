import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import test from 'node:test'
import {
  AUDIO_ROUTE_PREFIX,
  AudioRoute,
  type RegisterableRoute,
} from '../src/audio-route.ts'
import { apply } from '../src/index.ts'

class FakeResponse extends Writable {
  statusCode = 200
  private readonly headerMap = new Map<string, string | string[]>()
  private readonly chunks: Buffer[] = []

  setHeader(name: string, value: string | string[]): this {
    this.headerMap.set(name.toLowerCase(), value)
    return this
  }

  getHeader(name: string): string | string[] | undefined {
    return this.headerMap.get(name.toLowerCase())
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }

  get body(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

interface TestRoute {
  kind: 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void
}

function makeContext() {
  const tools = new Map<string, unknown>()
  const routes = new Map<string, TestRoute>()
  const effects: Array<() => void> = []
  const debugMessages: string[] = []

  const server = {
    host: '127.0.0.1',
    port: 3000,
    register(route: RegisterableRoute): () => void {
      const typed = route as TestRoute
      if (routes.has(typed.path)) {
        throw new Error(`route already registered: ${typed.path}`)
      }
      routes.set(typed.path, typed)
      return () => {
        routes.delete(typed.path)
      }
    },
  }

  const ctx = {
    logger: () => ({ debug: (message: string) => debugMessages.push(message) }),
    tools: {
      register(tool: { name: string }) {
        if (tools.has(tool.name)) {
          throw new Error(`tool already registered: ${tool.name}`)
        }
        tools.set(tool.name, tool)
        effects.push(() => tools.delete(tool.name))
      },
    },
    inject(deps: string[], callback: (scope: unknown) => void) {
      assert.deepEqual(deps, ['webServer'])
      callback({
        webServer: server,
        effect(install: () => () => void) {
          effects.push(install())
        },
      })
    },
  }

  return {
    ctx,
    tools,
    routes,
    debugMessages,
    dispose() {
      while (effects.length > 0) effects.pop()?.()
    },
  }
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-lifecycle-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function activate(route: AudioRoute): void {
  route.register({ register: () => () => {} })
}

function request(
  route: AudioRoute,
  url: string,
  headers: Record<string, string> = {},
): Promise<FakeResponse> {
  const res = new FakeResponse()
  const finished = new Promise<void>((resolve) => res.on('finish', () => resolve()))
  const req = { method: 'GET', url, headers } as unknown as IncomingMessage
  const pending = route.handle(req, res as unknown as ServerResponse)
  return pending.then(() => finished).then(() => res)
}

test('apply wires ctx.connection.requestRejection into the audio route', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'clip.mp3'), 'ID3clip')
    let handler:
      | ((req: IncomingMessage, res: ServerResponse) => void)
      | undefined
    const server = {
      host: '127.0.0.1',
      port: 3000,
      register(route: RegisterableRoute) {
        handler = route.handler
        return () => {}
      },
    }
    const effects: Array<() => void> = []
    const ctx = {
      tools: { register() {} },
      get(name: string) {
        if (name === 'connection') {
          return { requestRejection: () => 401 as const }
        }
        if (name === 'webServer') return server
        return undefined
      },
      effect(install: () => () => void) {
        effects.push(install())
      },
    }

    apply(ctx as never, { outputDir: dir })
    assert.ok(handler)

    const res = new FakeResponse()
    const finished = new Promise<void>((resolve) =>
      res.on('finish', () => resolve()),
    )
    handler(
      {
        method: 'GET',
        url: `${AUDIO_ROUTE_PREFIX}/whatever`,
        headers: {},
      } as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    )
    await finished

    assert.equal(res.statusCode, 401)
    assert.equal(res.body.toString(), 'Unauthorized')
  })
})

test('apply -> dispose -> apply re-registers tools and route cleanly', async () => {
  await withTempDir(async (dir) => {
    const fake = makeContext()

    apply(fake.ctx as never, { outputDir: dir })
    assert.equal(fake.tools.size, 2)
    assert.equal(fake.routes.size, 1)
    assert.ok(fake.routes.has(AUDIO_ROUTE_PREFIX))

    fake.dispose()
    assert.equal(fake.tools.size, 0)
    assert.equal(fake.routes.size, 0)

    apply(fake.ctx as never, { outputDir: dir })
    assert.equal(fake.tools.size, 2)
    assert.equal(fake.routes.size, 1)
  })
})

test('same-origin Range playback still returns 206', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'clip.mp3'), Buffer.from('0123456789'))
    const route = new AudioRoute({
      outputDir: dir,
      expectedPort: 3000,
      allowedHosts: ['127.0.0.1', 'localhost'],
    })
    activate(route)
    const url = route.urlFor(join(dir, 'clip.mp3'))
    assert.ok(url)

    const res = await request(route, url, {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
      range: 'bytes=2-5',
    })

    assert.equal(res.statusCode, 206)
    assert.equal(res.body.toString(), '2345')
  })
})

test('a cross-origin request is rejected with 403 and no audio bytes', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'clip.mp3'), Buffer.from('0123456789'))
    const logs: string[] = []
    const route = new AudioRoute({
      outputDir: dir,
      expectedPort: 3000,
      allowedHosts: ['127.0.0.1'],
      debug: (message) => logs.push(message),
    })
    activate(route)
    const url = route.urlFor(join(dir, 'clip.mp3'))
    assert.ok(url)

    const res = await request(route, url, {
      host: '127.0.0.1:3000',
      origin: 'http://evil.example',
    })

    assert.equal(res.statusCode, 403)
    assert.equal(res.body.toString(), 'Forbidden')
    assert.equal(logs.length, 1)
    assert.match(logs[0] ?? '', /origin and host differ/)
    assert.equal((logs[0] ?? '').includes(url ?? ''), false, 'log must not leak the URL')
  })
})

test('a mismatched Host port is rejected even with a valid token', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'clip.mp3'), Buffer.from('0123456789'))
    const route = new AudioRoute({ outputDir: dir, expectedPort: 3000 })
    activate(route)
    const url = route.urlFor(join(dir, 'clip.mp3'))
    assert.ok(url)

    const res = await request(route, url, { host: '127.0.0.1:4000' })
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.toString(), 'Forbidden')
  })
})

test('a forged token is still rejected after the origin check', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'clip.mp3'), Buffer.from('0123456789'))
    const route = new AudioRoute({ outputDir: dir, expectedPort: 3000 })
    activate(route)
    const url = route.urlFor(join(dir, 'clip.mp3'))
    assert.ok(url)

    const res = await request(route, `${url.slice(0, -1)}x`, {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
    })
    assert.notEqual(res.statusCode, 200)
    assert.notEqual(res.body.toString(), '0123456789')
  })
})
