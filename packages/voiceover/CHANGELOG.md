# Changelog

## 0.1.0

- First cut of the voiceover pipeline: chapter planning (block map + outline
  reduce), spoken-script adaptation, audit with one repair round, synthesis via
  `ctx.tts`, subtitle alignment, and a schema-validated manifest.
- Resume by content hash: unchanged chapters are skipped, changed chapters rerun.
- Rule-based subtitle splitting and timing fallback when no model is available,
  labelled `estimated` (the file is written as `*.est.srt`).
- Tools: `voiceover_create`, `voiceover_status`, `voiceover_export`.