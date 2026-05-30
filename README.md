# Claude Code Cost Statusbar

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/solux-dev.cc-statusbar?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=solux-dev.cc-statusbar)

A VS Code status-bar item showing your **real 5-hour / 7-day Claude Code
subscription quota** and **how full the model's context window is right now** —
plus **live token consumption** for the active session. Built for subscription
users who want an at-a-glance cockpit without leaving the editor.

**Install:** search **“Claude Code Cost Statusbar”** in the VS Code Extensions
view, or run `code --install-extension solux-dev.cc-statusbar`.

| English | Русский |
|---------|---------|
| ![Tooltip — English](https://raw.githubusercontent.com/Solux-dev/cc-statusbar/master/media/screenshot-en.png) | ![Tooltip — Russian](https://raw.githubusercontent.com/Solux-dev/cc-statusbar/master/media/screenshot-ru.png) |

The collapsed bar lives at the bottom-right of the status bar; hover it for the
full breakdown shown above. Want to keep it open? Click **“⤢ Open panel”** in
the tooltip (or run *“Claude Code Statusbar: Open usage panel”*) to dock a
**live-updating** panel that stays until you close it.

## What it shows

Compact status-bar line (click to refresh) — when the real quota is available
it shows the **tariff** per window, then the **context-window fill**:

```text
🟢 5h 24% (2h41m) · 🟢 7d 41% (4d3h) · ctx 47%
```

`ctx 47%` is how full the model's context window is right now (current input ÷
the model's window limit). It gets its own warning dot at ≥85% (yellow) and
≥95% (red), but — unlike the tariff — it does **not** recolour the whole item,
because "how full" and "burn pace" are two different things. If the window limit
can't be fetched, the `ctx` segment is simply hidden (the % is never guessed).

When the quota channel is off/unavailable it falls back to the always-accurate
local number: `$(pulse) eff 4.7M`.

Hover for the full breakdown (tooltip):

- **work** (input + output) — raw work tokens
- **cache** read / write — reused-context tokens
- **without caching** vs **with caching (effective)** — the two totals side by
  side, so you see exactly how much caching saved this session. “Effective” is
  the cache-weighted comparable number:
  `effective = work + 0.1·cache_read + 1.25·cache_write`
- **5h / 7d** real subscription quota: % used, colored bar, reset countdown,
  and a plain-language verdict (`on track` / `running tight` / `over pace`) —
  the **whole item turns yellow/red** when the current burn pace risks
  exceeding a window.
- **context** — how full the model's window is now, as a full line
  `context: 47% (468k / 1M)`. Read once per model from the Anthropic Models API
  (`max_input_tokens`, cached 24h); hidden entirely if the limit can't be
  fetched (never guessed).

The `effective` formula matches the project's `tools/session-cost.py` /
`docs/cost-metrics.md`, so the bar agrees with the end-of-session reports.

## Glossary — what you see / Что вы видите

| In the bar/tooltip | English | По-русски |
|--------------------|---------|-----------|
| 🟢 | on track — at this pace you'll comfortably fit the window | в норме — при таком темпе уложитесь в окно |
| 🟡 | running tight — getting close to the limit before reset | близко к лимиту — мало запаса до сброса |
| 🔴 | over pace — burning faster than the window allows; may run out before reset | выше нормы — тратите быстрее лимита, можете упереться до сброса |
| `5h` / `7d` | your two rolling subscription windows (5-hour and 7-day) | два окна подписки (за 5 часов и за 7 дней) |
| `work` / работа | tokens actually sent + received this session | реально отправленные + полученные токены за сессию |
| `effective` / эффективно | one comparable number that fairly counts cache (cheap to read, costly to write) | единое сравнимое число, честно учитывающее кэш |
| `cache` / кэш | reused context — cheap reads, one-time writes | переиспользованный контекст — дешёвое чтение, разовая запись |
| `ctx` / `конт` / context / контекст | how full the model's context window is now (input ÷ window limit) — tells you how big a next task can be | насколько заполнено контекстное окно модели сейчас (ввод ÷ лимит окна) — подсказывает, насколько большую задачу можно дать дальше |
| resets in / сброс через | time until that window's usage resets to 0% | время до обнуления окна |

### Language / Язык

By default the plugin **follows the editor's display language** (English for an
English editor, Russian for a Russian one). To force a language, any of:

- **Hover the status-bar item → click “🌐 Change language / Сменить язык”** at
  the bottom of the tooltip;
- Command Palette (`Ctrl/Cmd+Shift+P`) → **“Claude Code Statusbar: Switch
  language”**;
- Settings → search `ccStatusbar.language` → `auto` / `en` / `ru`.

_По умолчанию язык берётся из языка редактора. Сменить вручную: наведи курсор на
строку состояния и нажми «🌐 Сменить язык» внизу подсказки, либо палитра команд →
«Claude Code Statusbar: Switch language», либо Настройки → `ccStatusbar.language`._

## How it gets data

- **Tokens / effective / cache** — parsed from the **local** transcript
  `~/.claude/projects/<slug>/<session>.jsonl` (+ its `subagents/`). Always
  accurate, no network, **zero token cost**. Independent of Anthropic auth.
- **Real 5h/7d quota** — a tiny throttled request to Anthropic reads the
  `anthropic-ratelimit-unified-*` response headers (uses your existing local
  OAuth token). **~a few tokens per poll**, at most once per
  `quota.minPollSeconds` (default 300s) and **only while the session is
  active**. Can be turned off (`ccStatusbar.quota.enabled: false`) — then only
  the free local metrics show.

## Privacy / security

Your OAuth token (`~/.claude/.credentials.json`) is used **only** to call
Anthropic's own API for quota headers. **No telemetry, no third-party servers,
no data leaves your machine** (other than that one Anthropic call). The code is
small and MIT-licensed — read `src/quota.ts` to verify.

## Install

**From the Marketplace (recommended):** search **“Claude Code Cost Statusbar”**
in the Extensions view, or run `code --install-extension solux-dev.cc-statusbar`.
Updates arrive automatically.

**Build locally (for development):**

```bash
npm install
npm run compile
npm run package        # produces cc-statusbar-<version>.vsix
code --install-extension cc-statusbar-0.4.0.vsix
```

Reload VS Code. The item appears on the right of the status bar.

## Settings (`ccStatusbar.*`)

| Key | Default | Meaning |
|-----|---------|---------|
| `language` | `auto` | Plugin language: `auto` (follow editor) / `en` / `ru` |
| `enabled` | `true` | Show the item |
| `refreshSeconds` | `10` | Redraw interval |
| `alignment` | `right` | Status-bar side |
| `cacheReadWeight` | `0.1` | `effective` weight for cache read |
| `cacheWriteWeight` | `1.25` | `effective` weight for cache write |
| `quota.enabled` | `true` | Fetch real 5h/7d quota (costs ~tokens) |
| `quota.minPollSeconds` | `300` | Min seconds between quota calls |
| `credentialsPath` | `""` | Override credentials file location |
| `context.enabled` | `true` | Show how full the model's context window is now (Models API, cached 24h) |

## Reliability — what can temporarily break (important)

The plugin has two parts with different reliability:

- **Local metrics** (`work` / `effective` / `cache` / savings) are read from the
  local transcript files. They **always work** and depend on nothing external.
- **The real 5h/7d quota** comes from an **undocumented** Anthropic channel (the
  API response headers, read with your local OAuth token). If Anthropic changes
  that mechanism, **only the tariff line stops showing** — the plugin does not
  break: all local metrics keep working and the tariff is simply hidden with a
  "temporarily unavailable" note. Because only `src/quota.ts` touches that
  channel, a fix is a small, isolated patch.
- **The context-window %** depends on the same external channel: it reads the
  model's window limit from the Anthropic Models API using your local OAuth
  token (cached 24h). If that channel changes, **only the context line hides**
  (the % is never guessed) — local cost/cache metrics are unaffected. The fix is
  likewise isolated to `src/quota.ts`.

**What the user does:** nothing. When the channel changes, a fix is released and
— if installed from the Marketplace — **arrives as an automatic update**.

This is a **best-effort** tool, distributed under the MIT license "as is",
without warranty. Tariff problems are usually **not the plugin's fault** but a
change on Anthropic's side, and are resolved by an update.

## License

MIT.
