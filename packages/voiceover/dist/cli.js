#!/usr/bin/env node
/**
 * `dsh-voiceover serve` — the daemon entry.
 *
 * Same pipeline, same operations, different door: a local HTTP API so scripts
 * and agents outside DSH can synthesize a line, build a project, watch it, and
 * fetch audio/subtitles. The port binds to loopback by default and the daemon
 * refuses to start without a bearer token.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, TtsService } from '@leiboss/dsh-tts';
import { handleRequest } from "./api.js";
import { httpCompleter } from "./llm.js";
import { rerunProject } from "./operations.js";
import { normalizeSource, projectKey, runProject } from "./pipeline.js";
import { VERSION } from "./version.js";
/** Largest request body the daemon reads into memory. */
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const USAGE = `Usage: dsh-voiceover [serve] [options]

Options:
  -p, --port <n>        Listen port (default 7801)
      --host <addr>     Listen address (default 127.0.0.1)
      --output <dir>    Project root (default $DSH_HOME/voiceover)
      --token <value>   Bearer token (or DSH_VOICEOVER_TOKEN); required
      --voice <name>    Default voice (default zh-CN-XiaoxiaoNeural)
      --rate <value>    Default rate (default +0%)
      --style <name>    lecture | news | story | docs (default news)
      --llm-base-url <url>   OpenAI-compatible endpoint for script adaptation
      --llm-model <name>     Model name (default deepseek-chat)
      --llm-key <value>      API key (or DSH_VOICEOVER_LLM_KEY)
  -h, --help            Show this help
`;
/** Read `--name value` pairs without pulling in a dependency. */
function parseArgs(argv) {
    const parsed = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            const value = argv[index + 1];
            if (value === undefined)
                throw new Error(`${arg} needs a value`);
            index += 1;
            return value;
        };
        switch (arg) {
            case '-h':
            case '--help':
                parsed.help = true;
                break;
            case '-p':
            case '--port':
                parsed.port = Number(next());
                break;
            case '--host':
                parsed.host = next();
                break;
            case '--output':
                parsed.outputDir = next();
                break;
            case '--token':
                parsed.token = next();
                break;
            case '--voice':
                parsed.voice = next();
                break;
            case '--rate':
                parsed.rate = next();
                break;
            case '--style':
                parsed.style = next();
                break;
            case '--llm-base-url':
                parsed.llmBaseUrl = next();
                break;
            case '--llm-model':
                parsed.llmModel = next();
                break;
            case '--llm-key':
                parsed.llmKey = next();
                break;
            case '--chapter-chars':
                parsed.chapterChars = Number(next());
                break;
            default:
                if (arg !== undefined && arg.startsWith('-'))
                    throw new Error(`unknown option: ${arg}`);
        }
    }
    return parsed;
}
/** Resolve options from flags, the environment, and defaults. */
function resolveOptions(argv, env) {
    const parsed = parseArgs(argv);
    const home = env.DSH_HOME ?? join(homedir(), '.dsh');
    const style = parsed.style ?? 'news';
    if (!['lecture', 'news', 'story', 'docs'].includes(style)) {
        throw new Error(`unknown style: ${style}`);
    }
    return {
        port: parsed.port ?? 7801,
        host: parsed.host ?? '127.0.0.1',
        outputDir: parsed.outputDir ?? join(home, 'voiceover'),
        token: parsed.token ?? env.DSH_VOICEOVER_TOKEN,
        voice: parsed.voice ?? 'zh-CN-XiaoxiaoNeural',
        rate: parsed.rate ?? '+0%',
        style,
        llmModel: parsed.llmModel ?? 'deepseek-chat',
        ...(parsed.chapterChars === undefined ? {} : { chapterChars: parsed.chapterChars }),
        ...(parsed.llmBaseUrl === undefined ? {} : { llmBaseUrl: parsed.llmBaseUrl }),
        ...(parsed.llmKey === undefined && env.DSH_VOICEOVER_LLM_KEY === undefined
            ? {}
            : { llmKey: parsed.llmKey ?? env.DSH_VOICEOVER_LLM_KEY }),
    };
}
/** Engine-backed synthesizer for the pipeline. */
function engineSynthesizer(engine) {
    return {
        async synthesize(request) {
            const result = await engine.synthesize(request);
            if (result.kind === 'speechSynthesis') {
                throw new Error(`No engine could produce audio: ${result.reason}`);
            }
            const bytes = (await stat(result.filePath)).size;
            return {
                filePath: result.filePath,
                bytes,
                durationMs: result.durationMs,
                timingQuality: result.timingQuality,
                format: result.format === 'wav' ? 'wav' : 'mp3',
                // Report the engine that actually ran; without it the manifest falls
                // back to the planning-time guess and claims edge-py while edge-js ran.
                engine: result.engine,
                ...(result.words === undefined ? {} : { words: result.words }),
            };
        },
    };
}
/** Read the whole body with a hard cap. */
async function readBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = chunk;
        size += buffer.length;
        if (size > MAX_BODY_BYTES)
            return undefined;
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}
/** Start the daemon. Returns the listening server for tests. */
export async function start(options, inject = {}) {
    // The engine is injectable so a test can exercise the daemon without a
    // network or a real voice backend.
    const engine = inject.engine ??
        new TtsService(resolveConfig({ outputDir: join(options.outputDir, '.tts'), engine: 'auto' }, process.env));
    const model = options.llmBaseUrl === undefined
        ? undefined
        : httpCompleter({
            baseUrl: options.llmBaseUrl,
            model: options.llmModel,
            ...(options.llmKey === undefined ? {} : { apiKey: options.llmKey }),
        });
    const deps = {
        ...(model === undefined ? {} : { completer: model }),
        synth: engineSynthesizer(engine),
    };
    /** One in-flight run per project, shared by create and rerun. */
    const running = new Map();
    const track = (projectId, run) => {
        running.set(projectId, run);
        void run
            .catch((error) => {
            console.error(`[voiceover] ${projectId} failed: ${String(error)}`);
        })
            .finally(() => {
            running.delete(projectId);
        });
    };
    const context = {
        outputDir: options.outputDir,
        token: options.token ?? '',
        version: VERSION,
        startedAt: Date.now(),
        async synthesize(input) {
            const result = await engine.synthesize(input);
            if (result.kind === 'speechSynthesis') {
                throw new Error(`No engine could produce audio: ${result.reason}`);
            }
            return {
                filePath: result.filePath,
                format: result.format,
                durationMs: result.durationMs,
                timingQuality: result.timingQuality,
                engine: result.engine,
            };
        },
        async createProject(input) {
            const text = input.sourceText ?? (input.sourcePath === undefined ? '' : await readFile(input.sourcePath, 'utf8'));
            const normalized = normalizeSource(text);
            if (normalized.length === 0)
                throw new Error('the source text is empty');
            const voice = input.voice ?? options.voice;
            const rate = input.rate ?? options.rate;
            const style = input.style ?? options.style;
            const projectId = projectKey({ text: normalized, voice, rate, style });
            if (!running.has(projectId)) {
                track(projectId, runProject(deps, {
                    outputDir: options.outputDir,
                    title: input.title ?? '未命名',
                    text: normalized,
                    voice,
                    rate,
                    style,
                    network: true,
                    ...(options.chapterChars === undefined ? {} : { chapterChars: options.chapterChars }),
                }));
            }
            return { projectId };
        },
        async rerunProject(projectId, chapter) {
            if (running.has(projectId))
                return;
            track(projectId, rerunProject(deps, {
                outputDir: options.outputDir,
                projectId,
                ...(chapter === undefined ? {} : { chapters: [chapter] }),
            }));
        },
        async doctor() {
            return engine.doctor();
        },
    };
    const server = createServer((request, response) => {
        void (async () => {
            const body = await readBody(request);
            if (body === undefined) {
                response.writeHead(413, { 'content-type': 'application/json' });
                response.end(`${JSON.stringify({ error: 'body too large' })}\n`);
                return;
            }
            const result = await handleRequest(context, {
                method: request.method ?? 'GET',
                url: request.url ?? '/',
                headers: request.headers,
                body,
            });
            response.writeHead(result.status, result.headers);
            response.end(result.body);
        })().catch((error) => {
            response.writeHead(500, { 'content-type': 'application/json' });
            response.end(`${JSON.stringify({ error: String(error).slice(0, 200) })}\n`);
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => {
            server.off('error', reject);
            resolve();
        });
    });
    return { server, context };
}
/** CLI entry. */
export async function main() {
    const argv = process.argv.slice(2);
    if (argv[0] === 'serve')
        argv.shift();
    let options;
    try {
        const parsed = parseArgs(argv);
        if (parsed.help === true) {
            process.stdout.write(USAGE);
            return;
        }
        options = resolveOptions(argv, process.env);
    }
    catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
        process.exitCode = 2;
        return;
    }
    if (options.token === undefined || options.token.length === 0) {
        process.stderr.write('Refusing to start without a token. Pass --token or set DSH_VOICEOVER_TOKEN; every request must send "Authorization: Bearer <token>".\n');
        process.exitCode = 2;
        return;
    }
    const { server } = await start(options);
    const address = server.address();
    const shown = typeof address === 'object' && address !== null ? `${address.address}:${address.port}` : String(address);
    process.stdout.write(`dsh-voiceover ${VERSION} listening on http://${shown} (projects: ${options.outputDir})\n`);
    const shutdown = () => {
        server.close(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}
export { resolveOptions };
//# sourceMappingURL=cli.js.map