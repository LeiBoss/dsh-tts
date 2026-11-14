/**
 * Browser half of the voiceover plugin: a progress panel for the conversation.
 *
 * Why it polls HTTP instead of reading the tool result: a settled
 * `ToolResultNode` exposes only the model-facing text, not the structured
 * return value, and re-invoking the Tool from the UI would fight the
 * conversation. So the panel extracts the project id from the rendered text and
 * polls `GET /voiceover/panel/<projectId>.json`, which the Host half serves
 * from the same `state.json` the pipeline writes.
 *
 * Two rules this file must never break:
 * 1. A registered view REPLACES the generic tool row, so returning null for a
 *    settled result leaves a blank gap. Every result renders something:
 *    progress, an error row, or the raw text.
 * 2. The panel never invents freshness. "Last update" comes from the host's
 *    state-file mtime, so a stalled run looks stalled.
 *
 * Format: the Host serves this file as the `./client` bundle, so it stays in the
 * lazy-CJS module-loader format; executing it only registers the factory.
 */

window.__ModuleLoader__.load({
  id: '@leiboss/dsh-voiceover',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    /** Stable token emitted by `voiceover_create` and `voiceover_status`. */
    const PROJECT_ID = /projectId:\s*([0-9a-f]{8,24})/i

    /** Status words, kept short so a row fits on one line. */
    const LABEL = {
      queued: '排队',
      adapted: '改写',
      marked: '标注',
      audited: '质检',
      synthesized: '合成',
      timed: '对齐',
      done: '完成',
      failed: '失败',
    }

    /** Dot color per status; active states share the brand accent. */
    const TONE = {
      done: 'var(--dsw-alias-state-success-primary)',
      failed: 'var(--dsw-alias-state-error-primary)',
      queued: 'var(--dsw-alias-state-idle-primary)',
    }

    /** Error codes rendered as a cause plus what to do about it. */
    const ERROR_TEXT = {
      EDGE_TTS_FAILED: '配音服务失败，检查网络或代理',
      SYNTHESIS_TIMEOUT: '合成超时，可重试',
      TTS_BUSY: '配音队列繁忙，稍后自动重试',
      SPAWN_EPERM: '沙箱禁止创建子进程，需调整进程策略',
      OUTPUT_DIR_NOT_WRITABLE: '输出目录不可写',
      EMPTY_AUDIO: '返回空音频，可重试',
      LLM_SCHEMA_INVALID: '改写结果不合格，已降级',
      CHAPTER_FAILED: '本章失败，可重新创建续跑',
    }

    /** Font sizes follow the chat scale so a user-adjusted size also applies here. */
    const FONT = 'var(--dsh-content-font-size-secondary, 13px)'
    const FONT_META = 'calc(var(--dsh-content-font-size-secondary, 13px) - 2px)'
    const RADIUS = 'var(--dsw-radius-md, 10px)'

    const S = {
      card: {
        width: '100%',
        display: 'grid',
        gap: 8,
        padding: '10px 12px',
        borderRadius: RADIUS,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: FONT,
        boxSizing: 'border-box',
        overflow: 'hidden',
      },
      header: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
      title: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      count: { flex: 'none', fontSize: FONT_META, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      track: { height: 6, borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden' },
      fill: {
        height: '100%',
        borderRadius: 999,
        background: 'var(--dsw-alias-brand-primary)',
        transition: 'width 240ms ease',
      },
      state: { fontSize: FONT_META, color: 'var(--dsw-alias-label-secondary)' },
      chips: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      chip: {
        fontSize: FONT_META,
        lineHeight: '18px',
        padding: '0 6px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      },
      list: { display: 'grid', gap: 2, maxHeight: 260, overflowY: 'auto' },
      row: { display: 'grid', gridTemplateColumns: '8px 1fr auto auto', alignItems: 'center', gap: 8, minHeight: 22 },
      playBtn: {
        width: 18,
        height: 18,
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)',
        cursor: 'pointer',
        fontSize: FONT_META,
        lineHeight: '18px',
      },
      player: { width: '100%', height: 32 },
      retryBtn: {
        fontSize: FONT_META,
        padding: '0 6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)',
        cursor: 'pointer',
      },
      actions: { display: 'flex', gap: 8 },
      action: {
        fontSize: FONT_META,
        padding: '2px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)',
        cursor: 'pointer',
      },
      dot: { width: 8, height: 8, borderRadius: 999 },
      rowTitle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: {
        fontSize: FONT_META,
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        maxWidth: 160,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      warn: { fontSize: FONT_META, color: 'var(--dsw-alias-state-warn-primary)', overflowWrap: 'anywhere' },
      error: { fontSize: FONT_META, color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' },
      footer: { fontSize: FONT_META, color: 'var(--dsw-alias-label-secondary)', display: 'flex', gap: 8, flexWrap: 'wrap' },
      mono: { fontVariantNumeric: 'tabular-nums', userSelect: 'all' },
    }

    // Cross-mount cache: scrolling a row out of view and back must not flash a
    // loading card, and several status rows for one project share progress.
    const snapshots = new Map()
    const inFlight = new Map()

    /**
     * Concatenate the model-facing text of a result.
     * @param {{ text?: string }[] | undefined} blocks
     * @returns {string}
     */
    function blocksText(blocks) {
      if (!Array.isArray(blocks)) return ''
      let text = ''
      for (const block of blocks) {
        if (typeof block === 'object' && block !== null && typeof block.text === 'string') {
          text += `${block.text}\n`
        }
      }
      return text
    }

    /**
     * Pull the project id out of a rendered tool result.
     * @param {{ text?: string }[] | undefined} blocks
     * @returns {string | undefined}
     */
    function projectIdFrom(blocks) {
      const match = PROJECT_ID.exec(blocksText(blocks))
      return match === null ? undefined : match[1]
    }

    /** `m:ss` for a chapter duration; empty when unknown. */
    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
      const total = Math.round(ms / 1000)
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
    }

    /** `HH:MM:SS` in the viewer's clock, or empty for an unknown timestamp. */
    function formatClock(iso) {
      if (typeof iso !== 'string') return ''
      const time = Date.parse(iso)
      if (!Number.isFinite(time) || time <= 0) return ''
      const date = new Date(time)
      return [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map((part) => String(part).padStart(2, '0'))
        .join(':')
    }

    /** Translate the pipeline's warning strings into one user sentence. */
    function warningText(warning) {
      const text = typeof warning === 'string' ? warning : String(warning)
      if (text.startsWith('capability.llm=false')) return '未配置模型：按原文朗读，未做口语化改写'
      if (text.startsWith('outline merge failed')) return '章节规划失败，已按长度均分'
      if (text.startsWith('outline block')) return '部分正文块规划失败，已跳过'
      if (text.includes('high-severity')) return '质检发现高危问题，已回炉一次'
      return text.length > 80 ? `${text.slice(0, 80)}…` : text
    }

    /** Whether a settled result represents a failed call. */
    function isErrorResult(block) {
      if (typeof block !== 'object' || block === null) return false
      if (block.isError === true) return true
      return typeof block.error === 'object' && block.error !== null
    }

    /** Best-effort reason for a failed call, from `error` or the rendered text. */
    function errorMessage(block) {
      const error = block?.error
      if (typeof error === 'string' && error.length > 0) return error
      if (typeof error === 'object' && error !== null) {
        const reason = error.reason ?? error.message ?? error.code
        if (typeof reason === 'string' && reason.length > 0) return reason
      }
      const text = blocksText(block?.content).trim()
      return text.length > 0 ? text.slice(0, 240) : '未提供原因'
    }

    /** Derived run state; distinguishes "running" from "ended with failures". */
    function stateWord(snapshot) {
      if (snapshot.pending > 0) {
        const active = snapshot.chapters.find(
          (chapter) => chapter.status !== 'queued' && chapter.status !== 'done' && chapter.status !== 'failed',
        )
        const next = snapshot.chapters.find((chapter) => chapter.status === 'queued')
        const current = active ?? next
        return current === undefined
          ? `生成中 · 剩 ${snapshot.pending} 章`
          : `生成中 · ${current.id} ${LABEL[current.status] ?? current.status}`
      }
      if (snapshot.failed > 0) return `已结束 · ${snapshot.failed} 章失败`
      if (snapshot.total > 0 && snapshot.done === snapshot.total) return '已完成'
      return '准备中'
    }

    /** One capability pill. Neutral by default: a fallback is a mode, not a fault. */
    function chip(label) {
      return h('span', { key: label, style: S.chip }, label)
    }

    /** One chapter row. */
    function ChapterRow(props) {
      const chapter = props.chapter
      const playable = typeof chapter.audioUrl === 'string' && chapter.audioUrl.length > 0
      const tone = TONE[chapter.status] ?? 'var(--dsw-alias-brand-primary)'
      const duration = formatDuration(chapter.durationMs)
      const meta =
        chapter.error === undefined
          ? [LABEL[chapter.status] ?? chapter.status, duration, chapter.subtitles === undefined ? '' : '字幕']
              .filter(Boolean)
              .join(' · ')
          : (ERROR_TEXT[chapter.error] ?? '本章失败')
      return h(
        'div',
        { style: S.row, title: chapter.error ?? undefined },
        h('span', { style: { ...S.dot, background: tone } }),
        h('span', { style: S.rowTitle }, `${chapter.id} ${chapter.title}`),
        h('span', { style: chapter.error === undefined ? S.meta : { ...S.meta, color: 'var(--dsw-alias-state-error-primary)' } }, meta),
        chapter.status === 'failed'
          ? h('button',
              {
                type: 'button',
                style: S.retryBtn,
                'aria-label': `重跑 ${chapter.id} ${chapter.title}`,
                disabled: props.retrying,
                onClick: () => props.onRetry(chapter),
              },
              props.retrying ? '…' : '重试',
            )
          : playable
            ? h('button',
                {
                  type: 'button',
                  style: S.playBtn,
                  'aria-label': `${props.playing ? '停止' : '播放'} ${chapter.id} ${chapter.title}`,
                  onClick: () => props.onPlay(chapter),
                },
                props.playing ? '■' : '▶',
              )
            : h('span'),
      )
    }

    /** A failed call: never render nothing, the generic row is replaced. */
    function ErrorCard(props) {
      return h(
        'div',
        { style: S.card },
        h('div', { style: S.header }, h('span', { style: S.title }, props.title), h('span', { style: S.count }, '未开始')),
        h('div', { style: S.error }, props.reason),
        h('div', { style: S.state }, props.next),
      )
    }

    /** Compact row for the phases before a result exists. */
    function PendingCard(props) {
      return h(
        'div',
        { style: S.card },
        h('div', { style: S.header }, h('span', { style: S.title }, '有声项目'), h('span', { style: S.count }, props.label)),
      )
    }

    /**
     * Progress panel for one voiceover project.
     *
     * Hooks run before any early return so the hook order never changes.
     * @param {{ phase?: string, block?: unknown, toolName?: string }} props
     */
    function VoiceoverPanel(props) {
      const phase = props?.phase
      const block = props?.block
      const isResult = phase === 'result' || phase === undefined
      const failed = isResult && isErrorResult(block)
      const id = isResult && !failed ? projectIdFrom(/** @type {{ text?: string }[]} */ (block)?.content) : undefined

      const [snap, setSnap] = react.useState(() => (id === undefined ? null : (snapshots.get(id) ?? null)))
      const [problem, setProblem] = react.useState(null)
      // One player, not one per chapter: a 20-chapter project must not mount 20
      // audio elements, and the URL is stored at click time so a snapshot
      // refresh cannot restart playback.
      const [playing, setPlaying] = react.useState(null)
      // Bumping this restarts the polling effect, which is how the rerun button
      // gets fresh progress without a second fetch path.
      const [nonce, setNonce] = react.useState(0)
      const [busy, setBusy] = react.useState(false)
      // Which chapter is being retried; one at a time keeps the UI honest.
      const [retrying, setRetrying] = react.useState(null)

      react.useEffect(() => {
        if (id === undefined) return undefined
        let stopped = false
        let timer
        let attempts = 0
        const schedule = (delay) => {
          if (!stopped) timer = setTimeout(tick, delay)
        }
        const tick = async () => {
          try {
            // Several panels for one project share a single request.
            let request = inFlight.get(id)
            if (request === undefined) {
              request = fetch(`/voiceover/panel/${id}.json`, { credentials: 'same-origin', cache: 'no-store' })
              inFlight.set(id, request)
              request.finally(() => inFlight.delete(id)).catch(() => {})
            }
            const res = await request
            if (res.status === 404) {
              // The project exists but has not written state yet (planning or
              // the first chapter). That is a wait, not a broken endpoint.
              if (!stopped) {
                attempts = 0
                setProblem(null)
                schedule(2000)
              }
              return
            }
            if (!res.ok) {
              if (!stopped) {
                attempts += 1
                if (attempts >= 5) {
                  setProblem('unavailable')
                  return
                }
                setProblem('retrying')
                schedule(Math.min(30000, 2000 * 2 ** (attempts - 1)))
              }
              return
            }
            const next = await res.json()
            if (stopped) return
            attempts = 0
            setProblem(null)
            setSnap(next)
            snapshots.set(id, next)
            // Running projects poll fast; a project that ended with failures
            // polls slowly so a requested rerun becomes visible.
            if (next.pending > 0) schedule(2000)
            else if (next.failed > 0) schedule(10000)
          } catch {
            if (stopped) return
            attempts += 1
            if (attempts >= 5) {
              setProblem('unavailable')
              return
            }
            setProblem('retrying')
            schedule(Math.min(30000, 2000 * 2 ** (attempts - 1)))
          }
        }
        tick()
        return () => {
          stopped = true
          clearTimeout(timer)
        }
      }, [id, nonce])

      if (failed) {
        return h(ErrorCard, {
          title: props?.toolName === 'voiceover_status' ? '有声项目查询失败' : '有声项目创建失败',
          reason: errorMessage(block),
          next: '修正后重试；项目已存在时再次运行 voiceover_create 会跳过已完成章节。',
        })
      }
      if (!isResult) return h(PendingCard, { label: '规划中…' })
      if (id === undefined) {
        // A real but unrecognized result: show its text rather than a blank gap.
        const text = blocksText(/** @type {{ text?: string }[]} */ (block)?.content).trim()
        if (text.length === 0) return null
        return h(
          'div',
          { style: S.card },
          h('div', { style: S.title }, '有声项目'),
          h('div', { style: S.state }, text.slice(0, 400)),
        )
      }

      if (snap === null) {
        return h(PendingCard, {
          label: problem === 'unavailable' ? '进度不可用' : '准备中…',
        })
      }

      const total = typeof snap.total === 'number' ? snap.total : 0
      const done = typeof snap.done === 'number' ? snap.done : 0
      const failedCount = typeof snap.failed === 'number' ? snap.failed : 0
      const pending = typeof snap.pending === 'number' ? snap.pending : 0
      const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0
      const chapters = Array.isArray(snap.chapters) ? snap.chapters : []
      const warnings = Array.isArray(snap.warnings) ? snap.warnings : []
      const warningTotal = typeof snap.warningCount === 'number' ? snap.warningCount : warnings.length
      const capability = snap.capability ?? {}
      const engine = snap.engine ?? {}
      const clock = formatClock(snap.stateUpdatedAt)
      const stalled =
        pending > 0 && typeof snap.stateUpdatedAt === 'string' && Date.now() - Date.parse(snap.stateUpdatedAt) > 60000
      const finished = total > 0 && pending === 0 && failedCount === 0 && done === total
      const voice = engine.name === 'sapi' ? '配音 本地声音' : '配音 Edge 在线'
      const subtitles =
        capability.timingQuality === 'none'
          ? '字幕 待生成'
          : capability.timingQuality === 'exact'
            ? '字幕 精确时间轴'
            : '字幕 估算时间轴'

      // Same operation the `voiceover_rerun` Tool calls; this is only the
      // transport. Bumping `nonce` restarts the poller so progress resumes.
      const rerun = async () => {
        if (busy) return
        setBusy(true)
        try {
          const res = await fetch(`/voiceover/panel/${id}/rerun`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          if (res.ok) setNonce((value) => value + 1)
        } catch {
          // A dead host is already reported by the poller; leave the button.
        } finally {
          setBusy(false)
        }
      }

      // Per-chapter retry: the same route, narrowed to one chapter. The Tool
      // reaches the same operation through `voiceover_rerun({ chapter })`.
      const retryChapter = async (chapter) => {
        if (retrying !== null) return
        setRetrying(chapter.id)
        try {
          const res = await fetch(`/voiceover/panel/${id}/rerun`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chapter: chapter.id }),
          })
          if (res.ok) setNonce((value) => value + 1)
        } catch {
          // A dead host is already reported by the poller.
        } finally {
          setRetrying(null)
        }
      }

      return h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.header },
          h('span', { style: S.title }, snap.title || '有声项目'),
          h('span', { style: S.count }, total > 0 ? `${done}/${total} 章` : '准备中'),
        ),
        h('div', { style: S.track }, h('div', { style: { ...S.fill, width: `${pct}%` } })),
        h('div', { style: S.state }, stateWord({ ...snap, chapters, pending, failed: failedCount, done, total })),
        h(
          'div',
          { style: S.chips },
          chip(capability.llm === true ? '模型 改写' : '按原文朗读'),
          chip(voice),
          chip(subtitles),
        ),
        chapters.length === 0
          ? h('div', { style: S.state }, total > 0 ? `正在为 ${total} 章排队…` : '正在规划章节…')
          : h(
              'div',
              { style: S.list },
              chapters.map((chapter) =>
                h(ChapterRow, {
                  key: chapter.id,
                  chapter,
                  playing: playing !== null && playing.id === chapter.id,
                  retrying: retrying === chapter.id,
                  onPlay: (target) =>
                    setPlaying((current) =>
                      current !== null && current.id === target.id
                        ? null
                        : { id: target.id, url: target.audioUrl },
                    ),
                  onRetry: (target) => void retryChapter(target),
                }),
              ),
            ),
        playing === null
          ? null
          : h('audio', {
              key: playing.url,
              src: playing.url,
              controls: true,
              autoPlay: true,
              preload: 'none',
              style: S.player,
              onEnded: () => setPlaying(null),
            }),
        failedCount > 0
          ? h(
              'div',
              { style: S.actions },
              h(
                'button',
                { type: 'button', style: S.action, disabled: busy, onClick: rerun },
                busy ? '正在续跑…' : `重跑 ${failedCount} 章`,
              ),
            )
          : null,
        warnings.length === 0
          ? null
          : h(
              'div',
              { style: S.warn },
              warnings.slice(0, 3).map((warning, index) => h('div', { key: index }, warningText(warning))),
              warningTotal > 3 ? h('div', { key: 'more' }, `…还有 ${warningTotal - 3} 条提醒`) : null,
            ),
        stalled
          ? h('div', { style: S.warn }, '超过 60 秒没有进度写入，宿主可能重启过；让我重新运行 voiceover_status 续跑。')
          : null,
        finished
          ? h('div', { style: S.state }, `全部 ${done} 章已生成（音频 + 字幕）· 需要文件路径时让我运行 voiceover_export。`)
          : null,
        h(
          'div',
          { style: S.footer },
          h('span', { style: S.mono }, `projectId ${snap.projectId ?? ''}`),
          clock.length === 0 ? null : h('span', null, `更新于 ${clock}`),
        ),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('tool.call.toolview', function* () {
        yield ctx.slots.register({ name: 'tool.call.toolview', key: 'voiceover_create' }, VoiceoverPanel)
        yield ctx.slots.register({ name: 'tool.call.toolview', key: 'voiceover_status' }, VoiceoverPanel)
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.projectIdFrom = projectIdFrom
    exports.blocksText = blocksText
    exports.formatDuration = formatDuration
    exports.warningText = warningText
    exports.stateWord = stateWord
    exports.formatClock = formatClock
    exports.VoiceoverPanel = VoiceoverPanel
    return module.exports
  },
})
