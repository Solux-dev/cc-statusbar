# Changelog

All notable changes to **cc-statusbar** are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [0.3.0] — 2026-05-30

### Added

- **Persistent usage panel.** A “⤢ Open panel” link in the tooltip (and a
  *“Open usage panel”* command) opens a dockable, **live-updating** panel with
  the full breakdown — so you can keep it open and study it, instead of relying
  on the auto-hiding hover tooltip. Clicking the status-bar item still refreshes.

### Changed

- **Clearer cache savings.** Instead of an abstract “saved vs no-cache” line,
  the tooltip and panel now show the two totals side by side — *without caching
  ≈ X* vs *with caching (effective) ≈ Y → saved ≈ Z* — so the benefit of caching
  is obvious at a glance (RU: «без кэша было бы… / с кэшем…»).
- Removed the unimplemented “pace” line that was documented but never shown
  (the extension does not measure active work time).

## [0.2.2] — 2026-05-30

### Added

- **Easy language switching:** a “🌐 Change language / Сменить язык” link at the
  bottom of the hover tooltip, and a **“Claude Code Statusbar: Switch language”**
  command — so the language is discoverable without digging into Settings.

### Changed

- Reworded the pace verdicts for clarity and made the per-window verdict match
  the legend. EN: `on track` / `running tight` / `over pace`. RU: `в норме` /
  `близко к лимиту` / `выше нормы`.

## [0.2.1] — 2026-05-30

### Added

- Extension icon (coral tile with a usage-gauge and a green "on-track" dot).
- Screenshots (English + Russian tooltip) in the README.

## [0.2.0] — 2026-05-30

### Added

- **English + Russian localization** of the whole runtime UI (status bar +
  hover tooltip). New setting `ccStatusbar.language`: `auto` (follow the
  editor's display language, default), `en`, or `ru`. Command titles localized
  via `package.nls`.
- **Glossary** ("what you see", EN + RU) in the README, plus plainer
  pace-verdict wording (`on track` / `cutting it close` / `spending faster than
  the limit`; RU `в норме` / `впритык` / `опережение`).

### Changed

- README is now English-first; the Reliability section is in English.
- `fmtRemaining` and `paceLevel` take language into account (pure functions;
  unit-tested in both languages).

## [0.1.0] — 2026-05-30

Initial release.

### Added

- Status-bar item with a **tariff-only collapsed view**: per-window colored dot
  (🟢 в норме / 🟡 впритык / 🔴 опережение) + `5ч` / `7д` usage % + time-to-reset.
- **Real 5h / 7d subscription quota** (Claude.ai Pro/Max/Team) via Anthropic
  rate-limit response headers, throttled (≤ once per `quota.minPollSeconds`,
  default 300s) and activity-gated; can be disabled.
- **Hover tooltip** with the analytical breakdown:
  `работа (вход+выход)` + `на кэш (в эфф.)` = `эффективно`, plus cache
  read/write and estimated savings.
- `effective = work + 0.1·cache_read + 1.25·cache_write` — cache-weighted
  comparable consumption, computed from the local session transcript
  (+ subagents), matching the project's `session-cost.py`.
- Whole-item background turns yellow/red when the burn pace risks exceeding a
  window.
- Settings under `ccStatusbar.*` (refresh interval, weights, quota toggle,
  poll throttle, credentials path, alignment).
- Graceful degradation: if the quota channel fails, local metrics keep working
  and only the tariff line is hidden.

### Notes

- The 5h/7d quota uses an undocumented Anthropic channel — see README
  "Reliability". Local token/effective/cache metrics are unaffected by such
  changes.
