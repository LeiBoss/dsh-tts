import type { Capability, ChapterStatus, EngineInfo } from './types.ts';
/** Project ids are the first hex characters of a content hash. */
export declare const PROJECT_ID: RegExp;
/** One chapter row. */
export interface SnapshotChapter {
    id: string;
    order: number;
    title: string;
    status: ChapterStatus;
    durationMs?: number;
    subtitles?: string;
    error?: string;
    /** Relative audio path; the caller decides whether it is servable. */
    audio?: string;
    /** Playback URL, only when the caller supplied a minting function. */
    audioUrl?: string;
}
/** What both surfaces render/serve. */
export interface ProjectSnapshot {
    projectId: string;
    title: string;
    done: number;
    total: number;
    /** Chapters that still need work. */
    pending: number;
    failed: number;
    capability: Capability;
    engine: EngineInfo;
    chapters: SnapshotChapter[];
    warnings: string[];
    /** Total warnings recorded; `warnings` is capped. */
    warningCount: number;
    /** mtime of `state.json`: the last time the pipeline actually wrote progress. */
    stateUpdatedAt: string;
    /** When this snapshot was served; not a progress fact. */
    servedAt: string;
}
/** Options for {@link projectSnapshot}. */
export interface SnapshotOptions {
    /** Mints a playback URL for a chapter's audio file, when a route exists. */
    audioUrlFor?: (filePath: string) => string | undefined;
}
/**
 * Read one project's persisted progress. Returns undefined for an unknown or
 * malformed id, and never reads outside `<outputDir>/<projectId>`.
 */
export declare function projectSnapshot(outputDir: string, projectId: string, options?: SnapshotOptions): Promise<ProjectSnapshot | undefined>;
//# sourceMappingURL=snapshot.d.ts.map