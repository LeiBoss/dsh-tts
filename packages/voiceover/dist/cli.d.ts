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
import { TtsService } from '@leiboss/dsh-tts';
import { type ApiContext } from './api.ts';
import { type StyleProfile } from './pipeline.ts';
/** Parsed command line. */
interface Options {
    port: number;
    host: string;
    outputDir: string;
    token?: string;
    voice: string;
    rate: string;
    style: StyleProfile;
    llmBaseUrl?: string;
    llmModel: string;
    llmKey?: string;
    chapterChars?: number;
}
/** Resolve options from flags, the environment, and defaults. */
declare function resolveOptions(argv: readonly string[], env: NodeJS.ProcessEnv): Options;
/** Start the daemon. Returns the listening server for tests. */
export declare function start(options: Options, inject?: {
    engine?: TtsService;
}): Promise<{
    server: ReturnType<typeof createServer>;
    context: ApiContext;
}>;
/** CLI entry. */
export declare function main(): Promise<void>;
export { resolveOptions };
//# sourceMappingURL=cli.d.ts.map