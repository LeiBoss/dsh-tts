/**
 * Operations shared by every caller.
 *
 * `user-actions.md` requires one implementation per operation: the agent Tool and
 * the panel button must not each own a copy of the logic. Both reach the
 * functions here — the Tool directly, the panel through a POST route — so a
 * rerun behaves identically whichever way the user asks for it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runProject } from "./pipeline.js";
import { readJson } from "./util.js";
/** Matches project ids: the first 12 hex characters of a content hash. */
const PROJECT_ID = /^[0-9a-f]{8,24}$/;
/**
 * Rebuild the run options for an existing project from what it persisted.
 *
 * The source text comes from `source/normalized.md` (not from the caller), so a
 * rerun cannot silently use a different document.
 */
export async function loadRerunPlan(outputDir, projectId) {
    if (!PROJECT_ID.test(projectId))
        return undefined;
    const projectDir = join(outputDir, projectId);
    const state = await readJson(join(projectDir, 'state', 'state.json'));
    if (state === undefined)
        return undefined;
    let text;
    try {
        text = await readFile(join(projectDir, 'source', 'normalized.md'), 'utf8');
    }
    catch {
        return undefined;
    }
    // Old states predate `style`; the default is the same one the pipeline uses,
    // so a project created before this field existed can still resume.
    const style = (state.style ?? 'news');
    return {
        state,
        plan: {
            text,
            title: state.outline.title,
            voice: state.engine.voice,
            rate: state.engine.rate,
            style,
            network: state.capability.network,
        },
    };
}
/**
 * Resume a project: every finished chapter is skipped, failed or missing ones
 * run again. Refuses when the project key no longer matches, because writing
 * into a directory that other settings produced would mix two projects.
 */
export async function rerunProject(deps, input) {
    const loaded = await loadRerunPlan(input.outputDir, input.projectId);
    if (loaded === undefined)
        throw new Error(`Unknown project: ${input.projectId}`);
    const { plan } = loaded;
    const result = await runProject(deps, {
        outputDir: input.outputDir,
        title: plan.title,
        text: plan.text,
        voice: plan.voice,
        rate: plan.rate,
        style: plan.style,
        network: plan.network,
        auditSample: input.auditSample ?? 2,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (result.projectId !== input.projectId) {
        throw new Error(`Project ${input.projectId} can no longer be resumed: its prompt or settings changed and the key now resolves to ${result.projectId}. Create a new project instead.`);
    }
    return { projectId: result.projectId, state: result.state, skipped: result.skipped };
}
//# sourceMappingURL=operations.js.map