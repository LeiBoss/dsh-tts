/**
 * Optional network diagnostic: a single TCP connection to the Edge-TTS
 * endpoint. It never synthesizes audio and never performs a WebSocket
 * handshake, so it is cheap and does not consume service quota.
 *
 * This deliberately lives outside `tts_self_check`, which must stay offline.
 */
import { type Socket } from 'node:net';
/** The only endpoint shipped by edge-tts 7.3.1. */
export declare const PROBE_HOST = "speech.platform.bing.com";
export declare const PROBE_PORT = 443;
/** Default and hard upper bound for one probe. */
export declare const DEFAULT_PROBE_TIMEOUT_MS = 1500;
export declare const MAX_PROBE_TIMEOUT_MS = 5000;
export type ProbeConnector = (options: {
    host: string;
    port: number;
}) => Socket;
export interface ProbeOptions {
    /** Defaults to {@link PROBE_HOST}; tests use a local listener. */
    host?: string;
    /** Defaults to {@link PROBE_PORT}. */
    port?: number;
    /** Clamped to [1, {@link MAX_PROBE_TIMEOUT_MS}]; defaults to 1500. */
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Injected connector, so tests never touch the real network. */
    connectImpl?: ProbeConnector;
}
export interface ProbeResult {
    host: string;
    port: number;
    /** True only when the TCP handshake completed before the timeout. */
    reachable: boolean;
    elapsedMs: number;
}
/**
 * Attempt one TCP connection and report reachability. Failures — timeouts,
 * refusals, DNS errors — resolve with `reachable: false` instead of throwing.
 */
export declare function probeEndpoint(options?: ProbeOptions): Promise<ProbeResult>;
//# sourceMappingURL=probe.d.ts.map