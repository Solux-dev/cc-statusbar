# Claude Code Cost Statusbar

A VS Code status-bar item showing **live Claude Code consumption** for the
active session, in **tokens** — plus the **real 5-hour / 7-day subscription
quota**. Built for subscription users who want an at-a-glance cockpit without
leaving the editor.

## What it shows

Compact status-bar line (click to refresh):

```
$(pulse) эфф 4.7M · 5ч 24% · 7д 41%
```

Hover for the full breakdown (tooltip):

- **работа** (input + output) — raw work tokens
- **эффективно** — cache-weighted comparable metric:
  `effective = work + 0.1·cache_read + 1.25·cache_write`
- **кэш** read / write + estimated **экономия**
- **темп** — effective tokens per hour of active work
- **5ч / 7д** real subscription quota: % used, colored bar, reset countdown,
  and a pace verdict (`в норме` / `впритык` / `опережение`) — the **whole item
  turns yellow/red** when the current burn pace risks exceeding a window.

The `effective` formula matches the project's `tools/session-cost.py` /
`docs/cost-metrics.md`, so the bar agrees with the end-of-session reports.

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
code --install-extension cc-statusbar-0.1.0.vsix
```

Reload VS Code. The item appears on the right of the status bar.

## Settings (`ccStatusbar.*`)

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `true` | Show the item |
| `refreshSeconds` | `10` | Redraw interval |
| `alignment` | `right` | Status-bar side |
| `cacheReadWeight` | `0.1` | `effective` weight for cache read |
| `cacheWriteWeight` | `1.25` | `effective` weight for cache write |
| `quota.enabled` | `true` | Fetch real 5h/7d quota (costs ~tokens) |
| `quota.minPollSeconds` | `300` | Min seconds between quota calls |
| `credentialsPath` | `""` | Override credentials file location |

## Resilience

If Anthropic changes the auth/quota mechanism, **only `src/quota.ts` needs a
patch** — the local token/effective/cache metrics keep working, and the bar
gracefully hides the tariff line until fixed.

## License

MIT.
