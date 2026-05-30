# Claude Code Cost Statusbar

A VS Code status-bar item showing **live Claude Code consumption** for the
active session, in **tokens** — plus the **real 5-hour / 7-day subscription
quota**. Built for subscription users who want an at-a-glance cockpit without
leaving the editor.

## What it shows

Compact status-bar line (click to refresh) — when the real quota is available
it shows **tariff only**, per window:

```text
🟢 5h 24% (2h41m) · 🟢 7d 41% (4d3h)
```

When the quota channel is off/unavailable it falls back to the always-accurate
local number: `$(pulse) eff 4.7M`.

Hover for the full breakdown (tooltip):

- **work** (input + output) — raw work tokens
- **effective** — cache-weighted comparable metric:
  `effective = work + 0.1·cache_read + 1.25·cache_write`
- **cache** read / write + estimated **savings**
- **pace** — effective tokens per hour of active work
- **5h / 7d** real subscription quota: % used, colored bar, reset countdown,
  and a plain-language verdict (`on track` / `cutting it close` /
  `spending faster than the limit`) — the **whole item turns yellow/red** when
  the current burn pace risks exceeding a window.

The `effective` formula matches the project's `tools/session-cost.py` /
`docs/cost-metrics.md`, so the bar agrees with the end-of-session reports.

## Glossary — what you see / Что вы видите

| In the bar/tooltip | English | По-русски |
|--------------------|---------|-----------|
| 🟢 | on track — at this pace you'll comfortably fit the window | в норме — при таком темпе уложитесь в окно |
| 🟡 | cutting it close — near the limit before reset | впритык — близко к лимиту до сброса |
| 🔴 | spending faster than the limit — may run out before reset | опережение — тратите быстрее лимита, можете упереться до сброса |
| `5h` / `7d` | your two rolling subscription windows (5-hour and 7-day) | два окна подписки (за 5 часов и за 7 дней) |
| `work` / работа | tokens actually sent + received this session | реально отправленные + полученные токены за сессию |
| `effective` / эффективно | one comparable number that fairly counts cache (cheap to read, costly to write) | единое сравнимое число, честно учитывающее кэш |
| `cache` / кэш | reused context — cheap reads, one-time writes | переиспользованный контекст — дешёвое чтение, разовая запись |
| `pace` / темп | effective tokens per hour of active work | эффективных токенов в час активной работы |
| resets in / сброс через | time until that window's usage resets to 0% | время до обнуления окна |

The plugin's language follows the editor automatically; set
`ccStatusbar.language` to `en` or `ru` to force one.

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

## Install (local, no marketplace)

```bash
npm install
npm run compile
npm run package        # produces cc-statusbar-<version>.vsix
code --install-extension cc-statusbar-0.2.0.vsix
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

**What the user does:** nothing. When the channel changes, a fix is released and
— if installed from the Marketplace — **arrives as an automatic update**.

This is a **best-effort** tool, distributed under the MIT license "as is",
without warranty. Tariff problems are usually **not the plugin's fault** but a
change on Anthropic's side, and are resolved by an update.

## License

MIT.
