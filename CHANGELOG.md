# Changelog

All notable changes to **cc-statusbar** are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [0.4.0] — 2026-05-31

### Added

- **Context-window usage %.** Shows how full the model's context window is right
  now — current input ÷ the model's `max_input_tokens` — so you can tell how big
  a next task can be. This is different from the cost metric (which only grows).
  Appears in the collapsed status bar (`· ctx 47%` / `· конт 47%`, after the
  tariff segments) and as a full `context: 47% (468k / 1M)` line in the tooltip
  and panel. Coloured by fill (≥85% yellow, ≥95% red) — a **fixed threshold**,
  deliberately not the time-based tariff pace.
- The window limit is read once per model from the Anthropic **Models API**
  (`max_input_tokens`), using the same local OAuth token as the quota feature,
  cached 24h. **No hardcoded model→window table** — if the limit can't be
  fetched the % is hidden (never guessed), and a fix is an isolated update.
- Setting `ccStatusbar.context.enabled` (default `true`) to turn the lookup off.

### Changed

- **Panel/tooltip lead with the cost answer.** The breakdown now opens with
  *cost (with cache) · without cache · ~N× cheaper* and demotes the raw
  work/cache numbers to a muted **Details** block — so the value of caching is
  obvious without mental math.
- Token figures drop a trailing `.0` (`1M` not `1.0M`, `468k` not `468.0k`).

## [0.3.1] — 2026-05-31

### Changed

- **Clearer cache savings.** Instead of an abstract “saved vs no-cache” line,
  the tooltip and panel now show the two totals side by side — *without caching
  ≈ X* vs *with caching (effective) ≈ Y → saved ≈ Z* — so the benefit of caching
  is obvious at a glance (RU: «без кэша было бы… / с кэшем…»).
- Removed the unimplemented “pace” line that was documented but never shown
  (the extension does not measure active work time).

## [0.3.0] — 2026-05-30

### Added

- **Persistent usage panel.** A “⤢ Open panel” link in the tooltip (and a
  *“Open usage panel”* command) opens a dockable, **live-updating** panel with
  the full breakdown — so you can keep it open and study it, instead of relying
  on the auto-hiding hover tooltip. Clicking the status-bar item still refreshes.

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
