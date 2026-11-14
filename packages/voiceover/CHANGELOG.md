# Changelog

## 0.3.0

- `dsh-voiceover serve`: a local daemon exposing the same operations over HTTP
  (bearer token on every route, Range-capable audio, 202 async jobs).
- The daemon keys projects with the shared `normalizeSource`, so a project
  created through the API and one created through the Tool land on the same id.
- Snapshot building moved to `snapshot.ts`, shared by the panel and the API.
- MCP transport is not implemented yet; the HTTP API is the current surface.
## 0.2.0

- `voiceover_rerun` tool plus a panel button: one operation (`operations.ts`) called
  from both paths. Finished chapters are skipped by content hash, failed ones rerun.
- Persist the spoken style in project state so a rerun reproduces the same project
  key; the operation refuses rather than writing into a directory that other
  settings produced.
- Project identity is now computed from the normalized text, so a rerun that reads
  the persisted source file lands on the same key as the original run.
## 0.1.1

- Playback: host registers `/voiceover/audio` (the engine's `AudioRoute` with its own
  prefix, Range + session fence); the panel shows one player plus a per-chapter play
  button, and the URL is captured on click so progress refreshes do not interrupt.
## 0.1.0

- Conversation panel: a client view for `voiceover_create` / `voiceover_status` that
  polls a read-only host route (`GET /voiceover/panel/<projectId>.json`) and shows
  progress, per-chapter status, durations, subtitles and degradation warnings.
- The panel route sits behind the host connection fence and exposes no script text
  or filesystem paths.
- Persist the plan state before the first chapter runs, so the panel shows progress
  instead of a 404 during chapter one.

- The bundle patch inserts the engine with the engine bundle's own id
  (`dsh-tts`), so installing both packages merges into one mount instead of
  publishing `ctx.tts` twice.

- First cut of the voiceover pipeline: chapter planning (block map + outline
  reduce), spoken-script adaptation, audit with one repair round, synthesis via
  `ctx.tts`, subtitle alignment, and a schema-validated manifest.
- Resume by content hash: unchanged chapters are skipped, changed chapters rerun.
- Rule-based subtitle splitting and timing fallback when no model is available,
  labelled `estimated` (the file is written as `*.est.srt`).
- Tools: `voiceover_create`, `voiceover_status`, `voiceover_export`.