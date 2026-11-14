import { projectSnapshot } from "./snapshot.js";
/** Path prefix owned by this plugin. */
export const PANEL_ROUTE_PREFIX = '/voiceover/panel';
/** Serve one project's persisted progress as JSON. */
export class PanelRoute {
    options;
    constructor(options) {
        this.options = options;
    }
    /** Build a snapshot from `state/state.json`; undefined when unknown. */
    async snapshot(projectId) {
        return projectSnapshot(this.options.outputDir, projectId, {
            ...(this.options.audioUrlFor === undefined ? {} : { audioUrlFor: this.options.audioUrlFor }),
        });
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
        // The fence runs before routing: an unauthenticated request learns nothing
        // about which projects exist.
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
        const snapshotMatch = /^([0-9a-f]{8,24})\.json$/.exec(name);
        if (snapshotMatch !== null) {
            if (req.method !== 'GET') {
                this.answer(res, 405, { error: 'method not allowed' });
                return;
            }
            const projectId = snapshotMatch[1] ?? '';
            const snapshot = await this.snapshot(projectId);
            if (snapshot === undefined) {
                this.answer(res, 404, { error: 'unknown project' });
                return;
            }
            this.options.debug?.(`panel served ${projectId}`);
            this.answer(res, 200, snapshot);
            return;
        }
        const rerunMatch = /^([0-9a-f]{8,24})\/rerun$/.exec(name);
        if (rerunMatch !== null) {
            if (req.method !== 'POST') {
                this.answer(res, 405, { error: 'method not allowed' });
                return;
            }
            const onRerun = this.options.onRerun;
            if (onRerun === undefined) {
                this.answer(res, 501, { error: 'rerun is not available in this host' });
                return;
            }
            const projectId = rerunMatch[1] ?? '';
            const snapshot = await this.snapshot(projectId);
            if (snapshot === undefined) {
                this.answer(res, 404, { error: 'unknown project' });
                return;
            }
            try {
                await onRerun(projectId);
                this.options.debug?.(`panel rerun requested ${projectId}`);
                this.answer(res, 202, { ok: true, projectId });
            }
            catch (error) {
                this.answer(res, 500, {
                    error: error instanceof Error ? error.message.slice(0, 200) : 'rerun failed',
                });
            }
            return;
        }
        this.answer(res, 400, { error: 'expected /<projectId>.json or /<projectId>/rerun' });
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