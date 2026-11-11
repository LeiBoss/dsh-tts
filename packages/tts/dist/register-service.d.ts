/**
 * Publish the engine as an injectable cordis service (`ctx.tts`).
 *
 * Registration is best-effort by design: an older or unusual host that cannot
 * provide a service must still get the tools, so a failure here is logged and
 * swallowed rather than thrown at mount time.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedConfig } from './config.ts';
import { TtsService } from './service.ts';
/**
 * Mount `ctx.tts`. Returns the service when it is reachable through the host
 * registry, or undefined when the host has no service seam.
 */
export declare function mountTtsService(ctx: Context, config: ResolvedConfig): TtsService | undefined;
//# sourceMappingURL=register-service.d.ts.map