/** Minimal child-process surface used by the runner, kept injectable for tests. */
export interface ChildStream {
    on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}
/** Structural view of the parts of `ChildProcess` this module relies on. */
export interface ChildProcessLike {
    stdout: ChildStream | null;
    stderr: ChildStream | null;
    on(event: 'error', listener: (error: Error) => void): unknown;
    on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    kill(signal?: NodeJS.Signals | number): boolean;
}
/** Options passed to the injectable spawn implementation. */
export interface SpawnOptions {
    stdio: ['ignore', 'pipe', 'pipe'];
    windowsHide: boolean;
    env: NodeJS.ProcessEnv;
}
/** Injection point for the real `child_process.spawn` (or a test double). */
export type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcessLike;
/** Captured outcome of one child process. A non-zero exit is not an error here. */
export interface ProcessResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
}
/** Controls shared by every child-process call. */
export interface RunProcessOptions {
    timeoutMs: number;
    signal?: AbortSignal;
    spawnImpl?: SpawnFunction;
}
/**
 * Run one child process, consuming stdout and stderr concurrently so neither
 * pipe can deadlock. Resolves for any completed exit status; throws structured
 * errors for spawn denial, cancellation, and timeout (killing the child).
 */
export declare function runProcess(command: string, args: readonly string[], options: RunProcessOptions): Promise<ProcessResult>;
/** Settings for one synthesis call. */
export interface SynthesizeOptions {
    voice: string;
    rate: string;
    /** Pitch adjustment such as `+10Hz`; omitted for Edge-TTS's own default. */
    pitch?: string;
    /** Volume adjustment such as `-10%`; omitted for Edge-TTS's own default. */
    volume?: string;
    /**
     * HTTP proxy for the WSS connection, forwarded as `--proxy`. Edge-TTS does
     * not honour `HTTPS_PROXY`, so this is the only way to route it.
     */
    proxy?: string;
    binary: string;
    outputDir: string;
    /** Stable cache key; also names the output file. */
    hash: string;
    timeoutMs: number;
    signal?: AbortSignal;
    spawnImpl?: SpawnFunction;
    /** Injectable clock for deterministic tests. */
    now?: Date;
}
/** Canonical audio description returned to the tool layer. */
export interface SynthesizedAudio {
    filePath: string;
    format: string;
}
/**
 * Invoke the Edge-TTS CLI for `text` and return the finished file. Writes to a
 * `.partial` sibling and renames on success, so a crashed or concurrent run
 * never leaves a file that the cache would treat as complete.
 */
export declare function synthesize(text: string, options: SynthesizeOptions): Promise<SynthesizedAudio>;
//# sourceMappingURL=edge-tts.d.ts.map