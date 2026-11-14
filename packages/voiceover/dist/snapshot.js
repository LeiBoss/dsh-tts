/**
 * One builder for the project snapshot, shared by the conversation panel and
 * the daemon API. Reimplementing this per surface is how two views drift apart
 * and start disagreeing about which chapters are done.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson } from "./util.js";
/** Project ids are the first hex characters of a content hash. */
export const PROJECT_ID = /^[0-9a-f]{8,24}$/;
/**
 * Read one project's persisted progress. Returns undefined for an unknown or
 * malformed id, and never reads outside `<outputDir>/<projectId>`.
 */
export async function projectSnapshot(outputDir, projectId, options = {}) {
    if (!PROJECT_ID.test(projectId))
        return undefined;
    const stateFile = join(outputDir, projectId, 'state', 'state.json');
    const state = await readJson(stateFile);
    if (state === undefined)
        return undefined;
    // The panel and the API show "last write" so a stalled run is visible; a
    // request time here would always look fresh and hide exactly that condition.
    let stateUpdatedAt = new Date(0).toISOString();
    try {
        stateUpdatedAt = (await stat(stateFile)).mtime.toISOString();
    }
    catch {
        // Keep the epoch fallback: "unknown" must not claim freshness.
    }
    const chapters = [...state.chapters].sort((a, b) => a.order - b.order);
    const done = chapters.filter((chapter) => chapter.status === 'done').length;
    const failed = chapters.filter((chapter) => chapter.status === 'failed').length;
    return {
        projectId,
        title: state.outline.title,
        done,
        total: state.outline.chapters.length,
        pending: Math.max(0, state.outline.chapters.length - done - failed),
        failed,
        // The state records what was true when planning started; the chapters know
        // the truth now. Reporting the stale value would make the panel claim
        // "estimated" while every chapter has exact timing.
        capability: {
            ...state.capability,
            timingQuality: chapters.length === 0
                ? state.capability.timingQuality
                : done === 0
                    ? 'none'
                    : chapters
                        .filter((chapter) => chapter.status === 'done')
                        .every((chapter) => chapter.audio?.timingQuality === 'exact')
                        ? 'exact'
                        : 'estimated',
        },
        engine: state.engine,
        chapters: chapters.map((chapter) => {
            const row = {
                id: chapter.id,
                order: chapter.order,
                title: chapter.title,
                status: chapter.status,
                ...(chapter.audio === undefined ? {} : { durationMs: chapter.audio.durationMs, audio: chapter.audio.path }),
                ...(chapter.subtitles === undefined ? {} : { subtitles: chapter.subtitles.path }),
                ...(chapter.error === undefined ? {} : { error: chapter.error.code }),
            };
            // Playback URLs are minted per request: they expire, and they only exist
            // while a route is mounted.
            if (chapter.audio !== undefined && options.audioUrlFor !== undefined) {
                const url = options.audioUrlFor(join(outputDir, projectId, chapter.audio.path));
                if (url !== undefined)
                    row.audioUrl = url;
            }
            return row;
        }),
        warnings: state.warnings.slice(0, 5),
        warningCount: state.warnings.length,
        stateUpdatedAt,
        servedAt: new Date().toISOString(),
    };
}
//# sourceMappingURL=snapshot.js.map