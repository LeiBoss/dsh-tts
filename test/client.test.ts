import assert from 'node:assert/strict'
import test from 'node:test'

interface RenderedElement {
  type: string
  props: Record<string, unknown>
  children: unknown[]
}

interface Bundle {
  apply(ctx: unknown): void
  inject: string[]
  extractAudioUrls(blocks: readonly { text?: string }[] | undefined): string[]
  TtsAudioView(props: { block?: unknown }): unknown
}

type Factory = (require: (specifier: string) => unknown) => Bundle

let cached: Promise<Bundle> | undefined

function loadBundle(): Promise<Bundle> {
  cached ??= (async () => {
    let factory: Factory | undefined
    ;(globalThis as { window?: unknown }).window = {
      __ModuleLoader__: {
        load(entry: { factory: Factory }) {
          factory = entry.factory
        },
      },
    }
    await import('../client/client.js')
    assert.ok(factory, 'the bundle must register a factory')
    const reactStub = {
      createElement(type: string, props: Record<string, unknown>, ...children: unknown[]) {
        return { type, props, children }
      },
    }
    return factory((specifier) => {
      assert.equal(specifier, 'react')
      return reactStub
    })
  })()
  return cached
}

const PLAYBACK = '/dsh-tts/audio/1794397610.MjAyNi0abc.def-ghi_jkl'

test('the bundle registers a keyed toolview for tts_generate', async () => {
  const bundle = await loadBundle()
  const registrations: Array<{ name: string; key?: string }> = []
  const ctx = {
    slots: {
      inject(name: string, run: () => Generator) {
        assert.equal(name, 'tool.call.toolview')
        for (const _ of run()) void _
      },
      register(target: { name: string; key?: string }) {
        registrations.push(target)
        return () => {}
      },
    },
  }

  bundle.apply(ctx)

  assert.deepEqual(bundle.inject, ['slots'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0]?.name, 'tool.call.toolview')
  assert.equal(registrations[0]?.key, 'tts_generate')
})

test('extractAudioUrls reads the playback path out of the rendered result', async () => {
  const bundle = await loadBundle()

  assert.deepEqual(
    bundle.extractAudioUrls([
      { text: `Generated audio: \`/tmp/a.mp3\` (mp3)\nPlayback URL: ${PLAYBACK}` },
    ]),
    [PLAYBACK],
  )
  assert.deepEqual(
    bundle.extractAudioUrls([
      { text: `[▶ 播放](http://127.0.0.1:3080${PLAYBACK})` },
    ]),
    [PLAYBACK],
  )
  assert.deepEqual(bundle.extractAudioUrls([{ text: 'edge-tts failed' }]), [])
  assert.deepEqual(
    bundle.extractAudioUrls([{ text: PLAYBACK }, { text: PLAYBACK }]),
    [PLAYBACK],
    'duplicate mentions collapse to one player',
  )
})

test('a settled result renders a native audio element', async () => {
  const bundle = await loadBundle()
  const view = bundle.TtsAudioView({
    block: { content: [{ text: `Playback URL: ${PLAYBACK}` }], isError: false },
  }) as RenderedElement

  assert.equal(view.type, 'div')
  const audio = (view.children[0] as unknown as RenderedElement[])[0]
  assert.ok(audio)
  assert.equal(audio.type, 'audio')
  assert.equal(audio.props.src, PLAYBACK)
  assert.equal(audio.props.controls, true)
  assert.equal(audio.props.preload, 'none')
  assert.equal(audio.props.autoPlay, undefined)
  assert.equal(audio.props['aria-label'], '播放')
  assert.deepEqual(audio.props.style, { width: '100%' })
})

test('running calls and results without a playback URL render nothing', async () => {
  const bundle = await loadBundle()

  assert.equal(bundle.TtsAudioView({ block: { name: 'tts_generate' } }), null)
  assert.equal(
    bundle.TtsAudioView({
      block: { content: [{ text: 'fallback: speechSynthesis' }], isError: false },
    }),
    null,
  )
  assert.equal(
    bundle.TtsAudioView({ block: { content: [{ text: 'x' }], isError: true } }),
    null,
  )
  assert.equal(bundle.TtsAudioView({}), null)
})
