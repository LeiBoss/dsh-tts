/**
 * Publish the engine as an injectable cordis service (`ctx.tts`).
 *
 * Registration is best-effort by design: an older or unusual host that cannot
 * provide a service must still get the tools, so a failure here is logged and
 * swallowed rather than thrown at mount time.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './config.ts'
import { TtsService } from './service.ts'

/** The subset of cordis this module needs, kept structural for host versions. */
interface ServiceHost {
  provide?: (name: string, value?: unknown) => unknown
  set?: (name: string, value: unknown) => unknown
  get?: (name: string) => unknown
}

/**
 * Mount `ctx.tts`. Returns the service when it is reachable through the host
 * registry, or undefined when the host has no service seam.
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
    } else if (typeof host.set === 'function') {
      host.set('tts', service)
    } else {
      return undefined
    }

    // Some cordis versions only declare the name and expect an assignment.
    const registered = typeof host.get === 'function' ? host.get('tts') : undefined
    if (registered === undefined) {
      ;(ctx as unknown as Record<string, unknown>).tts = service
    }
    return service
  } catch {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('@leiboss/dsh-tts') : undefined
    logger?.warn?.('Could not expose ctx.tts; the tools are still registered.')
    return undefined
  }
}
