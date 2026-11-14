/**
 * Structural views of the host's HTTP seams.
 *
 * Kept in one module so the panel route, the audio route, and the daemon agree
 * on the same shapes instead of each declaring its own near-copy.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** One route registration understood by the host router. */
export interface RegisterableRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** Structural view of the host `webServer` service; only `register` is used. */
export interface HttpRouteRegistrar {
  register(route: RegisterableRoute): () => void
  getOrigin?(): string | undefined
}

/** Structural view of the host connection fence. */
export interface ConnectionFence {
  requestRejection?(input: { headers: Record<string, string | string[] | undefined> }): 401 | 403 | undefined
  allowsRemoteAuthorities?: boolean
}
