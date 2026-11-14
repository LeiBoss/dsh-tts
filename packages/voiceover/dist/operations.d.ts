import { type PipelineDeps, type ProjectState, type StyleProfile } from './pipeline.ts';
/** Everything needed to reproduce a project run from persisted state. */
export interface RerunPlan {
    text: string;
    title: string;
    voice: string;
    rate: string;
    style: StyleProfile;
    network: boolean;
}
/** Result of one rerun. */
export interface RerunResult {
    projectId: string;
    state: ProjectState;
    /** Chapters that were already done and therefore skipped. */
    skipped: string[];
}
/**
 * Rebuild the run options for an existing project from what it persisted.
 *
 * The source text comes from `source/normalized.md` (not from the caller), so a
 * rerun cannot silently use a different document.
 */
export declare function loadRerunPlan(outputDir: string, projectId: string): Promise<{
    plan: RerunPlan;
    state: ProjectState;
} | undefined>;
/**
 * Resume a project: every finished chapter is skipped, failed or missing ones
 * run again. Refuses when the project key no longer matches, because writing
 * into a directory that other settings produced would mix two projects.
 */
export declare function rerunProject(deps: PipelineDeps, input: {
    outputDir: string;
    projectId: string;
    auditSample?: number;
    signal?: AbortSignal;
    /** Restrict the rerun to these chapters; omitted means "every unfinished one". */
    chapters?: readonly string[];
}): Promise<RerunResult>;
//# sourceMappingURL=operations.d.ts.map