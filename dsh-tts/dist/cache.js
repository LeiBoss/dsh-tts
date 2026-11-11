import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
/** Directory names this module owns: `YYYY-MM-DD`. */
const DATE_DIRECTORY = /^\d{4}-\d{2}-\d{2}$/;
/** Audio container Edge-TTS writes. */
export const AUDIO_FORMAT = 'mp3';
/**
 * Stable cache key for one synthesis request. The first 16 hex characters of
 * SHA-256 are enough to name a file while keeping names short.
 */
export function cacheKey(text, voice, rate) {
    return createHash('sha256')
        .update(`${text}\u0000${voice}\u0000${rate}`, 'utf8')
        .digest('hex')
        .slice(0, 16);
}
/** Local-calendar `YYYY-MM-DD` bucket for a timestamp. */
export function dateDirName(date = new Date()) {
    const year = String(date.getFullYear()).padStart(4, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
/**
 * Target path for a fresh synthesis: `<outputDir>/<date>/<hash>-<epochMs>.mp3`.
 * The timestamp keeps concurrent first-time syntheses from colliding.
 */
export function outputFilePath(outputDir, hash, date = new Date()) {
    return join(outputDir, dateDirName(date), `${hash}-${date.getTime()}.${AUDIO_FORMAT}`);
}
/**
 * Find an existing non-empty file for `hash`, newest date bucket first. Only
 * files carrying the exact key prefix and a positive size qualify, so a
 * partial or unrelated file never satisfies the cache.
 */
export async function findCachedFile(outputDir, hash) {
    let entries;
    try {
        entries = await readdir(outputDir, { withFileTypes: true });
    }
    catch {
        return undefined;
    }
    const dateDirs = entries
        .filter((entry) => entry.isDirectory() && DATE_DIRECTORY.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse();
    const prefix = `${hash}-`;
    for (const dirName of dateDirs) {
        const dir = join(outputDir, dirName);
        let names;
        try {
            names = await readdir(dir);
        }
        catch {
            continue;
        }
        for (const name of names) {
            if (!name.startsWith(prefix) || !name.endsWith(`.${AUDIO_FORMAT}`))
                continue;
            const filePath = join(dir, name);
            try {
                const info = await stat(filePath);
                if (info.isFile() && info.size > 0)
                    return filePath;
            }
            catch {
                // Raced with a cleanup; try the next candidate.
            }
        }
    }
    return undefined;
}
//# sourceMappingURL=cache.js.map