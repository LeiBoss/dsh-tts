/**
 * Small pure helpers: hashing for cache identity, and JSON reads/writes that
 * never leave a half-written `state.json` behind a crash.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
/** Full sha256 hex digest, prefixed so manifests are self-describing. */
export function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
/** Prefixed digest used in manifests (`sha256:<64 hex>`). */
export function sha256Tag(input) {
    return `sha256:${sha256(input)}`;
}
/** Short, filesystem-safe identity for project directories. */
export function shortId(input) {
    return sha256(input).slice(0, 12);
}
/** Read JSON, treating a missing or malformed file as absent. */
export async function readJson(path) {
    try {
        const raw = await readFile(path, 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
/** Write JSON via a temp sibling and rename, so readers never see a partial file. */
export async function writeJsonAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temp, path);
}
/**
 * Split normalized prose into paragraphs on blank lines, dropping empty ones.
 * Paragraph indices are the currency of `sourceRange`, so this must be stable.
 */
export function splitParagraphs(text) {
    return text
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph.length > 0);
}
//# sourceMappingURL=util.js.map