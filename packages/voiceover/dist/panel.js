import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson } from "./util.js";
/** Path prefix owned by this plugin. */
export const PANEL_ROUTE_PREFIX = '/voiceover/panel';
/** Project ids are the first 12 hex characters of a content hash. */
const PROJECT_ID = /^[0-9a-f]{8,24}$/;
/** Serve one project's persisted progress as JSON. */
export class PanelRoute {
    options;
    constructor(options) {
        this.options = options;
    }
    /** Build a snapshot from `state/state.json`; undefined when unknown. */
    async snapshot(projectId) {
        if (!PROJECT_ID.test(projectId))
            return undefined;
        const stateFile = join(this.options.outputDir, projectId, 'state', 'state.json');
        const state = await readJson(stateFile);
        if (state === undefined)
            return undefined;
        // The panel shows "last write" so a stalled run is visible. A request time
        // here would always look fresh and hide exactly that condition.
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
            capability: state.capability,
            engine: state.engine,
            chapters: chapters.map((chapter) => ({
                id: chapter.id,
                order: chapter.order,
                title: chapter.title,
                status: chapter.status,
                ...(chapter.audio === undefined ? {} : { durationMs: chapter.audio.durationMs }),
                ...(chapter.subtitles === undefined ? {} : { subtitles: chapter.subtitles.path }),
                ...(chapter.error === undefined ? {} : { error: chapter.error.code }),
            })),
            warnings: state.warnings.slice(0, 5),
            warningCount: state.warnings.length,
            stateUpdatedAt,
            servedAt: new Date().toISOString(),
        };
    }
    /** Register on the host router; the disposer unregisters the route. */
    register(server) {
        return server.register({
            kind: 'prefix',
            path: PANEL_ROUTE_PREFIX,
            handler: (req, res) => this.handle(req, res),
        });
    }
    /** Handle one request. Never throws: every path answers or closes. */
    async handle(req, res) {
        if (req.method !== 'GET') {
            this.answer(res, 405, { error: 'method not allowed' });
            return;
        }
        const rejection = this.options.connection?.requestRejection?.({ headers: req.headers });
        if (rejection !== undefined) {
            this.answer(res, rejection, { error: 'unauthorized' });
            return;
        }
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        if (!path.startsWith(`${PANEL_ROUTE_PREFIX}/`)) {
            this.answer(res, 404, { error: 'not found' });
            return;
        }
        const name = path.slice(PANEL_ROUTE_PREFIX.length + 1);
        const match = /^([0-9a-f]{8,24})\.json$/.exec(name);
        if (match === null) {
            this.answer(res, 400, { error: 'expected /<projectId>.json' });
            return;
        }
        const projectId = match[1] ?? '';
        const snapshot = await this.snapshot(projectId);
        if (snapshot === undefined) {
            this.answer(res, 404, { error: 'unknown project' });
            return;
        }
        this.options.debug?.(`panel served ${projectId}`);
        this.answer(res, 200, snapshot);
    }
    /** Write one JSON response with no caching. */
    answer(res, status, body) {
        if (res.headersSent) {
            res.end();
            return;
        }
        const payload = `${JSON.stringify(body)}\n`;
        res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(payload),
        });
        res.end(payload);
    }
}
//# sourceMappingURL=panel.js.map