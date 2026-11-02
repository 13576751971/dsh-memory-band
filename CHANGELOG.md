# Changelog

## 0.2.1 — 2026-11-02

- Make the bundle installable and live-test it inside DSH (`systemPrompt.context` + `tools.register`).
- Keep the 24h boot band stable per session; inject older related memories only when the current query hits.
- Auto-capture statements, skip questions, and never re-inject the current line in the same turn.
- Add `memory_band` tool (`recall` / `remember` / `stats`) and a loopback dashboard.
- Add the memory-first footer: if the band already answers, answer directly instead of re-reading files.
- Add 46 tests, a DSH benchmark report, marketplace metadata, banner/icon/homepage.

## 0.1.0 — 2026-11-02

- First three-band engine: 24h protection band, 2-gram recall, scene replay.
- Config normalization, prompt budget guards, topic stack (off by default).
