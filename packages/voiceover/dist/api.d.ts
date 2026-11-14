import type { StyleProfile } from './pipeline.ts';
/** Collaborators the API needs; the CLI wires them to the real pipeline. */
export interface ApiContext {
    outputDir: string;
    token: string;
    version: string;
    startedAt: number;
    synthesize(input: {
        text: string;
        voice?: string;
        rate?: string;
    }): Promise<{
        filePath: string;
        format: string;
        durationMs: number;
        timingQuality: 'exact' | 'estimated';
        engine: string;
    }>;
    createProject(input: {
        sourcePath?: string;
        sourceText?: string;
        title?: string;
        voice?: string;
        rate?: string;
        style?: StyleProfile;
    }): Promise<{
        projectId: string;
    }>;
    rerunProject(projectId: string): Promise<void>;
    doctor(): Promise<unknown>;
}
/** One request, already read into memory. */
export interface ApiRequest {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body?: Buffer;
}
/** One response. `body` is always a Buffer so callers can stream it verbatim. */
export interface ApiResponse {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
}
declare const CHAPTER: RegExp;
/**
 * Dispatch one request. Never throws: every failure becomes a JSON response.
 */
export declare function handleRequest(context: ApiContext, request: ApiRequest): Promise<ApiResponse>;
/** Re-exported so the CLI can share the chapter pattern. */
export { CHAPTER };
//# sourceMappingURL=api.d.ts.map