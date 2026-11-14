import type { ConnectionFence, HttpRouteRegistrar } from './http-types.ts';
import { type ProjectSnapshot } from './snapshot.ts';
export type { ConnectionFence, RegisterableRoute, HttpRouteRegistrar } from './http-types.ts';
export type { ProjectSnapshot as PanelSnapshot, SnapshotChapter as PanelChapter } from './snapshot.ts';
/** Path prefix owned by this plugin. */
export declare const PANEL_ROUTE_PREFIX = "/voiceover/panel";
/** Injection points; tests pass a fake host. */
export interface PanelRouteOptions {
    outputDir: string;
    connection?: ConnectionFence;
    /** Resolves one chapter's audio file to a signed URL, when a route is mounted. */
    audioUrlFor?: (filePath: string) => string | undefined;
    /**
     * Resume a project. The panel's button and the `voiceover_rerun` Tool both
     * call the same implementation through this hook.
     */
    onRerun?: (projectId: string) => void | Promise<void>;
    debug?: (message: string) => void;
}
/** Serve one project's persisted progress as JSON. */
export declare class PanelRoute {
    private readonly options;
    constructor(options: PanelRouteOptions);
    /** Build a snapshot from `state/state.json`; undefined when unknown. */
    snapshot(projectId: string): Promise<ProjectSnapshot | undefined>;
    /** Register on the host router; the disposer unregisters the route. */
    register(server: HttpRouteRegistrar): () => void;
    /** Handle one request. Never throws: every path answers or closes. */
    private handle;
    /** Write one JSON response with no caching. */
    private answer;
}
//# sourceMappingURL=panel.d.ts.map