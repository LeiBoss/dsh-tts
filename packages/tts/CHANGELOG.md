# Changelog

## 0.3.0

- `AudioRoute` accepts a `prefix` option (default unchanged). A consumer such as the
  voiceover plugin reuses the route under its own path instead of contending for
  `/dsh-tts/audio`.

- The pure-JS backend now returns word boundaries: `node-edge-tts` only parses
  `WordBoundary` metadata when `saveSubtitles` is set, and `streamAudio()` writes
  no files, so the adapter enables it unconditionally.
- Persist word timings in the cache sidecar and return them on a cache hit;
  previously a cached chapter silently downgraded subtitles to `estimated`.
- `capabilities.wordBoundaries` is now conservative (false until the backend is
  resolved) instead of assuming a non-CLI engine.

- Add the pure-JS backend (`src/engines/edge-js.ts`, optional `node-edge-tts`):
  no Python, and it returns word boundaries, which upgrades subtitle timing
  from `estimated` to `exact`. Word offsets are shifted per chunk so chunked
  long text keeps absolute timing.
- Add `engine: auto | edge-js | edge-py | sapi` (default `auto`, resolved once
  per service instance) and surface `words` on `TtsAudioResult`.

- Add `TtsService` (`@leiboss/dsh-tts/service`): one orchestrator over cache,
  concurrency, chunking, and the fallback chain, returning structured audio
  facts (`durationMs`, `timingQuality`, `engine`, `fromCache`).
- Publish the engine as `ctx.tts` on mount (`inject: ['tts']` in consumers).
  Registration is best-effort: a host without a service seam still gets the
  tools.
- Add pure-JS MP3 duration measurement (`src/audio/mp3-duration.ts`), so
  duration and subtitle timing never require ffmpeg.
- Fix a cache-key gap: `pitch` and `volume` now participate in the synthesis
  key, so two calls that differ only in prosody no longer share a file.

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-11-11

### Added

- Inline client player: `tts_generate` results render a native `<audio controls>` in DSH Web.
- `tts_probe_network` tool for TCP reachability checks against the Edge-TTS endpoint.
- `proxy` config forwarded to Edge-TTS as `--proxy`; `tts_self_check` reports `proxyConfigured`.
- `fallbackReason` reporting the engine chain when synthesis falls back to `speechSynthesis`.

### Fixed

- SAPI fallback wrote to `*.mp3.partial`, so ffmpeg could not infer the container and the chain
  always fell through to `speechSynthesis`; the partial file now ends in `.mp3`.
- Corrected README claims about link shareability and playback rendering.

## [0.2.0] - 2026-11-11

### Added

- Edge-TTS synthesis that writes a playable MP3 to disk.
- Ten built-in voices, listed by `tts_self_check.availableVoices`.
- Long-text synthesis: split on sentence boundaries, synthesize chunks serially,
  concatenate them into a single MP3.
- Fallback chain: Edge-TTS, then SAPI on Windows, then a `speechSynthesis` marker
  for the caller to read aloud.
- Concurrency limit with a waiting queue and `TTS_BUSY` backpressure.
- Signed playback route: HTTP Range (206/416), byte-range serving, same-origin
  checks, and a signing secret persisted across reloads.
- `totalTimeoutMs`, a budget for the whole `tts_generate` call.
- Cache sidecar recording which engine produced each cached file.
- Optional `trustedHosts` for reverse-proxy and remote access setups.
- `tts_self_check` diagnostics for the runtime, sandbox and output directory.
- Plugin manifest metadata: localized title/description and an icon.

### Changed

- Package name migrated from the bare `dsh-tts` to `@leiboss/dsh-tts`. The host
  entry id stays `dsh-tts`, so existing profile configuration keeps working.
- Tool results render a clickable absolute playback link; the JSON
  `browserUrl` field remains a same-origin relative path.
- `pitch` and `volume` are validated before any subprocess starts.
- Trust checks prefer `ctx.connection.requestRejection` when the host provides it.

### Fixed

- Injecting the nonexistent `httpServer` service left `browserUrl` permanently
  undefined; the plugin now uses `webServer`, with an `httpServer` fallback.
- Hosts that do not export `DSH_HOME` had no output directory at all; the
  default now falls back to `~/.dsh/tts-output`.
- Merged in-flight requests reused the first caller's abort signal, so one
  cancellation failed every waiter.
- `engines.dsh: >=0.2.2` excluded the prerelease runtime `0.2.2-rc.1`, which
  rejected every installation; the range is now `>=0.2.2-rc.1`.

### Removed

- `durationMs` from the tool output schema. It was declared but never produced.

### Security

- Playback tokens are HMAC-signed and expire.
- The signing secret persists in `<outputDir>/.audio-route-secret`; deleting it
  rotates every previously issued link.
- Route requests prefer the host's Host/Origin and browser authentication checks.

[0.2.1]: https://github.com/leiboss/dsh-tts/releases/tag/v0.2.1
[0.2.0]: https://github.com/leiboss/dsh-tts/releases/tag/v0.2.0
