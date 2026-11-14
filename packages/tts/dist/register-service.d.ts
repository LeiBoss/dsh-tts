/**
 * Publish the engine as an injectable cordis service (`ctx.tts`).
 *
 * Cordis contract (verified against @deepseek-ai/cordis 4.1.0):
 * - `ctx.provide(name, value)` registers an implementation owned by the current
 *   fiber; it becomes visible as soon as the fiber is active and is removed when
 *   the fiber unloads. No explicit cleanup is needed on the plugin side.
 * - `ctx.get(name)` reads it back, including from the same fiber.
 * - `provide` throws if the name is already provided in this isolation scope
 *   (e.g. the user installed both the standalone `@leiboss/dsh-tts` and the
 *   engine mounted by `@leiboss/dsh-voiceover`). The first provider wins.
 *
 * Registration is best-effort by design: a host that cannot provide a service
 * must still get the tools, so a failure here is logged and swallowed rather
 * than thrown at mount time.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedConfig } from './config.ts';
import { TtsService } from './service.ts';
/**
 * Mount `ctx.tts`. Returns the service when it was registered, or undefined
 * when the host has no service seam or the name was already taken.
 */
export declare function mountTtsService(ctx: Context, config: ResolvedConfig): TtsService | undefined;
//# sourceMappingURL=register-service.d.ts.map