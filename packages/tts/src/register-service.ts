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
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './config.ts'
import { TtsService } from './service.ts'

/** The subset of cordis this module needs, kept structural for host versions. */
interface ServiceHost {
  provide?: (name: string, value?: unknown) => unknown
  set?: (name: string, value: unknown) => unknown
}

/**
 * Mount `ctx.tts`. Returns the service when it was registered, or undefined
 * when the host has no service seam or the name was already taken.
 */
export function mountTtsService(ctx: Context, config: ResolvedConfig): TtsService | undefined {
  const service = new TtsService(config, {
    log: (message) => {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('@leiboss/dsh-tts') : undefined
      logger?.debug?.(message)
    },
  })
  const host = ctx as unknown as ServiceHost

  try {
    if (typeof host.provide === 'function') {
      host.provide('tts', service)
      return service
    }
    if (typeof host.set === 'function') {
      // Legacy fallback: only valid when a prior provider already registered
      // the name. Never used on cordis 4.x, which always has `provide`.
      host.set('tts', service)
      return service
    }
    return undefined
  } catch (error) {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('@leiboss/dsh-tts') : undefined
    logger?.warn?.(
      `Could not expose ctx.tts (${error instanceof Error ? error.message : String(error)}); the tools are still registered.`,
    )
    return undefined
  }
}
