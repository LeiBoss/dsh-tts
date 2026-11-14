import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { setEdgeJsLoader } from '../src/engines/edge-js.ts'
import { apply } from '../src/index.ts'
import type { TtsService } from '../src/service.ts'

/** Start a plugin under a real cordis fiber and wait for mount. */
async function mount(ctx: Context, plugin: object, config?: unknown): Promise<void> {
  await (ctx.plugin(plugin, config) as PromiseLike<unknown>)
}

/** Provide the `tools` service the plugin injects. */
async function provideTools(ctx: Context): Promise<unknown[]> {
  const tools: unknown[] = []
  await mount(ctx, { apply: (c: Context) => c.provide('tools', { register: (tool: unknown) => tools.push(tool) }) })
  return tools
}

test('apply registers ctx.tts as a cordis service and keeps the three tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-cordis-'))
  try {
    const ctx = new Context()
    const tools = await provideTools(ctx)
    await mount(ctx, { name: 'dsh-tts', inject: ['tools'], apply }, { outputDir: dir })

    const service = ctx.get('tts') as TtsService | undefined
    assert.ok(service, 'ctx.get("tts") must resolve after mount')
    assert.equal(ctx.tts, service, 'the context proxy must also resolve the property')
    assert.equal(tools.length, 3, 'tts_generate / tts_self_check / tts_probe_network')

    // A consumer plugin (voiceover's shape) resolves the same instance.
    let seen: TtsService | undefined
    await mount(ctx, { inject: ['tts'], apply: (c: Context) => { seen = c.get('tts') as TtsService | undefined } })
    assert.equal(seen, service)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the mounted service synthesizes through the pure-JS backend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-cordis-'))
  setEdgeJsLoader(async () => ({
    EdgeTTS: class {
      constructor(config: Record<string, unknown>) {
        void config
      }

      async *streamAudio(text: string): AsyncGenerator<Buffer | { part: string; start: number; end: number }> {
        const frame = Buffer.concat([Buffer.from([0xff, 0xf3, 0x64, 0xc0]), Buffer.alloc(140)])
        yield Buffer.concat(Array.from({ length: 50 }, () => frame))
        yield { part: text.slice(0, 1), start: 0, end: 400 }
        yield { part: text.slice(1), start: 400, end: 1000 }
      }

      async ttsPromise(): Promise<void> {}
    },
  }))
  try {
    const ctx = new Context()
    await provideTools(ctx)
    await mount(ctx, { name: 'dsh-tts', inject: ['tools'], apply }, { outputDir: dir, engine: 'edge-js' })

    const service = ctx.get('tts') as TtsService
    const result = await service.synthesize({ text: '联调冒烟测试' })
    assert.equal(result.kind, 'audio')
    if (result.kind === 'audio') {
      assert.equal(result.engine, 'edge-js')
      assert.equal(result.durationMs, 1200)
      assert.ok((result.words ?? []).length > 0)
    }
  } finally {
    setEdgeJsLoader(undefined)
    await rm(dir, { recursive: true, force: true })
  }
})
