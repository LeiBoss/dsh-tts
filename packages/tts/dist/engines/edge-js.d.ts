/** One word boundary as Edge reports it. */
export interface EdgeJsWord {
    text: string;
    offsetMs: number;
    durationMs: number;
}
/** One synthesis request. */
export interface EdgeJsRequest {
    text: string;
    voice: string;
    /** `+0%` style, passed through to SSML. */
    rate?: string;
    /** `+0Hz` style. */
    pitch?: string;
    /** `+0%` style. */
    volume?: string;
    /** Forwarded to the WSS handshake; Edge ignores HTTPS_PROXY. */
    proxy?: string;
    timeoutMs?: number;
}
/** Audio plus the timing metadata Edge reports for it. */
export interface EdgeJsResult {
    audio: Buffer;
    words: EdgeJsWord[];
}
/** The shape `node-edge-tts` exposes; kept structural so the version can drift. */
interface EdgeJsInstance {
    streamAudio(text: string): AsyncGenerator<Buffer | {
        part: string;
        start: number;
        end: number;
    }>;
    ttsPromise(text: string, audioPath: string): Promise<void>;
}
interface EdgeJsModule {
    EdgeTTS: new (config: Record<string, unknown>) => EdgeJsInstance;
}
/** Replace the module loader. Tests inject a fake; production clears it. */
export declare function setEdgeJsLoader(impl: (() => Promise<unknown>) | undefined): void;
/** Load the optional dependency, or report that it is not installed. */
export declare function loadEdgeJsModule(): Promise<EdgeJsModule | undefined>;
/** Whether the pure-JS backend can be used in this process. */
export declare function isEdgeJsAvailable(): Promise<boolean>;
/**
 * Synthesize once and collect audio plus word boundaries. Word offsets are
 * absolute from the start of this call's audio, which is what callers need to
 * shift per chunk.
 */
export declare function synthesizeWithEdgeJs(request: EdgeJsRequest): Promise<EdgeJsResult>;
export {};
//# sourceMappingURL=edge-js.d.ts.map