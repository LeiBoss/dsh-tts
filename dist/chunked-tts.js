/**
 * Serial chunked synthesis for long texts.
 *
 * Every chunk goes through the existing Edge-TTS path into a private temp
 * directory, in order, one subprocess at a time. The finished MP3 files are
 * concatenated byte-for-byte (MP3 frame streams allow this) and the result is
 * published atomically at the normal cache path, so the cache key remains the
 * hash of the full original text.
 */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AUDIO_FORMAT, outputFilePath } from "./cache.js";
import { splitText } from "./chunker.js";
import { synthesize, } from "./edge-tts.js";
import { ErrorCode, TtsError } from "./errors.js";
/** Pause between chunk subprocesses so Edge-TTS is not rate-limited. */
export const DEFAULT_INTER_CHUNK_DELAY_MS = 200;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function chunkFailure(index, total, error) {
    if (error instanceof TtsError) {
        return new TtsError(error.code, `Chunk ${index + 1}/${total} failed: ${error.detail}`, error.suggestion, { cause: error });
    }
    const detail = error instanceof Error ? error.message : String(error);
    return new TtsError(ErrorCode.EdgeTtsFailed, `Chunk ${index + 1}/${total} failed: ${detail}`, 'Retry the call; if it persists, run `tts_self_check` and inspect Edge-TTS output.', { cause: error });
}
function publishFailure(target, error) {
    const detail = error instanceof Error ? error.message : String(error);
    return new TtsError(ErrorCode.OutputDirNotWritable, `Cannot write the concatenated audio file ${target}: ${detail}`, 'Check the DSH sandbox file policy and the output directory permissions.', { cause: error });
}
/**
 * Synthesize `text` chunk by chunk and return one concatenated MP3. Callers
 * only use this above the chunk threshold; calling it with one chunk simply
 * delegates to the one-shot path.
 */
export async function synthesizeChunked(text, options) {
    const chunks = splitText(text, options.chunkSize);
    const base = {
        voice: options.voice,
        rate: options.rate,
        binary: options.binary,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        spawnImpl: options.spawnImpl,
    };
    if (chunks.length <= 1) {
        return synthesize(text, {
            ...base,
            outputDir: options.outputDir,
            hash: options.hash,
            now: options.now,
        });
    }
    const delayMs = options.interChunkDelayMs ?? DEFAULT_INTER_CHUNK_DELAY_MS;
    const delay = options.delay ?? sleep;
    const tempDir = await mkdtemp(join(tmpdir(), 'dsh-tts-chunks-'));
    const baseTime = (options.now ?? new Date()).getTime();
    try {
        const buffers = [];
        for (let index = 0; index < chunks.length; index += 1) {
            if (options.signal?.aborted) {
                throw new TtsError(ErrorCode.Aborted, 'Chunked synthesis was aborted.');
            }
            if (index > 0 && delayMs > 0)
                await delay(delayMs);
            try {
                const part = await synthesize(chunks[index] ?? '', {
                    ...base,
                    outputDir: tempDir,
                    hash: `part-${index}`,
                    now: new Date(baseTime + index),
                });
                buffers.push(await readFile(part.filePath));
            }
            catch (error) {
                throw chunkFailure(index, chunks.length, error);
            }
        }
        const bytes = Buffer.concat(buffers);
        if (bytes.length === 0) {
            throw new TtsError(ErrorCode.EmptyAudio, 'Chunked synthesis produced no audio bytes.', 'Retry the call; if it persists, run `tts_self_check`.');
        }
        const target = outputFilePath(options.outputDir, options.hash, options.now);
        try {
            await mkdir(dirname(target), { recursive: true });
            const partial = `${target}.partial`;
            await writeFile(partial, bytes);
            await rename(partial, target);
        }
        catch (error) {
            throw publishFailure(target, error);
        }
        return { filePath: target, format: AUDIO_FORMAT };
    }
    finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => { });
    }
}
//# sourceMappingURL=chunked-tts.js.map