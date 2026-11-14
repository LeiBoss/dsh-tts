import { TtsService } from "./service.js";
/**
 * Mount `ctx.tts`. Returns the service when it was registered, or undefined
 * when the host has no service seam or the name was already taken.
 */
export function mountTtsService(ctx, config) {
    const service = new TtsService(config, {
        log: (message) => {
            const logger = typeof ctx.logger === 'function' ? ctx.logger('@leiboss/dsh-tts') : undefined;
            logger?.debug?.(message);
        },
    });
    const host = ctx;
    try {
        if (typeof host.provide === 'function') {
            host.provide('tts', service);
            return service;
        }
        if (typeof host.set === 'function') {
            // Legacy fallback: only valid when a prior provider already registered
            // the name. Never used on cordis 4.x, which always has `provide`.
            host.set('tts', service);
            return service;
        }
        return undefined;
    }
    catch (error) {
        const logger = typeof ctx.logger === 'function' ? ctx.logger('@leiboss/dsh-tts') : undefined;
        logger?.warn?.(`Could not expose ctx.tts (${error instanceof Error ? error.message : String(error)}); the tools are still registered.`);
        return undefined;
    }
}
//# sourceMappingURL=register-service.js.map