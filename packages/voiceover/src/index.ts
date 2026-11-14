/**
 * DSH entry point: config, tools, and the two host adapters (model + engine).
 *
 * The heavy lifting lives in `pipeline.ts`, which knows nothing about cordis.
 * This file is the only place that touches the host, so the pipeline stays
 * testable without a running DSH.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { AudioRoute } from '@leiboss/dsh-tts'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { httpCompleter, type Completer } from './llm.ts'
import { PanelRoute, type ConnectionFence, type HttpRouteRegistrar } from './panel.ts'
import { rerunProject } from './operations.ts'
import { runProject, projectKey, type PipelineDeps, type ProjectState, type StyleProfile } from './pipeline.ts'
import type { SynthResult, Synthesizer } from './types.ts'
import { readJson } from './util.ts'

export const name = 'dsh-voiceover'

/** The tool registry must exist before `apply` runs. */
export const inject = ['tools']

/** Config schema exposed to the DSH settings layer. */
export const Config = z.object({
  outputDir: z.string().description('Project root. Defaults to $DSH_HOME/voiceover.'),
  defaultVoice: z.string().default('zh-CN-XiaoxiaoNeural').description('Voice used when a call omits one.'),
  defaultRate: z.string().default('+0%').description('Speech rate used when a call omits one.'),
  style: z
    .union([z.const('lecture'), z.const('news'), z.const('story'), z.const('docs')])
    .default('news')
    .description('Default spoken-script style.'),
  auditSample: z.number().default(2).description('Chapters always audited from the start of the book.'),
  llmBaseUrl: z.string().description('OpenAI-compatible base URL, for example https://api.deepseek.com/v1.'),
  llmApiKey: z.string().description('API key for the model endpoint.'),
  llmModel: z.string().default('deepseek-chat').description('Model name recorded in the manifest.'),
  trustedHosts: z.array(z.string()).description('Extra Host names accepted by the audio route (reverse proxies).'),
})

/** Config accepted by {@link apply}. */
export interface VoiceoverConfig {
  outputDir?: string
  defaultVoice?: string
  defaultRate?: string
  style?: StyleProfile
  auditSample?: number
  llmBaseUrl?: string
  llmApiKey?: string
  llmModel?: string
  /** Extra Host names accepted by the audio route (reverse proxies). */
  trustedHosts?: string[]
}

/** Resolve the project root without requiring DSH_HOME. */
function resolveOutputDir(config: VoiceoverConfig, env: NodeJS.ProcessEnv): string {
  if (config.outputDir !== undefined && config.outputDir.length > 0) return config.outputDir
  const home = env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'voiceover')
}

/** Read an optional cordis service without a static dependency. */
function serviceOf<T>(ctx: Context, key: string): T | undefined {
  const getter = (ctx as unknown as { get?: (name: string) => unknown }).get
  return typeof getter === 'function' ? (getter.call(ctx, key) as T | undefined) : undefined
}

/** The engine service shape this package relies on. */
interface TtsServiceLike {
  synthesize(request: {
    text: string
    voice: string
    rate: string
    signal?: AbortSignal
  }): Promise<
    | {
        kind: 'audio'
        filePath: string
        format: string
        durationMs: number
        timingQuality: 'exact' | 'estimated'
        engine: string
        words?: SynthResult['words']
      }
    | { kind: 'speechSynthesis'; reason: string }
  >
}

/** Adapt `ctx.tts` to the pipeline's narrow synthesizer port. */
function engineSynthesizer(ctx: Context): Synthesizer {
  return {
    async synthesize(request): Promise<SynthResult> {
      const service = serviceOf<TtsServiceLike>(ctx, 'tts')
      if (service === undefined) {
        throw new Error(
          'No TTS engine is available: install @leiboss/dsh-tts, or add it to the same profile as @leiboss/dsh-voiceover.',
        )
      }
      const result = await service.synthesize(request)
      if (result.kind === 'speechSynthesis') {
        throw new Error(
          `No host engine could produce audio (${result.reason}). Voiceover needs a file, so fix the engine first.`,
        )
      }
      // The manifest schema requires a positive byte count, so measure it here
      // rather than trusting the engine to report its own file size.
      const bytes = (await stat(result.filePath)).size
      return {
        filePath: result.filePath,
        bytes,
        durationMs: result.durationMs,
        timingQuality: result.timingQuality,
        format: result.format === 'wav' ? 'wav' : 'mp3',
        engine: result.engine,
        ...(result.words === undefined ? {} : { words: result.words }),
      }
    },
  }
}

/** One in-flight run per project: a second create must not fork the same job. */
const inFlight = new Map<string, Promise<unknown>>()

/** Build the model port from config; absent config means "no model". */
function completer(config: VoiceoverConfig): Completer | undefined {
  if (config.llmBaseUrl === undefined || config.llmBaseUrl.length === 0) return undefined
  return httpCompleter({
    baseUrl: config.llmBaseUrl,
    model: config.llmModel ?? 'deepseek-chat',
    apiKey: config.llmApiKey,
    label: config.llmModel ?? 'deepseek-chat',
  })
}

/** Build the pipeline collaborators for one call site. */
function pipelineDeps(ctx: Context, config: VoiceoverConfig): PipelineDeps {
  const model = completer(config)
  return {
    ...(model === undefined ? {} : { completer: model }),
    synth: engineSynthesizer(ctx),
  }
}

/**
 * Start a rerun in the background, deduped per project.
 *
 * Both callers (the `voiceover_rerun` Tool and the panel button) land here; the
 * operation itself lives in `operations.ts`, so neither path owns a copy.
 */
function startRerun(
  ctx: Context,
  config: VoiceoverConfig,
  outputDir: string,
  projectId: string,
  chapters?: readonly string[],
): void {
  if (inFlight.has(projectId)) return
  const logger = typeof ctx.logger === 'function' ? ctx.logger('@leiboss/dsh-voiceover') : undefined
  const run = rerunProject(pipelineDeps(ctx, config), {
    outputDir,
    projectId,
    auditSample: config.auditSample ?? 2,
    ...(chapters === undefined ? {} : { chapters }),
  })
  inFlight.set(projectId, run)
  void run
    .catch((error: unknown) => {
      logger?.warn?.(`voiceover rerun failed: ${String(error)}`)
    })
    .finally(() => {
      inFlight.delete(projectId)
    })
}

/** Tool definitions; separated so tests can inspect them without a host. */
export function createVoiceoverTools(
  ctx: Context,
  config: VoiceoverConfig,
  env: NodeJS.ProcessEnv = process.env,
): ToolDefinition[] {
  const outputDir = resolveOutputDir(config, env)
  const deps = pipelineDeps(ctx, config)

  const create = defineTool({
    name: 'voiceover_create',
    description: [
      'Turn a long document into a set of chapter audio files with subtitles.',
      'Returns immediately with a projectId; poll `voiceover_status` for progress.',
      'Prefer `sourcePath` over `sourceText` for anything longer than a few paragraphs.',
    ].join(' '),
    parameters: {
      sourcePath: { type: 'string', description: 'Path to a local .md or .txt file. Preferred for long documents.' },
      sourceText: { type: 'string', description: 'Inline source text, for short documents only.' },
      title: { type: 'string', description: 'Title used for the manifest and chapter planning.' },
      voice: { type: 'string', description: `Edge TTS voice. Defaults to ${config.defaultVoice ?? 'zh-CN-XiaoxiaoNeural'}.` },
      style: { type: 'string', description: 'Spoken style: lecture, news, story, or docs.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectId: { type: 'string', description: 'Stable identity derived from source + settings.' },
          projectDir: { type: 'string', description: 'Directory holding audio, subtitles, scripts, and the manifest.' },
          status: { type: 'string', description: 'Always `running` for a new project.' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text' as const,
          text: [
            `Voiceover project ${value.projectId ?? ''} started. Directory: ${value.projectDir ?? ''}. Poll voiceover_status for per-chapter progress.`,
            // Stable token the conversation panel parses to poll its JSON route.
            `projectId: ${value.projectId ?? ''}`,
          ].join('\n'),
        },
      ],
    },
    async execute(args) {
      if (args.sourcePath === undefined && args.sourceText === undefined) {
        throw new Error('Provide either sourcePath or sourceText.')
      }
      if (args.sourcePath !== undefined && !/\.(md|markdown|txt)$/i.test(args.sourcePath)) {
        throw new Error('Only .md and .txt sources are supported in this version.')
      }
      const text = args.sourcePath === undefined ? (args.sourceText ?? '') : await readFile(args.sourcePath, 'utf8')
      const title =
        args.title !== undefined && args.title.length > 0
          ? args.title
          : (args.sourcePath?.replace(/\.[^.]+$/, '').split(/[\\/]/).pop() ?? '未命名')

      const voice = args.voice ?? config.defaultVoice ?? 'zh-CN-XiaoxiaoNeural'
      const style = (args.style ?? config.style ?? 'news') as StyleProfile
      const rate = config.defaultRate ?? '+0%'
      // The id is deterministic, so it can be reported before the run finishes.
      const projectId = projectKey({ text, voice, rate, style })

      const logger = typeof ctx.logger === 'function' ? ctx.logger('@leiboss/dsh-voiceover') : undefined
      if (!inFlight.has(projectId)) {
        const run = runProject(deps, {
          outputDir,
          title,
          text,
          voice,
          rate,
          style,
          network: true,
          auditSample: config.auditSample ?? 2,
        })
        inFlight.set(projectId, run)
        void run
          .catch((error: unknown) => {
            logger?.warn?.(`voiceover run failed: ${String(error)}`)
          })
          .finally(() => {
            inFlight.delete(projectId)
          })
      }

      return { projectId, projectDir: join(outputDir, projectId), status: 'running' }
    },
  })

  const status = defineTool({
    name: 'voiceover_status',
    description: 'Report per-chapter progress for a voiceover project. Reads persisted state; safe to poll.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'Id returned by voiceover_create.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectId: { type: 'string', description: 'Project identity.' },
          done: { type: 'number', description: 'Chapters finished.' },
          total: { type: 'number', description: 'Chapters planned.' },
          chapters: {
            type: 'array',
            description: 'Per-chapter status rows.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', description: 'Chapter id such as ch-01.' },
                title: { type: 'string', description: 'Chapter title.' },
                status: { type: 'string', description: 'Lifecycle status.' },
                error: { type: 'string', description: 'Error code when the chapter failed; omitted otherwise.' },
                durationMs: { type: 'number', description: 'Audio duration in milliseconds; omitted before synthesis.' },
                subtitles: { type: 'string', description: 'Subtitle path relative to the project; omitted when absent.' },
              },
            },
          },
          warnings: { type: 'array', items: { type: 'string' }, description: 'Degradations recorded by the pipeline.' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text' as const,
          text: [
            `projectId: ${value.projectId ?? ''}`,
            `${value.done}/${value.total} chapters done.`,
            ...(value.chapters ?? []).map(
              (chapter) =>
                `${chapter.id ?? ''} ${chapter.title ?? ''} - ${chapter.status ?? 'unknown'}${chapter.error === undefined ? '' : ` (${chapter.error})`}`,
            ),
            ...((value.warnings ?? []).length === 0 ? [] : ['Warnings:', ...(value.warnings ?? []).map((warning) => `- ${warning}`)]),
          ].join('\n'),
        },
      ],
    },
    async execute(args) {
      const projectId = args.projectId
      const state = await readJson<ProjectState>(join(outputDir, projectId, 'state', 'state.json'))
      if (state === undefined) throw new Error(`Unknown project: ${projectId}`)
      const done = state.chapters.filter((chapter) => chapter.status === 'done').length
      return {
        projectId,
        done,
        total: state.outline.chapters.length,
        chapters: state.chapters.map((chapter) => ({
          id: chapter.id,
          title: chapter.title,
          status: chapter.status,
          ...(chapter.error === undefined ? {} : { error: chapter.error.code }),
          ...(chapter.audio === undefined ? {} : { durationMs: chapter.audio.durationMs }),
          ...(chapter.subtitles === undefined ? {} : { subtitles: chapter.subtitles.path }),
        })),
        warnings: state.warnings,
      }
    },
  })

  const exportTool = defineTool({
    name: 'voiceover_export',
    description: 'List or resolve a finished project’s artifacts (audio, subtitles, manifest).',
    parameters: {
      projectId: { type: 'string', required: true, description: 'Id returned by voiceover_create.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectDir: { type: 'string', description: 'Project directory.' },
          manifest: { type: 'string', description: 'Absolute path to manifest.json.' },
          audio: { type: 'array', items: { type: 'string' }, description: 'Absolute audio paths.' },
          subtitles: { type: 'array', items: { type: 'string' }, description: 'Absolute subtitle paths.' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text' as const,
          text: [
            `Project: ${value.projectDir}`,
            `Manifest: ${value.manifest}`,
            ...(value.audio ?? []).map((path) => `Audio: ${path}`),
            ...(value.subtitles ?? []).map((path) => `Subtitles: ${path}`),
          ].join('\n'),
        },
      ],
    },
    async execute(args) {
      const projectId = args.projectId
      const projectDir = join(outputDir, projectId)
      const state = await readJson<ProjectState>(join(projectDir, 'state', 'state.json'))
      if (state === undefined) throw new Error(`Unknown project: ${projectId}`)
      return {
        projectDir,
        manifest: join(projectDir, 'manifest.json'),
        audio: state.chapters.flatMap((chapter) => (chapter.audio === undefined ? [] : [join(projectDir, chapter.audio.path)])),
        subtitles: state.chapters.flatMap((chapter) =>
          chapter.subtitles === undefined ? [] : [join(projectDir, chapter.subtitles.path)],
        ),
      }
    },
  })

  const rerun = defineTool({
    name: 'voiceover_rerun',
    description:
      'Resume a voiceover project: finished chapters are skipped, failed or missing ones run again. Returns immediately; poll voiceover_status.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'Id returned by voiceover_create.' },
      chapter: {
        type: 'string',
        description: 'Only this chapter, for example ch-03. Omit to resume every unfinished chapter.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectId: { type: 'string', description: 'Project identity.' },
          status: { type: 'string', description: 'Always `running`; poll voiceover_status.' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text' as const,
          text: [`Resuming project ${value.projectId ?? ''}.`, `projectId: ${value.projectId ?? ''}`].join('\n'),
        },
      ],
    },    async execute(args) {
      const projectId = args.projectId
      const chapter = args.chapter
      if (chapter !== undefined && !/^ch-[0-9]{2,3}$/.test(chapter)) {
        throw new Error('chapter must look like ch-03')
      }
      startRerun(ctx, config, outputDir, projectId, chapter === undefined ? undefined : [chapter])
      return { projectId, status: 'running' }
    },
  })
  return [create, status, exportTool, rerun]
}

/** Route prefix for per-chapter audio; distinct from the engine's own prefix. */
export const VOICEOVER_AUDIO_PREFIX = '/voiceover/audio'

/**
 * Mount the progress panel and the audio route behind the host fence.
 *
 * The audio route is the engine's `AudioRoute` with a different prefix: it
 * already mints signed, expiring URLs, serves Range requests for seeking, and
 * checks Host/Origin plus the browser session. Reusing it keeps one
 * implementation of that security surface instead of two.
 */
function mountWebSurfaces(ctx: Context, config: VoiceoverConfig, env: NodeJS.ProcessEnv = process.env): void {
  const outputDir = resolveOutputDir(config, env)
  const connection = serviceOf<ConnectionFence>(ctx, 'connection')
  const logger = typeof ctx.logger === 'function' ? ctx.logger('@leiboss/dsh-voiceover') : undefined
  const debug = (message: string): void => {
    logger?.debug?.(message)
  }

  const audio = new AudioRoute({
    outputDir,
    prefix: VOICEOVER_AUDIO_PREFIX,
    trustedHosts: config.trustedHosts ?? [],
    ...(connection === undefined ? {} : { connection }),
    debug,
  })
  const panel = new PanelRoute({
    outputDir,
    ...(connection === undefined ? {} : { connection }),
    audioUrlFor: (filePath) => audio.urlFor(filePath),
    onRerun: (projectId, chapter) =>
      startRerun(ctx, config, outputDir, projectId, chapter === undefined ? undefined : [chapter]),
    debug,
  })

  const register = (registrar: HttpRouteRegistrar): void => {
    try {
      const origin = (registrar as unknown as { getOrigin?: () => string | undefined }).getOrigin?.()
      if (origin !== undefined) audio.setOrigin(origin)
    } catch {
      // No advertised origin: the panel uses same-origin relative URLs anyway.
    }
    ctx.effect(() => audio.register(registrar))
    ctx.effect(() => panel.register(registrar))
  }

  // The Web host provides `webServer`; older hosts exposed the same router as
  // `httpServer`. Without either (headless, file://), the panel and playback do
  // not render and the tools still work.
  const web = serviceOf<HttpRouteRegistrar>(ctx, 'webServer') ?? serviceOf<HttpRouteRegistrar>(ctx, 'httpServer')
  if (web !== undefined) {
    register(web)
    return
  }
  ctx.inject(['webServer'], (webCtx) => {
    const late = (webCtx as unknown as { webServer?: HttpRouteRegistrar }).webServer
    if (late === undefined) return
    register(late)
  })
}

/** Mount the tools. Registration is fiber-owned, so unloading cleans up. */
export function apply(ctx: Context, config: VoiceoverConfig = {}): void {
  for (const tool of createVoiceoverTools(ctx, config)) {
    ctx.tools.register(tool)
  }
  mountWebSurfaces(ctx, config)
}
