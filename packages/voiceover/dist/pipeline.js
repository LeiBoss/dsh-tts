/**
 * The pipeline: plan chapters, adapt each one for listening, audit it, and
 * synthesize audio + subtitles. Every stage persists before it finishes, so a
 * crash resumes at the last completed chapter instead of restarting the book.
 *
 * Dependency inversion on purpose: `Completer` and `Synthesizer` are ports. That
 * keeps the whole core testable without a host, a network, or an audio engine.
 */
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { callJson, LlmError } from "./llm.js";
import { adaptPrompt, auditPrompt, chunkPrompt, coverageErrors, outlinePrompt, subtitlePrompt } from "./prompts.js";
import { alignUnits, formatSrt, splitUnitsFallback } from "./subtitle.js";
import { PROMPT_VERSION, } from "./types.js";
import { readJson, sha256, sha256Tag, shortId, splitParagraphs, writeJsonAtomic } from "./util.js";
import { validateManifest, validateOutline, ValidationError } from "./validate.js";
/** Target characters per planned chapter when no model is available. */
const FALLBACK_CHAPTER_CHARS = 1400;
/**
 * Canonical text used for identity and planning.
 *
 * Every caller (plugin tool, daemon, rerun) must key projects by this string,
 * not by the raw input: the persisted source file differs from the original by
 * a trailing newline, and identity must survive that round trip.
 */
export function normalizeSource(text) {
    return splitParagraphs(text).join('\n\n');
}
/** Compute the resume key for one chapter. */
export function chapterInputHash(text, style) {
    return sha256(`${text}\u0000style=${style}\u0000prompt=${PROMPT_VERSION}`);
}
/** Compute the project identity from everything that changes its output. */
export function projectKey(input) {
    return shortId(`${sha256(input.text)}|${input.voice}|${input.rate}|${input.style}|${PROMPT_VERSION}`);
}
/**
 * Deterministic outline when no model is available: pack paragraphs into
 * chapters of roughly {@link FALLBACK_CHAPTER_CHARS} characters.
 */
export function fallbackOutline(input) {
    const chapters = [];
    let start = 0;
    let chars = 0;
    const flush = (end) => {
        const index = chapters.length + 1;
        chapters.push({
            id: `ch-${String(index).padStart(2, '0')}`,
            title: `第${index}部分`,
            summary: '',
            sourceRange: [start, Math.max(start, end)],
            estimatedChars: Math.max(1, chars),
            crossRefs: [],
            note: '未使用模型，按段落等分',
        });
        start = end + 1;
        chars = 0;
    };
    for (const [index, paragraph] of input.paragraphs.entries()) {
        chars += paragraph.length;
        const last = index === input.paragraphs.length - 1;
        if (chars >= FALLBACK_CHAPTER_CHARS || last)
            flush(index);
    }
    if (chapters.length === 0) {
        chapters.push({ id: 'ch-01', title: '全文', summary: '', sourceRange: [0, 0], estimatedChars: 1, crossRefs: [], note: '' });
    }
    return { title: input.title, chapters };
}
/** Describe one block of paragraphs for stage P0a. */
function blockText(paragraphs, from, to) {
    const lines = [];
    for (let i = from; i <= to; i += 1) {
        lines.push(`###P${i}### ${paragraphs[i] ?? ''}`);
    }
    return lines.join('\n');
}
/** Plan chapters with the model, verifying coverage and falling back on failure. */
export async function planOutline(deps, input) {
    const warnings = [];
    const paragraphs = input.paragraphs;
    const totalChars = paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);
    const budget = Math.max(2000, Math.min(8000, input.maxBlocks ?? 6000));
    if (deps.completer === undefined) {
        warnings.push('capability.llm=false: chapters were split by length, no spoken-script adaptation ran');
        return { outline: fallbackOutline({ title: input.title, paragraphs }), warnings };
    }
    // P0a: one block at a time, so the model never sees the whole document.
    const blocks = [];
    let from = 0;
    let blockIndex = 0;
    while (from < paragraphs.length) {
        let to = from;
        let chars = 0;
        while (to < paragraphs.length - 1 && chars + (paragraphs[to]?.length ?? 0) < budget) {
            chars += paragraphs[to]?.length ?? 0;
            to += 1;
        }
        blockIndex += 1;
        const prompt = chunkPrompt({
            docTitle: input.title,
            blockId: `block-${String(blockIndex).padStart(3, '0')}`,
            blockIndex,
            blockTotal: 0,
            startParagraph: from,
            blockText: blockText(paragraphs, from, to),
        });
        try {
            const parsed = await callJson(deps.completer, prompt, (value) => {
                const record = value;
                if (typeof record.summary !== 'string')
                    throw new ValidationError('/summary', 'must be a string');
                const candidates = Array.isArray(record.chapterCandidates) ? record.chapterCandidates : [];
                return { summary: record.summary, chapterCandidates: candidates, crossRefs: record.crossRefs ?? [] };
            }, { temperature: 0.2, signal: undefined });
            blocks.push({ startParagraph: from, endParagraph: to, ...parsed });
        }
        catch (error) {
            warnings.push(`outline block ${blockIndex} failed (${String(error)}); the block was dropped from planning`);
        }
        from = to + 1;
    }
    // P0b: merge into one coverage-complete outline.
    const merge = outlinePrompt({ docTitle: input.title, paragraphTotal: paragraphs.length, charTotal: totalChars, blocks });
    try {
        const outline = await callJson(deps.completer, merge, validateOutline, { temperature: 0.3 });
        const errors = coverageErrors(outline, paragraphs.length);
        if (errors.length === 0)
            return { outline, warnings };
        warnings.push(`model outline was not contiguous (${errors[0] ?? 'unknown'}); fell back to length-based chapters`);
    }
    catch (error) {
        warnings.push(`outline merge failed (${String(error)}); fell back to length-based chapters`);
    }
    return { outline: fallbackOutline({ title: input.title, paragraphs }), warnings };
}
/** Run stage P1 (and one repair round when the audit rejects the result). */
export async function adaptChapter(deps, input) {
    if (deps.completer === undefined) {
        return { script: input.text, changes: [], risks: [{ kind: 'other', text: '未使用模型：保留了原文书面语' }] };
    }
    const base = adaptPrompt({
        docTitle: input.docTitle,
        chapterNo: input.chapterNo,
        chapterTotal: input.chapterTotal,
        chapterTitle: input.chapter.title,
        prevSummary: input.prevSummary,
        nextSummary: input.nextSummary,
        style: input.style,
        text: input.text,
    });
    const user = input.issues === undefined || input.issues.length === 0
        ? base.user
        : `${base.user}\n\n## 上一次质检提出的问题（必须修正，且不许引入新问题）\n${input.issues
            .map((issue) => `- ${issue}`)
            .join('\n')}`;
    return callJson(deps.completer, { system: base.system, user }, (value) => {
        const record = value;
        if (typeof record.script !== 'string' || record.script.trim().length === 0) {
            throw new ValidationError('/script', 'must be a non-empty string');
        }
        return {
            script: record.script,
            changes: Array.isArray(record.changes) ? record.changes : [],
            risks: Array.isArray(record.risks) ? record.risks : [],
        };
    }, { temperature: 0.35, signal: undefined });
}
/** Run stage P4. Returns the blocking issues (high severity only). */
export async function auditChapter(deps, input) {
    if (deps.completer === undefined)
        return [];
    try {
        const parsed = await callJson(deps.completer, auditPrompt({ source: input.source, script: input.script }), (value) => {
            const record = value;
            const issues = Array.isArray(record.issues) ? record.issues : [];
            return issues
                .map((raw) => {
                const issue = raw;
                const severity = issue.severity === 'high' || issue.severity === 'medium' || issue.severity === 'low' ? issue.severity : 'low';
                return {
                    severity,
                    kind: typeof issue.kind === 'string' ? issue.kind : 'other',
                    fix: typeof issue.fix === 'string' ? issue.fix : '',
                };
            })
                .filter((issue) => issue.fix.length > 0);
        }, { temperature: 0, signal: undefined });
        return parsed.filter((issue) => issue.severity === 'high');
    }
    catch (error) {
        deps.log?.('audit-failed', { error: String(error) });
        return [];
    }
}
/** Resolve subtitle units: model segmentation when possible, rules otherwise. */
async function subtitleUnits(deps, script) {
    if (deps.completer !== undefined) {
        try {
            const units = await callJson(deps.completer, subtitlePrompt(script), (value) => {
                const record = value;
                if (!Array.isArray(record.units))
                    throw new ValidationError('/units', 'must be an array');
                const parsed = record.units.map((raw, index) => {
                    const unit = raw;
                    if (typeof unit.text !== 'string' || unit.text.trim().length === 0) {
                        throw new ValidationError(`/units/${index}/text`, 'must be a non-empty string');
                    }
                    return { text: unit.text.trim() };
                });
                if (parsed.length === 0)
                    throw new ValidationError('/units', 'must not be empty');
                return parsed;
            }, { temperature: 0, signal: undefined });
            return { units, fromModel: true };
        }
        catch (error) {
            deps.log?.('subtitle-segment-failed', { error: String(error) });
        }
    }
    return { units: splitUnitsFallback(script), fromModel: false };
}
/** Filesystem layout of one project. */
function projectPaths(projectDir) {
    return {
        state: join(projectDir, 'state', 'state.json'),
        manifest: join(projectDir, 'manifest.json'),
        script: (id) => join(projectDir, 'script', `${id}.md`),
        audio: (id, ext) => join(projectDir, 'audio', `${id}.${ext}`),
        subtitles: (id, estimated) => join(projectDir, 'audio', estimated ? `${id}.est.srt` : `${id}.srt`),
    };
}
/** Load prior state for resume. Returns undefined when it is unusable. */
async function loadState(path, projectId) {
    const state = await readJson(path);
    if (state === undefined)
        return undefined;
    if (state.projectId !== projectId)
        return undefined;
    if (state.promptVersion !== PROMPT_VERSION)
        return undefined;
    return state;
}
/**
 * Run (or resume) one project. Chapter failures are recorded, not thrown: a
 * partial delivery with an honest manifest beats losing the whole job.
 */
export async function runProject(deps, options) {
    const now = deps.now ?? (() => new Date());
    const paragraphs = splitParagraphs(options.text);
    if (paragraphs.length === 0)
        throw new Error('The source text is empty after normalization.');
    const paths = (dir) => projectPaths(dir);
    // Identity is computed from the normalized text, not the raw input: a rerun
    // reads the persisted source file (which ends with a newline) and must still
    // land on the same project key.
    const normalizedText = paragraphs.join('\n\n');
    const projectId = projectKey({ text: normalizedText, voice: options.voice, rate: options.rate, style: options.style });
    const projectDir = join(options.outputDir, projectId);
    await mkdir(join(projectDir, 'audio'), { recursive: true });
    await mkdir(join(projectDir, 'script'), { recursive: true });
    await mkdir(join(projectDir, 'state'), { recursive: true });
    await mkdir(join(projectDir, 'source'), { recursive: true });
    await writeFile(join(projectDir, 'source', 'normalized.md'), `${paragraphs.join('\n\n')}\n`, 'utf8');
    const existing = await loadState(paths(projectDir).state, projectId);
    const capability = {
        llm: deps.completer !== undefined,
        network: options.network,
        wordBoundaries: false,
        timingQuality: existing?.capability.timingQuality ?? 'estimated',
    };
    const engine = { name: options.network ? 'edge-py' : 'sapi', voice: options.voice, rate: options.rate };
    let outline;
    let warnings = existing?.warnings ?? [];
    if (existing !== undefined && options.rerun !== 'source') {
        outline = validateOutline(existing.outline);
    }
    else {
        const planned = await planOutline(deps, { title: options.title, paragraphs, maxBlocks: options.maxBlocks });
        outline = planned.outline;
        warnings = [...warnings, ...planned.warnings];
    }
    const state = {
        projectId,
        sourceHash: sha256(normalizedText),
        promptVersion: PROMPT_VERSION,
        engine,
        capability,
        style: existing?.style ?? options.style,
        outline,
        chapters: existing?.chapters ?? [],
        inputHashes: existing?.inputHashes ?? {},
        warnings,
        createdAt: existing?.createdAt ?? now().toISOString(),
    };
    // Persist the plan before the first chapter runs, so the conversation panel
    // can show progress instead of a missing-state 404 during chapter one.
    await writeJsonAtomic(paths(projectDir).state, state);
    const chaptersById = new Map(outline.chapters.map((chapter) => [chapter.id, chapter]));
    const ordered = [...outline.chapters].sort((a, b) => a.sourceRange[0] - b.sourceRange[0]);
    const skipped = [];
    for (const [index, chapter] of ordered.entries()) {
        const previous = state.chapters.find((record) => record.id === chapter.id);
        const chapterText = paragraphs.slice(chapter.sourceRange[0], chapter.sourceRange[1] + 1).join('\n\n');
        const inputHash = chapterInputHash(chapterText, options.style);
        const unchanged = state.inputHashes[chapter.id] === inputHash;
        const finished = previous?.status === 'done';
        if (unchanged && finished && options.rerun === undefined) {
            skipped.push(chapter.id);
            continue;
        }
        if (options.rerun === 'synth' && previous?.status === 'done') {
            // keep the script, redo audio only
            skipped.push(chapter.id);
            continue;
        }
        const record = {
            id: chapter.id,
            order: index + 1,
            title: chapter.title,
            chars: chapterText.length,
            sourceRange: chapter.sourceRange,
            status: 'queued',
        };
        const upsert = (next) => {
            const at = state.chapters.findIndex((entry) => entry.id === next.id);
            if (at >= 0)
                state.chapters[at] = next;
            else
                state.chapters.push(next);
        };
        try {
            upsert({ ...record, status: 'adapted' });
            const prevSummary = index > 0 ? (ordered[index - 1]?.summary ?? '') : '';
            const nextSummary = ordered[index + 1]?.summary ?? '';
            const adapted = await adaptChapter(deps, {
                docTitle: options.title,
                chapter,
                chapterNo: index + 1,
                chapterTotal: ordered.length,
                text: chapterText,
                style: options.style,
                prevSummary,
                nextSummary,
            });
            // P4 only where it pays: long chapters, retried chapters, and a sample.
            const sample = options.auditSample ?? 2;
            const shouldAudit = chapterText.length > 3000 || index < sample;
            let script = adapted.script;
            if (shouldAudit && deps.completer !== undefined) {
                const issues = await auditChapter(deps, { source: chapterText, script });
                upsert({ ...record, status: 'audited' });
                if (issues.length > 0) {
                    const repaired = await adaptChapter(deps, {
                        docTitle: options.title,
                        chapter,
                        chapterNo: index + 1,
                        chapterTotal: ordered.length,
                        text: chapterText,
                        style: options.style,
                        prevSummary,
                        nextSummary,
                        issues: issues.map((issue) => `${issue.kind}: ${issue.fix}`),
                    });
                    script = repaired.script;
                    state.warnings.push(`${chapter.id}: ${issues.length} high-severity issue(s) sent back for one repair round`);
                }
            }
            const scriptPath = paths(projectDir).script(chapter.id);
            await writeFile(scriptPath, `${script}\n`, 'utf8');
            const synthesized = await deps.synth.synthesize({ text: script, voice: options.voice, rate: options.rate, signal: options.signal });
            // Record the engine that actually ran, not the one we expected.
            if (synthesized.engine !== undefined) {
                const reported = synthesized.engine;
                const known = reported === 'sapi' || reported === 'edge-js' || reported === 'edge-py' ? reported : 'edge-py';
                state.engine = { ...state.engine, name: known };
            }
            const audioPath = paths(projectDir).audio(chapter.id, synthesized.format);
            await copyFile(synthesized.filePath, audioPath);
            upsert({
                ...record,
                status: 'synthesized',
                script: { path: `script/${chapter.id}.md`, hash: sha256(script) },
                audio: {
                    path: `audio/${chapter.id}.${synthesized.format}`,
                    bytes: synthesized.bytes,
                    durationMs: synthesized.durationMs,
                    timingQuality: synthesized.timingQuality,
                    format: synthesized.format,
                },
            });
            const segmented = await subtitleUnits(deps, script);
            const aligned = alignUnits(segmented.units, synthesized.durationMs, synthesized.words);
            const subtitlePath = paths(projectDir).subtitles(chapter.id, aligned.quality === 'estimated');
            await writeFile(subtitlePath, formatSrt(aligned.units), 'utf8');
            upsert({
                ...record,
                status: 'done',
                script: { path: `script/${chapter.id}.md`, hash: sha256(script) },
                audio: {
                    path: `audio/${chapter.id}.${synthesized.format}`,
                    bytes: synthesized.bytes,
                    durationMs: synthesized.durationMs,
                    timingQuality: synthesized.timingQuality,
                    format: synthesized.format,
                },
                subtitles: {
                    path: `audio/${aligned.quality === 'estimated' ? `${chapter.id}.est.srt` : `${chapter.id}.srt`}`,
                    units: aligned.units.length,
                    timingQuality: aligned.quality,
                },
            });
            state.inputHashes[chapter.id] = inputHash;
        }
        catch (error) {
            const code = error instanceof LlmError ? error.code : error instanceof ValidationError ? 'VALIDATION_FAILED' : 'CHAPTER_FAILED';
            const retryable = error instanceof LlmError ? error.retryable : false;
            upsert({
                ...record,
                status: 'failed',
                error: { code, message: error instanceof Error ? error.message.slice(0, 300) : String(error), retryable },
            });
            state.warnings.push(`${chapter.id}: failed with ${code}`);
        }
        await writeJsonAtomic(paths(projectDir).state, state);
    }
    const manifest = buildManifest({ state, outline: chaptersById, title: options.title, now });
    validateManifest(manifest);
    await writeJsonAtomic(paths(projectDir).manifest, manifest);
    await writeJsonAtomic(paths(projectDir).state, state);
    return { projectId, projectDir, manifest, state, skipped };
}
/** Assemble the manifest from persisted chapter records. */
export function buildManifest(input) {
    const { state, title, now } = input;
    const chapters = [...state.chapters].sort((a, b) => a.order - b.order);
    const done = chapters.filter((chapter) => chapter.status === 'done');
    return {
        schemaVersion: 1,
        projectId: state.projectId,
        createdAt: state.createdAt,
        updatedAt: now().toISOString(),
        title,
        capability: {
            ...state.capability,
            timingQuality: done.length === 0
                ? 'none'
                : done.every((chapter) => chapter.audio?.timingQuality === 'exact')
                    ? 'exact'
                    : 'estimated',
        },
        engine: state.engine,
        promptVersion: state.promptVersion,
        source: { path: 'source/normalized.md', hash: sha256Tag(state.sourceHash), chars: chapters.reduce((sum, chapter) => sum + chapter.chars, 0) },
        chapters: chapters.map((chapter) => ({
            id: chapter.id,
            order: chapter.order,
            title: chapter.title,
            chars: chapter.chars,
            sourceRange: chapter.sourceRange,
            status: chapter.status,
            ...(chapter.audio === undefined ? {} : { audio: chapter.audio }),
            ...(chapter.subtitles === undefined ? {} : { subtitles: chapter.subtitles }),
            ...(chapter.script === undefined ? {} : { script: chapter.script }),
            ...(chapter.error === undefined ? {} : { error: chapter.error }),
        })),
        totals: {
            chapters: done.length,
            chars: done.reduce((sum, chapter) => sum + chapter.chars, 0),
            audioMs: done.reduce((sum, chapter) => sum + (chapter.audio?.durationMs ?? 0), 0),
            bytes: done.reduce((sum, chapter) => sum + (chapter.audio?.bytes ?? 0), 0),
        },
        warnings: state.warnings,
    };
}
//# sourceMappingURL=pipeline.js.map