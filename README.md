# Claude/Codex Usage — Quota & Context Statusbar

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/solux-dev.cc-statusbar?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=solux-dev.cc-statusbar)

A VS Code status-bar item for **Claude Code** and **Codex** usage: real
5-hour / 7-day quota when the provider exposes it, context-window fill, cache
signals, and a cache-weighted token-equivalent breakdown — colour-coded, at a
glance, without leaving the editor.

Claude Code keeps the full local-transcript experience: quota, context, cache
tier, cache hit rate, and token details. Codex support uses Codex app-server and
local Codex history when you select the Codex provider, showing the same layout
where data is available and clear "not available" text where Codex does not
expose a metric yet.

**Install:** search **“Claude/Codex Usage”** in the VS Code Extensions
view, or run `code --install-extension solux-dev.cc-statusbar`.

| English | Русский |
|---------|---------|
| ![Tooltip — English](https://raw.githubusercontent.com/Solux-dev/cc-statusbar/master/media/screenshot-en.png?v=2) | ![Tooltip — Russian](https://raw.githubusercontent.com/Solux-dev/cc-statusbar/master/media/screenshot-ru.png?v=2) |

The collapsed bar lives at the bottom-right of the status bar; hover it for the
full breakdown shown above. Want to keep it open? Click **“⤢ Open panel”** in
the tooltip (or run *“Claude/Codex Statusbar: Open usage panel”*) to dock a
**live-updating** panel that stays until you close it.

## What it shows

Compact status-bar line (click to refresh) — when the real quota is available
it shows the **tariff** per window, then the **context-window fill**:

```text
🟢 5h 24% (2h41m) · 🟢 7d 41% (4d3h) · 🟢 ctx 47%
Codex · 🟢 5h 24% (2h41m) · 🟢 7d 41% (4d3h) · 🟢 ctx 47%
```

`ctx 47%` is how full the model's context window is right now (current input ÷
the model's window limit) — a quick read of how big a next step you can take. Its
dot is **purely informational** (🟢 under 50% · 🟡 50–80% · 🔴 80%+) and,
unlike the tariff, it **never** recolours the whole item: context is just
information, not a quota with consequences, so "how full" and "burn pace" stay
visually separate. If the window limit can't be fetched, the `ctx` segment is
simply hidden (the % is never guessed).

When the quota channel is off/unavailable it falls back to the local
token-equivalent number: `$(pulse) eff 4.7M`.

Hover for the full breakdown (tooltip):

- **token-equivalent** (the headline) — `with cache ≈ 4.7M · without cache ≈ 32M
  (~6.8× lower)`: a normalized estimate from real token counters, showing how
  much cache reuse reduced the token load compared with re-reading everything
  fresh.
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
sessions. It is a token-equivalent, not a billing price. When the tariff line is
unavailable, this same number is the bar's `eff` fallback.

## Provider: Auto / Claude Code / Codex

The status bar shows **one provider at a time**. Use the hover menu to switch:

```text
Choose provider: Auto · Claude Code · Codex
Language: Auto · RU · EN
```

- **Auto** is conservative: it keeps the existing Claude Code behaviour unless a
  provider is explicitly selected. This avoids surprising current users.
- **Claude Code** reads the current workspace's Claude transcript and quota
  channel.
- **Codex** talks to the local Codex app-server and reads local Codex token
  history. It is intended for users who already have Codex working in the same
  editor/workspace.

The currently working provider is marked with a green dot in the hover menu.

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

For Claude Code these are read straight from the per-turn
`cache_creation.ephemeral_{1h,5m}` fields in the local transcript, so they stay
correct even as Anthropic adjusts caching behaviour. Codex currently exposes
cached input tokens, so the extension can show **Input from cache**, but it does
not expose a cache tier or separate cache-write count; those lines are shown as
not available instead of guessed.

## Glossary — what you see / Что вы видите

| In the bar/tooltip | English | По-русски |
|--------------------|---------|-----------|
| 🟢 | on track — at this pace you'll comfortably fit the window | в норме — при таком темпе уложитесь в окно |
| 🟡 | running tight — getting close to the limit before reset | близко к лимиту — мало запаса до сброса |
| 🔴 | over pace — burning faster than the window allows; may run out before reset | выше нормы — тратите быстрее лимита, можете упереться до сброса |
| `5h` / `7d` | your two rolling subscription windows (5-hour and 7-day) | два окна подписки (за 5 часов и за 7 дней) |
| `with cache` / с кэшем | token-equivalent with cache, calculated from real local counters and the extension's cache weights | токен-эквивалент с кэшем, рассчитанный из реальных локальных счётчиков и весов кэша расширения |
| `without cache` / без кэша | the same session if cached input had been read fresh — a comparison number, not billing | та же сессия, если бы ввод из кэша читался заново — число для сравнения, не биллинг |
| `work` / работа | raw input + output tokens (shown under Details) | сырые токены ввода + вывода (в блоке «Детали») |
| `cache` / кэш | reused context — cheap reads, one-time writes | переиспользованный контекст — дешёвое чтение, разовая запись |
| `ctx` / `конт` / context / контекст | how full the model's context window is now (input ÷ window limit) — tells you how big a next task can be; its dot is informational (🟢<50% · 🟡50–80% · 🔴80%+) and never tints the whole bar | насколько заполнено контекстное окно модели сейчас (ввод ÷ лимит окна) — подсказывает, насколько большую задачу можно дать дальше; кружок информационный (🟢<50% · 🟡50–80% · 🔴80%+) и не красит весь бар |
| cache tier / тир кэша | how long your prompt cache stays warm while idle — available for Claude Code; Codex does not expose this yet | сколько кэш живёт при простое — доступно для Claude Code; Codex пока это не отдаёт |
| input from cache / ввод из кэша | share of the prompt served from cache (cheap) vs re-read fresh — higher = better reuse; descriptive, not a score | доля промпта из кэша (дёшево) против повторного чтения — выше = лучше переиспользование; описание, не оценка |
| resets in / сброс через | time until that window's usage resets to 0% | время до обнуления окна |

### Language / Язык

By default the plugin **follows the editor's display language** (English for an
English editor, Russian for a Russian one). To force a language, any of:

- **Hover the status-bar item → click “🌐 Change language / Сменить язык”** at
  the bottom of the tooltip;
- Command Palette (`Ctrl/Cmd+Shift+P`) → **“Claude/Codex Statusbar: Switch
  language”**;
- Settings → search `ccStatusbar.language` → `auto` / `en` / `ru`.

_По умолчанию язык берётся из языка редактора. Сменить вручную: наведи курсор на
строку состояния и нажми «🌐 Сменить язык» внизу подсказки, либо палитра команд →
«Claude/Codex Statusbar: Switch language», либо Настройки → `ccStatusbar.language`._

## How it gets data

### Claude Code

- **Tokens / token-equivalent / cache** — parsed from the **local** transcript
  `~/.claude/projects/<slug>/<session>.jsonl` (+ its `subagents/`). No network,
  **zero token cost**, independent of Anthropic auth.
- **Real 5h/7d quota** — a tiny throttled request to Anthropic reads the
  `anthropic-ratelimit-unified-*` response headers (uses your existing local
  OAuth token). **~a few tokens per poll**, at most once per
  `quota.minPollSeconds` (default 300s) and **only while the session is
  active**. Can be turned off (`ccStatusbar.quota.enabled: false`) — then only
  the free local metrics show.
- **Context limit** — read once per model from the Anthropic Models API
  (`max_input_tokens`, cached 24h). If it cannot be fetched, the `%` is hidden
  instead of guessed.

### Codex

- **5h/7d quota** — read from the local Codex app-server
  (`account/rateLimits/read`) using the Codex/OpenAI auth that Codex already
  uses.
- **Current Codex thread** — matched to the open workspace by `cwd` through
  `thread/list` / `thread/loaded/list`.
- **Context and cached input** — read from Codex token counters in local Codex
  history (`~/.codex/sessions/...jsonl`, `token_count`) and from app-server
  token-usage notifications when available.
- **Not guessed** — Codex does not currently expose cache tier, cache write, or
  a money price. The extension shows those as unavailable and labels the top
  number as **token-equivalent**, not billing.

## Privacy / security

No telemetry, no extension-owned server, and no analytics.

- For **Claude Code**, your OAuth token (`~/.claude/.credentials.json`) is used
  only to call Anthropic's own API for quota/context metadata. Local transcript
  parsing stays on your machine.
- For **Codex**, the extension talks to the local Codex app-server/CLI using the
  Codex/OpenAI login that Codex already has. Local Codex session files are read
  only for token counters.

The code is small and MIT-licensed — read `src/quota.ts`, `src/transcript.ts`,
and `src/codexAppServer.ts` to verify.

## Install

**From the Marketplace (recommended):** search **“Claude/Codex Usage”**
in the Extensions view, or run `code --install-extension solux-dev.cc-statusbar`.
Updates arrive automatically.

**Build locally (for development):**

```bash
npm install
npm run compile
npm run package        # produces cc-statusbar-<version>.vsix
code --install-extension cc-statusbar-<version>.vsix
```

Reload VS Code. The item appears on the right of the status bar.

## Settings (`ccStatusbar.*`)

| Key | Default | Meaning |
|-----|---------|---------|
| `provider` | `auto` | Usage source: `auto` / `claude` / `codex`; also switchable from the hover menu |
| `language` | `auto` | Plugin language: `auto` (follow editor) / `en` / `ru` |
| `enabled` | `true` | Show the item |
| `refreshSeconds` | `10` | Redraw interval |
| `alignment` | `right` | Status-bar side |
| `cacheReadWeight` | `0.1` | weight for cache read in the cache-weighted cost |
| `cacheWriteWeight` | `1.25` | weight for cache write in the cache-weighted cost |
| `quota.enabled` | `true` | Fetch real 5h/7d quota (costs ~tokens) |
| `quota.minPollSeconds` | `300` | Min seconds between quota calls |
| `credentialsPath` | `""` | Override credentials file location |
| `codex.commandPath` | `""` | Optional Codex CLI path; empty = auto-detect OpenAI/ChatGPT VS Code extension, npm global install, or PATH |
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
- **Codex support** depends on the local Codex app-server and local Codex session
  history. If app-server is unavailable, the Codex tariff can temporarily show as
  unavailable; if token counters are not present yet, context/cache appear after
  the next Codex response. Metrics Codex does not expose, such as cache tier and
  cache write, are shown as unavailable rather than guessed.

**What the user does:** nothing. When the channel changes, a fix is released and
— if installed from the Marketplace — **arrives as an automatic update**.

This is a **best-effort** tool, distributed under the MIT license "as is",
without warranty. Tariff problems are usually **not the plugin's fault** but a
change on Anthropic's side, and are resolved by an update.

## Known behaviour (not bugs)

- **Works in VS Code forks** (Cursor, Windsurf, VSCodium, …) — it uses only core
  VS Code APIs and local provider files/app-server APIs, which are
  editor-independent.
- **Same folder open in two editors at once:** Claude Code stores transcripts
  **per folder, not per editor**, and the plugin shows the *most recently active*
  session for the open folder. So if you have the same folder open in, say, VS
  Code and Cursor, both windows show whichever session you typed in last — the
  context % can appear to "jump" between them. In normal use (one editor per
  folder) this never happens.
- **Context limit "n/a" right after install:** the context-window limit is
  fetched once from the Models API; until that first lookup succeeds the `ctx`
  line may briefly read `(limit n/a)`. It resolves itself on the next successful
  lookup — no action needed.

## License

MIT.
