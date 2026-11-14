#!/usr/bin/env node
/**
 * Render README screenshots from the real panel component.
 *
 * Why not a screenshot of the running app: this repository has no browser
 * automation, so there is no way to click through DSH, run a project and capture
 * the card. Instead the real client bundle is loaded with a tiny React shim, the
 * real component is called with a realistic snapshot, and the resulting tree is
 * serialised to HTML with the real theme tokens taken from the installed app.
 *
 * The README labels these as renders, not as screenshots of the app.
 *
 * Usage: node scripts/render-panel-shots.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const clientPath = join(repo, 'packages', 'voiceover', 'client', 'client.js')
const outDir = join(repo, 'docs', 'images')
const workDir = join(repo, '.pack', 'shots')
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

// Theme tokens read from the installed DSH app (app.asar), light theme.
const TOKENS = {
  '--dsw-alias-bg-layer-1': '#ffffff',
  '--dsw-alias-bg-layer-2': '#ffffff',
  '--dsw-alias-border-l1': '#0000000a',
  '--dsw-alias-border-l2': '#0000001a',
  '--dsw-alias-label-primary': '#0f1115',
  '--dsw-alias-label-secondary': '#61666b',
  '--dsw-alias-brand-primary': '#0f1115',
  '--dsw-alias-state-success-primary': '#22c55e',
  '--dsw-alias-state-error-primary': '#ef4444',
  '--dsw-alias-state-warn-primary': '#f59e0b',
  '--dsw-alias-state-idle-primary': '#cfd3d6',
  '--dsw-radius-md': '12px',
  '--dsh-content-font-size': '14px',
}

/** The demo project's subtitle line, so the playing shot shows real text. */
function loadCue() {
  const srt = join(repo, '.pack', 'demo-output', 'a067fb73cddd', 'audio', 'ch-02.srt')
  try {
    return readFileSync(srt, 'utf8')
  } catch {
    return '1\n00:00:00,050 --> 00:00:02,000\n示例字幕\n'
  }
}

/**
 * Load the client bundle with a React shim and return its exports.
 *
 * `statePlan` overrides useState values by call order, which is how the playing
 * shot gets a non-empty player without simulating clicks.
 */
function loadClient(statePlan = []) {
  let exports
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const index = react.__stateIndex ?? 0
      react.__stateIndex = index + 1
      const planned = statePlan[index]
      const value = planned !== undefined ? planned : typeof initial === 'function' ? initial() : initial
      return [value, () => {}]
    },
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ factory }) => (exports = factory((name) => react)) } },
    navigator: undefined,
    console,
    Set,
    Map,
    Object,
    JSON,
    Number,
    String,
    Array,
    Date,
    Math,
    URL,
    setTimeout,
    clearTimeout,
    fetch: () => new Promise(() => {}),
  }
  vm.runInNewContext(readFileSync(clientPath, 'utf8'), sandbox, { filename: clientPath })
  const module = exports
  module.__react = react
  return module
}

const UNITLESS = new Set(['fontWeight', 'lineHeight', 'opacity', 'zIndex', 'flex', 'fontVariantNumeric'])

function kebab(name) {
  return name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
}

function styleToCss(style) {
  const declarations = []
  for (const [key, value] of Object.entries(style ?? {})) {
    if (value === undefined || value === null) continue
    const css = typeof value === 'number' && !UNITLESS.has(key) ? `${value}px` : String(value)
    declarations.push(`${kebab(key)}:${css}`)
  }
  return declarations.join(';')
}

const ATTRS = new Set([
  'role',
  'title',
  'src',
  'type',
  'controls',
  'autoplay',
  'preload',
  'lang',
  'label',
])

function escapeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

function escapeText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function serialize(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string') return escapeText(node)
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(serialize).join('')

  const { type, props, children } = node
  // Function components (ChapterRow and friends) must be invoked, not stringified.
  if (typeof type === 'function') return serialize(type({ ...props, children }))
  const attributes = []
  if (props.style) attributes.push(`style="${escapeAttribute(styleToCss(props.style))}"`)
  if (props.className) attributes.push(`class="${escapeAttribute(props.className)}"`)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'style' || key === 'className' || key === 'key' || value === undefined) continue
    if (key.startsWith('aria-') || ATTRS.has(key)) {
      attributes.push(value === true ? key : `${key}="${escapeAttribute(value)}"`)
    }
  }
  const inner = serialize(children)
  const tag = type
  const voidTag = tag === 'audio' && props.src === undefined
  if (voidTag) return `<audio ${attributes.join(' ')}></audio>`
  return `<${tag}${attributes.length > 0 ? ` ${attributes.join(' ')}` : ''}>${inner}</${tag}>`
}

function page(body, title, script = '') {
  const variables = Object.entries(TOKENS)
    .map(([name, value]) => `${name}:${value}`)
    .join(';')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
:root{${variables}}
*{box-sizing:border-box}
body{margin:0;padding:32px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
.sheet{width:760px;background:#fff;border-radius:16px;border:1px solid #e6e8ec;padding:20px;box-shadow:0 8px 24px #0f11151a}
.label{font-size:12px;color:#8a9099;margin:0 0 10px}
</style>
</head>
<body><div class="sheet"><p class="label">${title}</p>${body}</div>${script}</body>
</html>`
}

/** A realistic in-progress project: five done, one failed, two pending. */
function progressSnapshot() {
  const now = new Date().toISOString()
  return {
    projectId: 'a067fb73cddd',
    title: '只写文档',
    done: 5,
    total: 8,
    pending: 2,
    failed: 1,
    capability: { llm: false, network: true, wordBoundaries: false, timingQuality: 'exact' },
    engine: { name: 'edge-js', voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%' },
    chapters: [
      { id: 'ch-01', order: 1, title: '为什么要写', status: 'done', durationMs: 114816, subtitles: 'audio/ch-01.srt' },
      { id: 'ch-02', order: 2, title: '判断标准', status: 'done', durationMs: 119544, subtitles: 'audio/ch-02.srt' },
      { id: 'ch-03', order: 3, title: '成本被高估', status: 'done', durationMs: 54936, subtitles: 'audio/ch-03.srt' },
      { id: 'ch-04', order: 4, title: '什么情况不写', status: 'done', durationMs: 96800, subtitles: 'audio/ch-04.srt' },
      { id: 'ch-05', order: 5, title: '从一份文档开始', status: 'done', durationMs: 71200, subtitles: 'audio/ch-05.srt' },
      { id: 'ch-06', order: 6, title: '团队的协作', status: 'failed', error: 'EDGE_TTS_FAILED' },
      { id: 'ch-07', order: 7, title: '评审与修订', status: 'synthesized' },
      { id: 'ch-08', order: 8, title: '结语', status: 'queued' },
    ],
    warnings: ['capability.llm=false: chapters were split by length, no spoken-script adaptation ran'],
    warningCount: 1,
    stateUpdatedAt: now,
    servedAt: now,
  }
}

function writeShot(name, client, html, windowSize) {
  mkdirSync(workDir, { recursive: true })
  const htmlPath = join(workDir, `${name}.html`)
  writeFileSync(htmlPath, html, 'utf8')
  const pngPath = join(outDir, `${name}.png`)
  execFileSync(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      `--window-size=${windowSize}`,
      '--autoplay-policy=no-user-gesture-required',
      '--allow-file-access-from-files',
      '--virtual-time-budget=4000',
      `--screenshot=${pngPath}`,
      `file:///${htmlPath.replaceAll('\\', '/')}`,
    ],
    { stdio: 'inherit' },
  )
  return pngPath
}

mkdirSync(outDir, { recursive: true })

// Shot 1: a running project with one failed chapter and the rerun affordance.
{
  const client = loadClient()
  client.__seedSnapshot('a067fb73cddd', progressSnapshot())
  const tree = client.VoiceoverPanel({
    phase: 'result',
    toolName: 'voiceover_status',
    block: { content: [{ type: 'text', text: 'projectId: a067fb73cddd\n状态: 进行中' }] },
  })
  const path = writeShot('panel-progress', client, page(serialize(tree), '对话中的工具结果 · 进度面板'), '824,470')
  console.log(`wrote ${path}`)
}

// Shot 2: playback with the current subtitle line underneath.
{
  const cues = loadClient().parseSrt(loadCue())
  const audioUrl = `file:///${join(repo, '.pack', 'demo-output', 'a067fb73cddd', 'audio', 'ch-02.mp3').replaceAll('\\', '/')}`
  const client = loadClient([
    undefined,
    undefined,
    { id: 'ch-02', url: audioUrl },
    cues,
    '文档就不再是一份记录，而是一个可以交接的决策',
  ])
  client.__seedSnapshot('a067fb73cddd', progressSnapshot())
  const tree = client.VoiceoverPanel({
    phase: 'result',
    toolName: 'voiceover_status',
    block: { content: [{ type: 'text', text: 'projectId: a067fb73cddd\n状态: 进行中' }] },
  })
  // Seek a little so the native control shows a real clock instead of 0:00.
  const seek = 
    '<script>const a=document.querySelector(\'audio\');if(a){a.currentTime=3;a.play().catch(()=>{})}</script>'
  const path = writeShot('panel-playing', client, page(serialize(tree), '试听 · 播放器下方显示当前字幕', seek), '824,560')
  console.log(`wrote ${path}`)
}
