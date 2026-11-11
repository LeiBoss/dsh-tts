import { TtsService } from "./service.js";
/**
 * Mount `ctx.tts`. Returns the service when it is reachable through the host
 * registry, or undefined when the host has no service seam.
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
        }
        else if (typeof host.set === 'function') {
            host.set('tts', service);
        }
        else {
            return undefined;
        }
        // Some cordis versions only declare the name and expect an assignment.
        const registered = typeof host.get === 'function' ? host.get('tts') : undefined;
        if (registered === undefined) {
            ;
            ctx.tts = service;
        }
        return service;
    }
    catch {
        const logger = typeof ctx.logger === 'function' ? ctx.logger('@leiboss/dsh-tts') : undefined;
        logger?.warn?.('Could not expose ctx.tts; the tools are still registered.');
        return undefined;
    }
}
//# sourceMappingURL=register-service.js.map