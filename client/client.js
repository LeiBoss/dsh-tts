/**
 * Browser half of the plugin: a keyed `tool.call.toolview` for `tts_generate`.
 *
 * The Host serves this file as the `exports["./client"]` bundle, so it must stay
 * in the lazy-CJS module-loader format: executing the script only registers the
 * factory, and the factory runs (with the shared `require`) on first import.
 *
 * `block` is either the running call node or the settled `ToolResultNode`. The
 * result node exposes the model-facing `content` blocks and an optional host
 * `meta`, not the structured tool return value, so the playback URL is taken
 * from the rendered text that `tts_generate` always emits.
 */

window.__ModuleLoader__.load({
  id: '@leiboss/dsh-tts',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    /** Same-origin playback path; stops at markup, quotes and whitespace. */
    const AUDIO_URL = /\/dsh-tts\/audio\/[^\s)"'<>`\]]+/g

    /**
     * Collect the playback URLs rendered into one tool result.
     * @param {readonly { text?: string }[] | undefined} blocks
     * @returns {string[]}
     */
    function extractAudioUrls(blocks) {
      /** @type {string[]} */
      const urls = []
      for (const block of blocks ?? []) {
        if (typeof block !== 'object' || block === null) continue
        if (typeof block.text !== 'string') continue
        const matches = block.text.match(AUDIO_URL)
        if (matches === null) continue
        for (const url of matches) if (!urls.includes(url)) urls.push(url)
      }
      return urls
    }

    /**
     * Inline player for the settled result; renders nothing while the call is
     * still running or when no playback URL was produced (non-Web hosts,
     * speechSynthesis fallback, route registration skipped).
     * @param {{ block?: unknown }} props
     */
    function TtsAudioView(props) {
      const block = props?.block
      if (typeof block !== 'object' || block === null) return null
      if ('name' in block) return null
      const urls = extractAudioUrls(
        /** @type {{ content?: { text?: string }[] }} */ (block).content,
      )
      if (urls.length === 0) return null
      return h(
        'div',
        { style: { width: '100%' } },
        urls.map((url) =>
          h('audio', {
            key: url,
            controls: true,
            preload: 'none',
            src: url,
            'aria-label': '播放',
            style: { width: '100%' },
          }),
        ),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('tool.call.toolview', function* () {
        yield ctx.slots.register(
          { name: 'tool.call.toolview', key: 'tts_generate' },
          TtsAudioView,
        )
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.extractAudioUrls = extractAudioUrls
    exports.TtsAudioView = TtsAudioView
    return module.exports
  },
})
