# Host verification (2026-11-12)

What was verified, against which host, and what it changed. This is the evidence
behind the "host-verified" rows in the root README.

## Environment

| Item | Value |
|---|---|
| DSH | `0.2.2-rc.1` (desktop distribution) |
| Host Node | `v24.21.0` (bundled runtime) |
| cordis | `4.1.0` (peer range `>=4.1.0 <5`) |
| Profile | throwaway `headless` profile under `$DSH_HOME/profiles` |
| Installed | `@leiboss/dsh-tts@0.3.0`, `@leiboss/dsh-voiceover@0.1.0`, `dsh-tts-host-probe@0.0.0` |

Reproduce with [`scripts/host-probe/run.ps1`](../scripts/host-probe/run.ps1).

## What passed

| Check | Result |
|---|---|
| Bundle patch composes (`--dump-config` shows both layers) | pass |
| Module loads from the installed tarball | pass |
| `inject: ['tools','tts']` waits for the engine, then applies | pass |
| `ctx.provide('tts', service)` inside `apply` publishes the service | pass |
| `ctx.get('tts')` returns it, with `synthesize()` callable | pass |
| Exactly one set of tools registered (6 tools, no duplicates) | pass |
| Real synthesis through the pure-JS backend (`engine: edge-js`) | pass |
| Exact duration from MP3 frame parsing (`durationMs: 6384`) | pass |
| Word boundaries returned on a cache miss (`words: 15`) | pass |
| Cache hit keeps word boundaries (`fromCache: true`, `words: 15`, 3.4s -> 0.24s) | pass |

The boot itself ends with `MISSING_CREDENTIAL` because a fresh headless profile
has no model key. That is expected: every assertion above is settled during the
mount phase, before any model call. Use `DEEPSEEK_API_KEY` if you also want the
agent to run a task.

## What the host run changed

Four defects only a real host could surface. All are fixed.

### 1. `ctx.tts` was registered with a property assignment fallback

`register-service.ts` used to call `ctx.provide('tts', service)` and then, if
`ctx.get('tts')` looked empty, assign `ctx.tts = service`. Cordis 4.x resolves
`ctx.tts` through the service store, so the assignment was both unnecessary and
wrong (it can shadow the store). Removed; `provide` is now the only path.

### 2. Installing both packages mounted the engine twice

Both patches inserted an engine entry (`voiceover-tts` and `dsh-tts`). Two
entries meant two mounts: a second `ctx.provide('tts')` in the same scope throws,
and the tools would register twice. The product's patch now reuses the engine's
own id (`dsh-tts`); the loader merges entries by id, and the composed tree shows
one effective mount (verified by the tool count staying at 6).

### 3. Word boundaries were silently unavailable

Edge returns `WordBoundary` metadata, but `node-edge-tts` only parses it when
`saveSubtitles: true` is passed to the constructor. `streamAudio()` yields the
boundaries and writes no files, so enabling it is free. Without it every
subtitle would have been `estimated` despite an `exact` engine.

### 4. A cache hit dropped word boundaries

The cache sidecar stored engine/voice/rate/pitch/volume but not the timings, so
re-running a cached chapter downgraded subtitles from `exact` to `estimated`.
Word timings are now persisted in `CacheMetadata` and returned on a cache hit.

## Not covered

- Agent-level end to end (model picks the tool and calls it): needs a model key.
- Client UI: the voiceover plugin ships no client entry yet.
- `voiceover serve` / MCP: not implemented.