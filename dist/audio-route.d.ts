import type { IncomingMessage, ServerResponse } from 'node:http';
/** Path prefix owned by this plugin. The signed token is the next segment. */
export declare const AUDIO_ROUTE_PREFIX = "/dsh-tts/audio";
/** Signed URLs stay valid for six hours by default. */
export declare const DEFAULT_URL_TTL_MS: number;
/** Structural view of a DSH web route registration. */
export interface RegisterableRoute {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
/** Structural view of `ctx.httpServer`; only `register` is used. */
export interface HttpRouteRegistrar {
    register(route: RegisterableRoute): () => void;
    /** Advertised bind host, when the host exposes it. */
    host?: string;
    /** Actual listening port, when the host exposes it. */
    port?: number;
}
/** Resolves a local audio path to a browser-openable URL, when routable. */
export interface AudioUrlProvider {
    urlFor(filePath: string): string | undefined;
}
export interface AudioRouteOptions {
    /** Ledger root; tokens may only name files beneath it. */
    outputDir: string;
    /** Token lifetime in milliseconds. */
    ttlMs?: number;
    /** Override the per-instance HMAC secret (tests only). */
    secret?: Buffer;
    /** Injectable clock in epoch milliseconds. */
    now?: () => number;
    /** Hostnames allowed in `Host`; unset means any hostname (port still checked). */
    allowedHosts?: readonly string[];
    /** Expected listen port; mismatched `Host` ports are rejected. */
    expectedPort?: number;
    /** Debug sink for origin rejections; receives no token or path. */
    debug?: (message: string) => void;
}
/**
 * Owns the signed-token format and the HTTP handler. One instance per plugin
 * load; `register` binds it to the host router and returns a disposer.
 */
export declare class AudioRoute implements AudioUrlProvider {
    private readonly root;
    private readonly ttlMs;
    private readonly secret;
    private readonly now;
    private readonly debug?;
    private allowedHosts?;
    private expectedPort?;
    private active;
    constructor(options: AudioRouteOptions);
    /** True once the host router accepted the route. */
    get registered(): boolean;
    /** Register on the DSH host router; the disposer unregisters and disables URLs. */
    register(server: HttpRouteRegistrar): () => void;
    /**
     * Browser-openable same-origin URL, or `undefined` when the route is not
     * registered or the file is outside the output directory / not an MP3.
     */
    urlFor(filePath: string): string | undefined;
    /** Serve one request. Exported behaviour is exercised directly by tests. */
    handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
    /** HMAC-SHA-256 over the payload, base64url-encoded. */
    private sign;
    /**
     * Same-origin fence in front of the token check. Returns a reason when the
     * request must be rejected. Missing headers are tolerated only when neither
     * a port nor an Origin pins the request to a browser origin, which keeps
     * non-browser callers working while DSH provides no trust-fence API.
     */
    private checkOrigin;
    /** Path relative to the ledger root, using `/` on every platform. */
    private relativePath;
    /** Verify signature + expiry, then confine the decoded path to the root. */
    private verify;
}
//# sourceMappingURL=audio-route.d.ts.map