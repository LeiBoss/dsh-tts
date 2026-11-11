/**
 * Optional network diagnostic: a single TCP connection to the Edge-TTS
 * endpoint. It never synthesizes audio and never performs a WebSocket
 * handshake, so it is cheap and does not consume service quota.
 *
 * This deliberately lives outside `tts_self_check`, which must stay offline.
 */
import { connect } from 'node:net';
/** The only endpoint shipped by edge-tts 7.3.1. */
export const PROBE_HOST = 'speech.platform.bing.com';
export const PROBE_PORT = 443;
/** Default and hard upper bound for one probe. */
export const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
export const MAX_PROBE_TIMEOUT_MS = 5_000;
function clampTimeout(value) {
    if (value === undefined || !Number.isFinite(value)) {
        return DEFAULT_PROBE_TIMEOUT_MS;
    }
    return Math.max(1, Math.min(Math.trunc(value), MAX_PROBE_TIMEOUT_MS));
}
/**
 * Attempt one TCP connection and report reachability. Failures — timeouts,
 * refusals, DNS errors — resolve with `reachable: false` instead of throwing.
 */
export function probeEndpoint(options = {}) {
    const host = options.host ?? PROBE_HOST;
    const port = options.port ?? PROBE_PORT;
    const timeoutMs = clampTimeout(options.timeoutMs);
    const connector = options.connectImpl ?? ((address) => connect(address));
    const startedAt = Date.now();
    return new Promise((resolve) => {
        let settled = false;
        let timer;
        let socket;
        const finish = (reachable) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            socket?.destroy();
            resolve({ host, port, reachable, elapsedMs: Date.now() - startedAt });
        };
        const onAbort = () => finish(false);
        try {
            socket = connector({ host, port });
        }
        catch {
            finish(false);
            return;
        }
        timer = setTimeout(() => finish(false), timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        if (options.signal?.aborted) {
            finish(false);
            return;
        }
        options.signal?.addEventListener('abort', onAbort, { once: true });
    });
}
//# sourceMappingURL=probe.js.map