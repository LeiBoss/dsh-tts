/**
 * Host-level integration probe.
 *
 * This plugin declares `inject: ['tools', 'tts']`, so cordis only runs `apply`
 * once the engine has published its service. It then records what the real host
 * resolved and (optionally) performs one synthesis through `ctx.tts`.
 *
 * Output: JSON at $DSH_TTS_PROBE_OUT (default: ./.probe-result.json).
 * Env:
 *   DSH_TTS_PROBE_OUT    output path
 *   DSH_TTS_PROBE_SYNTH  "1" to synthesize once
 *   DSH_TTS_PROBE_TEXT   text for that synthesis (defaults to a fixed sentence)
 */
import { writeFileSync } from 'node:fs'

const out = process.env.DSH_TTS_PROBE_OUT ?? './.probe-result.json'

// Distinguishes "module never loaded" from "loaded but services never arrived".
writeFileSync(out, JSON.stringify({ stage: 'module-loaded', at: new Date().toISOString() }, null, 2))

export const name = 'dsh-tts-host-probe'
export const inject = ['tools', 'tts']

function toolNames(tools) {
  try {
    const defs = typeof tools.definitions === 'function' ? tools.definitions() : tools.definitions
    if (Array.isArray(defs)) return defs.map((d) => d?.name).filter(Boolean)
    if (defs && typeof defs === 'object') return Object.keys(defs)
  } catch {}
  return undefined
}

export async function apply(ctx) {
  const tts = ctx.get('tts')
  const tools = ctx.get('tools')
  const names = toolNames(tools) ?? []
  const relevant = names.filter((n) => n.startsWith('tts_') || n.startsWith('voiceover_'))

  const info = {
    stage: 'applied',
    hasTts: Boolean(tts),
    hasSynthesize: typeof tts?.synthesize === 'function',
    ttsCapabilities: tts?.capabilities ?? null,
    toolCount: names.length,
    toolNames: relevant,
    duplicates: relevant.filter((n, i) => relevant.indexOf(n) !== i),
    synth: null,
    at: new Date().toISOString(),
  }

  if (process.env.DSH_TTS_PROBE_SYNTH === '1' && typeof tts?.synthesize === 'function') {
    const started = Date.now()
    try {
      const result = await tts.synthesize({
        text: process.env.DSH_TTS_PROBE_TEXT ?? '联调测试，一二三四五。',
        voice: 'zh-CN-XiaoxiaoNeural',
      })
      info.synth = {
        ok: true,
        kind: result.kind,
        engine: result.engine ?? null,
        durationMs: result.durationMs ?? null,
        timingQuality: result.timingQuality ?? null,
        words: Array.isArray(result.words) ? result.words.length : null,
        fromCache: result.fromCache ?? null,
        elapsedMs: Date.now() - started,
      }
    } catch (error) {
      info.synth = {
        ok: false,
        code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 300),
        elapsedMs: Date.now() - started,
      }
    }
  }

  writeFileSync(out, JSON.stringify(info, null, 2))
  const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-tts-host-probe') : undefined
  logger?.info?.('probe applied: ' + JSON.stringify(info.synth ?? info.toolNames))
}