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
/** Structural view of the host `webServer` service; only `register` is used. */
export interface HttpRouteRegistrar {
    register(route: RegisterableRoute): () => void;
    /** Advertised bind host, when the host exposes it. */
    host?: string;
    /** Actual listening port, when the host exposes it. */
    port?: number;
    /** Scheme advertised by the host, when available. */
    protocol?: string;
    /** Origin advertised by the host, when available. */
    getOrigin?(): string | undefined;
}
/**
 * Host-provided trust fence. DSH 0.2.2 exposes this as `ctx.connection`;
 * `admit` is intentionally not used so links remain shareable to a browser
 * that has no DSH session cookie.
 */
export interface ConnectionFence {
    requestRejection?(input: {
        headers: Record<string, string | string[] | undefined>;
    }): 401 | 403 | undefined;
    allowsRemoteAuthorities?: boolean;
}
/** Name of the persisted HMAC secret inside the output directory. */
export declare const SECRET_FILE_NAME = ".audio-route-secret";
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
    /** Path of the persisted secret; defaults to `<outputDir>/.audio-route-secret`. */
    secretPath?: string;
    /** Injectable clock in epoch milliseconds. */
    now?: () => number;
    /** Hostnames allowed in `Host`; unset means any hostname (port still checked). */
    allowedHosts?: readonly string[];
    /** Expected listen port; mismatched `Host` ports are rejected. */
    expectedPort?: number;
    /** Debug sink for origin rejections; receives no token or path. */
    debug?: (message: string) => void;
    /** Extra trusted Host names (reverse proxies); disables port pinning. */
    trustedHosts?: readonly string[];
    /** Host trust fence, when DSH exposes `ctx.connection`. */
    connection?: ConnectionFence;
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
    private readonly trustedHosts;
    private readonly connection?;
    private allowedHosts?;
    private expectedPort?;
    private skipPortCheck;
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