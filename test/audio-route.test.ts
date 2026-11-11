import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Writable } from 'node:stream'
import test from 'node:test'
import {
  AUDIO_ROUTE_PREFIX,
  AudioRoute,
  type RegisterableRoute,
} from '../src/audio-route.ts'
import { resolveConfig } from '../src/config.ts'
import { apply, createTtsTools } from '../src/index.ts'
import { executionContext, successfulSpawn } from './helpers.ts'

/** Captures the response a ServerResponse would have written. */
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

class FakeServer {
  readonly routes: RegisterableRoute[] = []

  register(route: RegisterableRoute): () => void {
    this.routes.push(route)
    return () => {
      const index = this.routes.indexOf(route)
      if (index !== -1) this.routes.splice(index, 1)
    }
  }
}

function request(
  route: AudioRoute,
  url: string,
  options: { method?: string; range?: string } = {},
): Promise<FakeResponse> {
  const res = new FakeResponse()
  const finished = new Promise<void>((resolve) => res.on('finish', () => resolve()))
  const req = {
    method: options.method ?? 'GET',
    url,
    headers: options.range === undefined ? {} : { range: options.range },
  } as unknown as IncomingMessage

  const pending = route.handle(req, res as unknown as ServerResponse)
  return Promise.resolve(pending).then(() => finished).then(() => res)
}

async function withAudioFile(
  bytes: Buffer,
  run: (route: AudioRoute, filePath: string) => Promise<void>,
  options: { ttlMs?: number; now?: () => number } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-route-'))
  try {
    const dateDir = join(dir, '2026-11-11')
    await mkdir(dateDir, { recursive: true })
    const filePath = join(dateDir, 'abcdef0123456789-1.mp3')
    await writeFile(filePath, bytes)

    const route = new AudioRoute({ outputDir: dir, ...options })
    route.register(new FakeServer())
    await run(route, filePath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('the route registers on the host router and unregisters on dispose', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-route-'))
  try {
    const server = new FakeServer()
    const route = new AudioRoute({ outputDir: dir })

    const dispose = route.register(server)
    assert.equal(route.registered, true)
    assert.equal(server.routes.length, 1)
    assert.equal(server.routes[0]?.kind, 'prefix')
    assert.equal(server.routes[0]?.path, AUDIO_ROUTE_PREFIX)

    dispose()
    assert.equal(route.registered, false)
    assert.equal(server.routes.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('urlFor is unavailable before registration and refuses paths outside the ledger', async () => {
  await withAudioFile(Buffer.from('audio'), async (route, filePath) => {
    assert.match(route.urlFor(filePath) ?? '', new RegExp(`^${AUDIO_ROUTE_PREFIX}/`))
    assert.equal(route.urlFor('/etc/passwd'), undefined)
    assert.equal(route.urlFor('/tmp/outside.mp3'), undefined)

    const unregistered = new AudioRoute({ outputDir: '/tmp' })
    assert.equal(unregistered.urlFor('/tmp/x.mp3'), undefined)
  })
})

test('a full GET returns the file with audio/mpeg headers', async () => {
  const bytes = Buffer.from('ID3full-body')
  await withAudioFile(bytes, async (route, filePath) => {
    const url = route.urlFor(filePath)
    assert.ok(url)
    const res = await request(route, url)

    assert.equal(res.statusCode, 200)
    assert.equal(res.getHeader('content-type'), 'audio/mpeg')
    assert.equal(res.getHeader('accept-ranges'), 'bytes')
    assert.equal(res.getHeader('content-length'), String(bytes.length))
    assert.deepEqual(res.body, bytes)
  })
})

test('a byte range returns 206 with Content-Range and the exact slice', async () => {
  const bytes = Buffer.from('0123456789')
  await withAudioFile(bytes, async (route, filePath) => {
    const url = route.urlFor(filePath)
    assert.ok(url)

    const first = await request(route, url, { range: 'bytes=0-3' })
    assert.equal(first.statusCode, 206)
    assert.equal(first.getHeader('content-range'), `bytes 0-3/${bytes.length}`)
    assert.equal(first.getHeader('content-length'), '4')
    assert.equal(first.body.toString(), '0123')

    const tail = await request(route, url, { range: 'bytes=6-' })
    assert.equal(tail.statusCode, 206)
    assert.equal(tail.body.toString(), '6789')

    const suffix = await request(route, url, { range: 'bytes=-2' })
    assert.equal(suffix.statusCode, 206)
    assert.equal(suffix.body.toString(), '89')
  })
})

test('an unsatisfiable range returns 416 with the total size', async () => {
  await withAudioFile(Buffer.from('0123456789'), async (route, filePath) => {
    const url = route.urlFor(filePath)
    assert.ok(url)

    const res = await request(route, url, { range: 'bytes=99-' })
    assert.equal(res.statusCode, 416)
    assert.equal(res.getHeader('content-range'), 'bytes */10')
  })
})

test('HEAD returns headers without a body; other methods are rejected', async () => {
  const bytes = Buffer.from('0123456789')
  await withAudioFile(bytes, async (route, filePath) => {
    const url = route.urlFor(filePath)
    assert.ok(url)

    const head = await request(route, url, { method: 'HEAD' })
    assert.equal(head.statusCode, 200)
    assert.equal(head.getHeader('content-length'), String(bytes.length))
    assert.equal(head.body.length, 0)

    const post = await request(route, url, { method: 'POST' })
    assert.equal(post.statusCode, 405)
    assert.equal(post.getHeader('allow'), 'GET, HEAD')
  })
})

test('a forged or expired token is rejected', async () => {
  await withAudioFile(Buffer.from('audio'), async (route, filePath) => {
    const url = route.urlFor(filePath)
    assert.ok(url)

    const forged = `${url.slice(0, -1)}${url.endsWith('A') ? 'B' : 'A'}`
    assert.equal((await request(route, forged)).statusCode, 404)
  })

  let now = 1_000_000
  await withAudioFile(
    Buffer.from('audio'),
    async (route, filePath) => {
      const url = route.urlFor(filePath)
      assert.ok(url)
      now += 5_000
      assert.equal((await request(route, url)).statusCode, 404)
    },
    { ttlMs: 1_000, now: () => now },
  )
})

test('tts_generate returns browserUrl once the route is registered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-route-'))
  try {
    const server = new FakeServer()
    const route = new AudioRoute({ outputDir: dir })
    route.register(server)

    const config = resolveConfig({ outputDir: dir }, {})
    const [generate] = createTtsTools(config, {
      spawnImpl: successfulSpawn([]),
      audioRoute: route,
    })
    assert.ok(generate)

    const result = await generate.execute({ text: 'playable' }, executionContext())
    assert.equal(typeof result.browserUrl, 'string')
    assert.ok(result.browserUrl?.startsWith(`${AUDIO_ROUTE_PREFIX}/`))

    const res = await request(route, result.browserUrl ?? '')
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.toString(), 'ID3fake-mp3-bytes')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('apply registers both tools and the route through ctx.inject', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-route-'))
  try {
    const server = new FakeServer()
    const tools: unknown[] = []
    const effects: Array<() => void> = []

    const ctx = {
      tools: {
        register(tool: unknown) {
          tools.push(tool)
        },
      },
      inject(deps: string[], callback: (scope: unknown) => void) {
        assert.deepEqual(deps, ['httpServer'])
        callback({
          httpServer: server,
          effect(install: () => () => void) {
            effects.push(install())
          },
        })
      },
    }

    apply(ctx as never, { outputDir: dir })

    assert.equal(tools.length, 2)
    assert.equal(server.routes.length, 1)
    assert.equal(effects.length, 1)
    assert.equal(server.routes[0]?.path, AUDIO_ROUTE_PREFIX)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
