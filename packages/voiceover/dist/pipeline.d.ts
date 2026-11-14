import { type Completer } from './llm.ts';
import { type Capability, type ChapterRecord, type EngineInfo, type Manifest, type Outline, type OutlineChapter, type SynthResult, type Synthesizer } from './types.ts';
/** How the script should sound. */
export type StyleProfile = 'lecture' | 'news' | 'story' | 'docs';
/** Collaborators the pipeline needs, all injectable. */
export interface PipelineDeps {
    /** Absent means "no model": the original text is spoken as written. */
    completer?: Completer;
    synth: Synthesizer;
    now?: () => Date;
    log?: (event: string, fields?: Record<string, unknown>) => void;
}
/** One project run. */
export interface ProjectOptions {
    outputDir: string;
    title: string;
    text: string;
    voice: string;
    rate: string;
    style: StyleProfile;
    /** Whether the network reached Edge-TTS at planning time (recorded, not guessed). */
    network: boolean;
    /** Chapters below this index are always audited; the rest are sampled. */
    auditSample?: number;
    maxBlocks?: number;
    signal?: AbortSignal;
    /** Force a stage to run again even when the hashes match. */
    rerun?: 'source' | 'script' | 'synth';
}
/** Persisted per-project state (never part of the manifest contract). */
export interface ProjectState {
    projectId: string;
    sourceHash: string;
    promptVersion: string;
    engine: EngineInfo;
    capability: Capability;
    /** Spoken style, persisted so a rerun reproduces the same project key. */
    style: StyleProfile;
    outline: Outline;
    chapters: ChapterRecord[];
    /** sha256 of each chapter's input text, for resume decisions. */
    inputHashes: Record<string, string>;
    warnings: string[];
    createdAt: string;
}
/** What a completed run returns. */
export interface ProjectResult {
    projectId: string;
    projectDir: string;
    manifest: Manifest;
    state: ProjectState;
    /** Chapters that were skipped because their inputs were unchanged. */
    skipped: string[];
}
/**
 * Canonical text used for identity and planning.
 *
 * Every caller (plugin tool, daemon, rerun) must key projects by this string,
 * not by the raw input: the persisted source file differs from the original by
 * a trailing newline, and identity must survive that round trip.
 */
export declare function normalizeSource(text: string): string;
/** Compute the resume key for one chapter. */
export declare function chapterInputHash(text: string, style: StyleProfile): string;
/** Compute the project identity from everything that changes its output. */
export declare function projectKey(input: {
    text: string;
    voice: string;
    rate: string;
    style: StyleProfile;
}): string;
/**
 * Deterministic outline when no model is available: pack paragraphs into
 * chapters of roughly {@link FALLBACK_CHAPTER_CHARS} characters.
 */
export declare function fallbackOutline(input: {
    title: string;
    paragraphs: string[];
}): Outline;
/** Plan chapters with the model, verifying coverage and falling back on failure. */
export declare function planOutline(deps: PipelineDeps, input: {
    title: string;
    paragraphs: string[];
    maxBlocks?: number;
}): Promise<{
    outline: Outline;
    warnings: string[];
}>;
/** Result of adapting one chapter. */
export interface AdaptResult {
    script: string;
    changes: unknown[];
    risks: unknown[];
}
/** Run stage P1 (and one repair round when the audit rejects the result). */
export declare function adaptChapter(deps: PipelineDeps, input: {
    docTitle: string;
    chapter: OutlineChapter;
    chapterNo: number;
    chapterTotal: number;
    text: string;
    style: StyleProfile;
    prevSummary: string;
    nextSummary: string;
    issues?: string[];
}): Promise<AdaptResult>;
/** One audit issue, kept only as far as the pipeline needs it. */
export interface AuditIssue {
    severity: 'high' | 'medium' | 'low';
    kind: string;
    fix: string;
}
/** Run stage P4. Returns the blocking issues (high severity only). */
export declare function auditChapter(deps: PipelineDeps, input: {
    source: string;
    script: string;
}): Promise<AuditIssue[]>;
/**
 * Run (or resume) one project. Chapter failures are recorded, not thrown: a
 * partial delivery with an honest manifest beats losing the whole job.
 */
export declare function runProject(deps: PipelineDeps, options: ProjectOptions): Promise<ProjectResult>;
/** Assemble the manifest from persisted chapter records. */
export declare function buildManifest(input: {
    state: ProjectState;
    outline: Map<string, OutlineChapter>;
    title: string;
    now: () => Date;
}): Manifest;
/** Re-exported so a caller can type a fake synthesizer without the host. */
export type { SynthResult, Synthesizer };
//# sourceMappingURL=pipeline.d.ts.map