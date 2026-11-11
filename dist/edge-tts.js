import { spawn } from 'node:child_process';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AUDIO_FORMAT, outputFilePath } from "./cache.js";
import { ErrorCode, TtsError, spawnFailure } from "./errors.js";
/** Upper bound on captured stderr/stdout text, keeping the tail. */
const MAX_CAPTURE = 8_000;
const defaultSpawn = (command, args, options) => spawn(command, [...args], options);
function appendTail(current, chunk) {
    const next = current + chunk.toString();
    return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
}
/**
 * Run one child process, consuming stdout and stderr concurrently so neither
 * pipe can deadlock. Resolves for any completed exit status; throws structured
 * errors for spawn denial, cancellation, and timeout (killing the child).
 */
export function runProcess(command, args, options) {
    const spawnImpl = options.spawnImpl ?? defaultSpawn;
    const signal = options.signal;
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawnImpl(command, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                env: process.env,
            });
        }
        catch (error) {
            reject(spawnFailure(error));
            return;
        }
        let settled = false;
        let timer;
        let stdout = '';
        let stderr = '';
        const cleanup = () => {
            if (timer !== undefined)
                clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(error);
        };
        const settle = (code, exitSignal) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve({ code, signal: exitSignal, stdout, stderr });
        };
        const stop = () => {
            try {
                child.kill('SIGTERM');
            }
            catch {
                // The process already exited; nothing to stop.
            }
        };
        const onAbort = () => {
            fail(new TtsError(ErrorCode.Aborted, 'Edge-TTS synthesis was aborted.'));
            stop();
        };
        child.stdout?.on('data', (chunk) => {
            stdout = appendTail(stdout, chunk);
        });
        child.stderr?.on('data', (chunk) => {
            stderr = appendTail(stderr, chunk);
        });
        child.on('error', (error) => fail(spawnFailure(error)));
        child.on('close', (code, exitSignal) => {
            if (signal?.aborted) {
                fail(new TtsError(ErrorCode.Aborted, 'Edge-TTS synthesis was aborted.'));
                return;
            }
            settle(code, exitSignal);
        });
        timer = setTimeout(() => {
            fail(new TtsError(ErrorCode.SynthesisTimeout, `Edge-TTS did not finish within ${options.timeoutMs} ms.`, 'Increase `timeoutMs` or check network connectivity to the Edge-TTS service.'));
            stop();
        }, options.timeoutMs);
        if (signal) {
            if (signal.aborted)
                onAbort();
            else
                signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}
function outputFailure(target, error) {
    const detail = error instanceof Error ? error.message : String(error);
    return new TtsError(ErrorCode.OutputDirNotWritable, `Cannot write the audio file ${target}: ${detail}`, 'Check the DSH sandbox file policy and the output directory permissions. This is a filesystem denial, not a spawn EPERM.', { cause: error });
}
function stderrSuffix(stderr) {
    const trimmed = stderr.trim();
    return trimmed ? `\nstderr:\n${trimmed}` : '';
}
/**
 * Invoke the Edge-TTS CLI for `text` and return the finished file. Writes to a
 * `.partial` sibling and renames on success, so a crashed or concurrent run
 * never leaves a file that the cache would treat as complete.
 */
export async function synthesize(text, options) {
    const filePath = outputFilePath(options.outputDir, options.hash, options.now);
    const partialPath = `${filePath}.partial`;
    try {
        await mkdir(dirname(filePath), { recursive: true });
    }
    catch (error) {
        throw outputFailure(dirname(filePath), error);
    }
    const args = [
        `--text=${text}`,
        `--voice=${options.voice}`,
        `--rate=${options.rate}`,
        ...(options.pitch === undefined ? [] : [`--pitch=${options.pitch}`]),
        ...(options.volume === undefined ? [] : [`--volume=${options.volume}`]),
        `--write-media=${partialPath}`,
    ];
    try {
        const result = await runProcess(options.binary, args, {
            timeoutMs: options.timeoutMs,
            signal: options.signal,
            spawnImpl: options.spawnImpl,
        });
        if (result.code !== 0) {
            const status = result.code === null ? 'null' : String(result.code);
            const signal = result.signal ? ` (signal ${result.signal})` : '';
            throw new TtsError(ErrorCode.EdgeTtsFailed, `Edge-TTS exited with code ${status}${signal}.${stderrSuffix(result.stderr)}`, 'Check the voice and rate values and network connectivity, then run `tts_self_check`.');
        }
        const info = await stat(partialPath).catch(() => undefined);
        if (!info?.isFile() || info.size === 0) {
            throw new TtsError(ErrorCode.EmptyAudio, 'Edge-TTS reported success but produced no audio bytes.', 'Retry the call; if it persists, run `tts_self_check` and inspect Edge-TTS output.');
        }
        try {
            await rename(partialPath, filePath);
        }
        catch (error) {
            throw outputFailure(filePath, error);
        }
    }
    catch (error) {
        await rm(partialPath, { force: true }).catch(() => { });
        throw error;
    }
    return { filePath, format: AUDIO_FORMAT };
}
//# sourceMappingURL=edge-tts.js.map