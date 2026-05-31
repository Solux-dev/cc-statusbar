# Claude Code Usage — Quota & Context Statusbar

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/solux-dev.cc-statusbar?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=solux-dev.cc-statusbar)

A VS Code status-bar item showing the two things a Claude Code subscriber can't
conveniently see anywhere else: your **real 5-hour / 7-day subscription quota**
and **how full the model's context window is right now** — colour-coded, at a
glance, without leaving the editor. The hover panel adds an **auto-detected
prompt-cache tier (1h / 5m)** and session cache stats, plus a cache-weighted cost
breakdown.

**Install:** search **“Claude Code Usage”** in the VS Code Extensions view, or
run `code --install-extension solux-dev.cc-statusbar`.

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
🟢 5h 24% (2h41m) · 🟢 7d 41% (4d3h) · 🟢 ctx 47%
```

`ctx 47%` is how full the model's context window is right now (current input ÷
the model's window limit) — a quick read of how big a next step you can take. Its
dot is **purely informational** (🟢 under 50% · 🟡 50–80% · 🔴 80%+) and,
unlike the tariff, it **never** recolours the whole item: context is just
information, not a quota with consequences, so "how full" and "burn pace" stay
visually separate. If the window limit can't be fetched, the `ctx` segment is
simply hidden (the % is never guessed).

When the quota channel is off/unavailable it falls back to the always-accurate
local number: `$(pulse) eff 4.7M`.

Hover for the full breakdown (tooltip):

- **cost** (the headline) — `with cache ≈ 4.7M · without cache ≈ 32M
  (~6.8× cheaper)`: what this session actually cost in tokens versus what it
  would have cost with no caching, so the value of caching is obvious at a
  glance.
- **Details** (muted) — the raw numbers behind it: `work (in+out) · cache read /
  write`.
- **5h / 7d** real subscription quota: % used, colored bar, reset countdown,
  and a plain-language verdict (`on track` / `running tight` / `over pace`) —
  the **whole item turns yellow/red** when the current burn pace risks
  exceeding a window.
- **context** — how full the model's window is now, as a full line
  `context: 47% (468k / 1M)`. Read once per model from the Anthropic Models API
  (`max_input_tokens`, cached 24h); hidden entirely if the limit can't be
  fetched (never guessed).
- **cache** — the prompt-cache tier this session is on, auto-detected from the
  transcript, e.g. `🗄 Cache: 1-hour tier — survives ~1h idle`.

The "with cache" figure is cache-weighted (cheap reads, costly writes:
`work + 0.1·cache_read + 1.25·cache_write`), so it stays comparable across
sessions. When the tariff line is unavailable, this same number is the bar's
`eff` fallback.

## Cache insight (panel)

Open the panel (**“⤢ Open panel”**) for a small **Cache** section — two plain
lines, each with a hover footnote (ⓘ) that explains it in full, so you never have
to look anything up:

- **Tier — `1-hour` / `5-minute`.** Auto-detected from the session, never
  assumed. It tells you how long your prompt cache stays warm while you're idle:
  on a subscription within its plan limit it's **1-hour** (stepping away for up
  to an hour stays cheap); an API key, paid usage past your plan limit, or
  subagents run at **5-minute** (short breaks rebuild the cache and cost more).
  Check it once to know how long a break you can take — you don't need to watch
  it.
- **Input from cache — e.g. `95%`.** The share of your prompt served from cache
  (cheap) instead of re-read fresh; higher means the cache is being reused well.
  It's normal to start low and climb as a session warms up — a *descriptive* read
  of where this session's tokens went, **not a score**.

These are read straight from the per-turn `cache_creation.ephemeral_{1h,5m}`
fields in the local transcript, so they stay correct even as Anthropic adjusts
caching behaviour.

## Glossary — what you see / Что вы видите

| In the bar/tooltip | English | По-русски |
|--------------------|---------|-----------|
| 🟢 | on track — at this pace you'll comfortably fit the window | в норме — при таком темпе уложитесь в окно |
| 🟡 | running tight — getting close to the limit before reset | близко к лимиту — мало запаса до сброса |
| 🔴 | over pace — burning faster than the window allows; may run out before reset | выше нормы — тратите быстрее лимита, можете упереться до сброса |
| `5h` / `7d` | your two rolling subscription windows (5-hour and 7-day) | два окна подписки (за 5 часов и за 7 дней) |
| `with cache` / с кэшем | what the session actually cost in tokens, counting cache fairly (cheap reads, costly writes) | сколько сессия реально стоила в токенах, с честным учётом кэша |
| `without cache` / без кэша | what it would have cost with no caching — the contrast shows the saving | сколько стоило бы без кэша — контраст показывает экономию |
| `work` / работа | raw input + output tokens (shown under Details) | сырые токены ввода + вывода (в блоке «Детали») |
| `cache` / кэш | reused context — cheap reads, one-time writes | переиспользованный контекст — дешёвое чтение, разовая запись |
| `ctx` / `конт` / context / контекст | how full the model's context window is now (input ÷ window limit) — tells you how big a next task can be; its dot is informational (🟢<50% · 🟡50–80% · 🔴80%+) and never tints the whole bar | насколько заполнено контекстное окно модели сейчас (ввод ÷ лимит окна) — подсказывает, насколько большую задачу можно дать дальше; кружок информационный (🟢<50% · 🟡50–80% · 🔴80%+) и не красит весь бар |
| cache tier / тир кэша | how long your prompt cache stays warm while idle — `1-hour` (subscription within plan) or `5-minute` (API key / over plan / subagents), read from the session | сколько кэш живёт при простое — `часовой` (подписка в пределах плана) или `5-минутный` (API-ключ / сверх плана / субагенты), определяется из сессии |
| input from cache / ввод из кэша | share of the prompt served from cache (cheap) vs re-read fresh — higher = better reuse; descriptive, not a score | доля промпта из кэша (дёшево) против повторного чтения — выше = лучше переиспользование; описание, не оценка |
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

- **Tokens / cost / cache** — parsed from the **local** transcript
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

**From the Marketplace (recommended):** search **“Claude Code Usage”**
in the Extensions view, or run `code --install-extension solux-dev.cc-statusbar`.
Updates arrive automatically.

**Build locally (for development):**

```bash
npm install
npm run compile
npm run package        # produces cc-statusbar-<version>.vsix
code --install-extension cc-statusbar-1.0.0.vsix
```

Reload VS Code. The item appears on the right of the status bar.

## Settings (`ccStatusbar.*`)

| Key | Default | Meaning |
|-----|---------|---------|
| `language` | `auto` | Plugin language: `auto` (follow editor) / `en` / `ru` |
| `enabled` | `true` | Show the item |
| `refreshSeconds` | `10` | Redraw interval |
| `alignment` | `right` | Status-bar side |
| `cacheReadWeight` | `0.1` | weight for cache read in the cache-weighted cost |
| `cacheWriteWeight` | `1.25` | weight for cache write in the cache-weighted cost |
| `quota.enabled` | `true` | Fetch real 5h/7d quota (costs ~tokens) |
| `quota.minPollSeconds` | `300` | Min seconds between quota calls |
| `credentialsPath` | `""` | Override credentials file location |
| `context.enabled` | `true` | Show how full the model's context window is now (Models API, cached 24h) |

## Reliability — what can temporarily break (important)

The plugin has two parts with different reliability:

- **Local metrics** (`work` / `cost` / `cache` / savings) are read from the
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
