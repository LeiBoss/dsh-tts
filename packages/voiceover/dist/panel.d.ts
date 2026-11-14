/**
 * Read-only JSON endpoint behind the conversation panel.
 *
 * The panel cannot read structured tool return values (a tool result exposes
 * only its rendered text), and polling a Tool would fight the conversation. So
 * the panel parses the project id out of the rendered result and polls this
 * route instead, which reads the same persisted `state.json` the pipeline
 * writes.
 *
 * Security matches the engine's audio route: the host's connection fence runs
 * first, the path is strictly `<prefix>/<projectId>.json`, and nothing outside
 * the project state file is readable.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Capability, ChapterStatus, EngineInfo } from './types.ts';
/** Path prefix owned by this plugin. */
export declare const PANEL_ROUTE_PREFIX = "/voiceover/panel";
/** Structural view of a DSH web route registration. */
export interface RegisterableRoute {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
/** Structural view of the host `webServer` service; only `register` is used. */
export interface HttpRouteRegistrar {
    register(route: RegisterableRoute): () => void;
}
/** Structural view of the host connection fence. */
export interface ConnectionFence {
    requestRejection?(input: {
        headers: Record<string, string | string[] | undefined>;
    }): 401 | 403 | undefined;
}
/** One chapter row as the panel needs it. */
export interface PanelChapter {
    id: string;
    order: number;
    title: string;
    status: ChapterStatus;
    durationMs?: number;
    subtitles?: string;
    error?: string;
    /** Signed, session-bound playback URL; absent when no audio route is mounted. */
    audioUrl?: string;
}
/** What the panel renders. Deliberately small: no script text, no file paths. */
export interface PanelSnapshot {
    projectId: string;
    title: string;
    done: number;
    total: number;
    /** Chapters that still need work; the panel keeps polling while this is > 0. */
    pending: number;
    failed: number;
    capability: Capability;
    engine: EngineInfo;
    chapters: PanelChapter[];
    warnings: string[];
    /** Total warnings recorded; `warnings` is capped for the panel. */
    warningCount: number;
    /** mtime of `state.json`: the last time the pipeline actually wrote progress. */
    stateUpdatedAt: string;
    /** When this snapshot was served; not a progress fact. */
    servedAt: string;
}
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
    snapshot(projectId: string): Promise<PanelSnapshot | undefined>;
    /** Register on the host router; the disposer unregisters the route. */
    register(server: HttpRouteRegistrar): () => void;
    /** Handle one request. Never throws: every path answers or closes. */
    private handle;
    /** Write one JSON response with no caching. */
    private answer;
}
//# sourceMappingURL=panel.d.ts.map