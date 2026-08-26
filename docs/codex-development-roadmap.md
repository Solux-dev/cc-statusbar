# Codex Development Roadmap

This is the full implementation plan for adding Codex support to this extension.
It is intentionally detailed so a fresh Codex session can resume work without
rediscovering the decisions from the research session.

## Goal

Add Codex support to the existing status-bar extension while preserving the
current Claude Code behavior.

The user should be able to see, in the visible status bar:

```text
Codex · 🟢 5h 47% (2h14m) · 🟢 7d 25% (3d6h) · 🟢 ctx 24%
```

The hover tooltip and persistent panel should show richer details:

- 5-hour quota usage and reset countdown
- 7-day quota usage and reset countdown
- context-window fill percentage
- active Codex thread/session details
- model and plan details when available
- last-turn and total token usage
- cached input tokens and cache hit rate
- honest cache-retention wording
- diagnostics when data is unavailable

## Non-Goals For The First Codex Release

Do not implement these in the first release:

- two independent visible status-bar items
- mixed Claude Code + Codex numbers in one visible bar
- local SQLite scraping as the primary Codex data source
- direct reading of `~/.codex/auth.json`
- promises about live prompt-cache TTL when Codex does not expose one
- promises about cross-thread Codex cache sharing
- a coaching/efficiency engine
- marketplace/package rename before local behavior is proven

## Current State

Already added:

- `docs/codex-statusbar-plan.md`
- `docs/codex-development-roadmap.md`
- `src/providerTypes.ts`
- `src/codexProvider.ts`
- Codex guardrail tests in `src/test/logic.test.ts`

Current verification:

```text
npm run compile
npm test
```

Expected result at the time this roadmap was written:

```text
48 tests passing
```

Codex runtime integration is not connected yet. The existing Claude Code
status-bar behavior should remain unchanged until the provider resolver is
explicitly wired into `extension.ts`.

> **Status as of 25 August 2026 — the paragraph above is history, not the
> current state.** Codex shipped: the provider is wired into `extension.ts`, it
> has its own panel and hover, and quota, context, cache and the
> token-equivalent all come from the app-server and local rollouts. What is
> still true from the plan: `buildCodexSnapshot` / `ProviderSnapshot` in
> `src/codexProvider.ts` remain the unused abstraction this roadmap proposed —
> the shipped path reads `CodexQuotaDetails` directly. Test count is 261 as of
> 26 August 2026, not the 48 this roadmap was written against — a count moves
> with every round, so it is dated here rather than left to drift.

## Product Principles

### One Visible Source

The extension should show one active provider at a time:

- Claude Code
- Codex

It should not combine them in the collapsed status bar.

### Honest Data

If a value is not exposed by the source of truth, do not guess.

Examples:

- Codex 5h/7d quota can be shown honestly from app-server rate limits.
- Codex context can be shown honestly from app-server token usage.
- Codex cached input tokens can be shown honestly.
- Codex live cache TTL cannot currently be shown as an exact countdown.

### Color Semantics

Keep the existing semantics:

- whole status-bar background: quota pace only
- per-window dots: quota pace per window
- context dot: context fill only
- cache: tooltip/panel only

Context must not tint the whole status-bar item.

### Visible Reset Countdown

The visible bar must include reset countdowns in parentheses:

```text
5h 47% (2h14m)
7d 25% (3d6h)
```

This is already implemented for Claude in `render.ts`; Codex must use the same
formatting behavior.

## Source Of Truth

### Claude Code

Keep current sources:

- transcripts under `~/.claude/projects/<slug>`
- Anthropic quota endpoint through current OAuth token
- Anthropic Models API for context-window limit

Important regression lesson:

- Claude project slug handling must preserve the current rule: every
  non-alphanumeric character becomes `-`.
- Spaces in project names are a known bug class and must stay covered by tests.

### Codex

Use Codex app-server JSON-RPC as the primary source.

Do not use SQLite/auth file scraping as the normal path.

Useful app-server methods/notifications discovered during research:

- `account/read`
- `account/rateLimits/read`
- `thread/list`
- `thread/loaded/list`
- `thread/tokenUsage/updated`

Important schema fields:

- `rateLimits.primary.usedPercent`
- `rateLimits.primary.windowDurationMins`
- `rateLimits.primary.resetsAt`
- `rateLimits.secondary.usedPercent`
- `rateLimits.secondary.windowDurationMins`
- `rateLimits.secondary.resetsAt`
- `tokenUsage.last`
- `tokenUsage.total`
- `tokenUsage.modelContextWindow`

Known live probe result on this machine:

- `primary.windowDurationMins = 300`
- `secondary.windowDurationMins = 10080`
- `planType = prolite`
- `limitId = codex`

Mapping rule:

- `300` minutes -> `5h`
- `10080` minutes -> `7d`
- unknown durations -> render dynamically instead of lying

## Codex Cache Policy

What can be shown honestly:

- `cachedInputTokens`
- cache hit rate
- cache scope
- expected retention policy by model, when known

What cannot be shown honestly yet:

- exact live TTL countdown for the current cache entry

Important source-code finding:

- Codex normal requests set `prompt_cache_key` from the Codex thread id.

Product consequence:

- Treat cache observations as scoped to the active Codex thread.
- Do not promise that two different Codex threads in the same project share
  cache the same way Claude Code sessions may.

Suggested panel text:

```text
Cache retention: expected extended retention for this model; exact live TTL is not exposed.
```

For unknown/internal model names:

```text
Cache retention: unknown for this model
```

## Architecture Target

Keep IO separated from pure logic.

Target module shape:

```text
src/
  extension.ts              VS Code wiring, timers, commands, panel lifecycle
  render.ts                 pure UI text/tooltip/panel rendering
  metrics.ts                pure math/formatting
  i18n.ts                   UI strings
  providerTypes.ts          shared provider contracts
  providerResolver.ts       auto/claude/codex selection
  claudeProvider.ts         adapter around current transcript/quota logic
  codexProvider.ts          pure Codex mapping functions
  codexAppServer.ts         JSON-RPC app-server transport/client
  codexCachePolicy.ts       model -> cache retention wording
  test/
    logic.test.ts
```

Do not put Codex app-server process handling into `render.ts` or `metrics.ts`.

## Settings And Commands

Add setting:

```json
"ccStatusbar.provider": "auto"
```

Allowed values:

- `auto`
- `claude`
- `codex`

Add commands:

- `ccStatusbar.selectProvider`
- `ccStatusbar.useAuto`
- `ccStatusbar.useClaude`
- `ccStatusbar.useCodex`

Existing commands to keep:

- `ccStatusbar.refresh`
- `ccStatusbar.toggleQuota`
- `ccStatusbar.switchLanguage`
- `ccStatusbar.openPanel`

Provider choice should be persisted with workspace awareness:

- global setting controls default mode
- workspace-pinned provider handles conflicts for a specific project

## Auto Mode

Auto mode should decide which provider to show for the current workspace.

Detection signals:

Claude Code:

- current workspace transcript exists
- transcript mtime is recent
- latest main assistant turn is recent when available

Codex:

- app-server is reachable
- loaded/listed thread matches current `cwd`
- thread has recent update time
- `thread/tokenUsage/updated` notification observed

Suggested logic:

```text
manual provider set to claude -> show Claude
manual provider set to codex  -> show Codex
auto + only Claude active     -> show Claude
auto + only Codex active      -> show Codex
auto + both active            -> conflict state
auto + neither active         -> workspace pinned provider or last active provider
```

Conflict visible bar:

```text
$(warning) LLM: choose source
```

Conflict tooltip:

```text
Active Claude Code and Codex sessions were both detected for this workspace.
Choose which source this status bar should show:
Claude Code · Codex · Auto
```

Use trusted command links like the existing language/panel links.

## Session Selection

### Claude Code

Keep current behavior:

- derive project slug from workspace path
- read newest JSONL session
- include subagent files for total cost
- exclude subagents for context-window fill

Do not change the slug behavior without tests.

### Codex

Use exact `cwd` matching from app-server thread metadata.

Selection priority when multiple Codex threads match the same workspace:

1. workspace-pinned thread id
2. currently loaded thread
3. most recently updated thread
4. newest listed thread

The panel must show enough identity to avoid confusion:

- provider
- thread id short form
- cwd
- model
- updated time

If multiple threads are detected, add a panel/tooltip note:

```text
Multiple Codex threads match this workspace. Showing the most recently active one.
```

Later, add a command:

- `ccStatusbar.selectCodexThread`

## Development Milestones

### Milestone 1: Provider Setting And Resolver

Goal:

- Add provider setting and selection logic without connecting Codex yet.

Tasks:

- update `package.json` configuration
- update `package.nls.json`
- update `package.nls.ru.json`
- add provider strings to `i18n.ts`
- add `providerResolver.ts`
- add commands for provider selection
- preserve current Claude behavior as the default visible result

Tests:

- explicit `claude` mode picks Claude
- explicit `codex` mode returns Codex unavailable before app-server exists
- `auto` with only Claude activity picks Claude
- conflict state is representable

Done when:

- current extension still behaves exactly like Claude-only mode
- compile/tests pass

### Milestone 2: Codex App-Server Spike

Goal:

- Implement a minimal Codex app-server client and prove we can query account
  rate limits from VS Code extension code.

Tasks:

- add `codexAppServer.ts`
- implement process spawn/proxy connection
- implement JSON-RPC request ids
- implement initialize handshake
- implement `account/read`
- implement `account/rateLimits/read`
- capture version/diagnostics
- add timeout/retry behavior

Preferred connection order:

1. `codex app-server proxy`
2. app-server over stdio if proxy is unavailable

Safety:

- do not read `~/.codex/auth.json`
- redact email/account identifiers in logs/panel if ever shown
- throttle app-server calls

Tests:

- request id matching
- unknown response ignored safely
- error response becomes diagnostic
- timeout becomes diagnostic
- partial/noisy process output does not crash the extension

Done when:

- local extension can fetch Codex account/rate-limit data
- failure state is visible and not noisy

### Milestone 3: Codex Quota Mapping

Goal:

- Show Codex 5h/7d quota in the existing visible bar format.

Tasks:

- map app-server primary/secondary windows into `QuotaView`
- preserve reset countdown in collapsed bar
- preserve quota pace coloring
- support unknown window durations dynamically
- prefer `rateLimitsByLimitId.codex` when available
- fallback to `rateLimits`

Tests:

- `300` minutes maps to 5h
- `10080` minutes maps to 7d
- unknown window duration is not mislabeled
- reset countdown is visible in text
- background color comes from quota pace

Done when:

- Codex mode can show quota-only status without context

### Milestone 4: Codex Thread Discovery

Goal:

- Identify the active Codex thread for the current workspace.

Tasks:

- call `thread/list` with `cwd`
- call `thread/loaded/list`
- match workspace folder by exact path
- normalize path comparison enough for Windows casing/separators
- implement selection priority
- persist pinned thread id in workspace state
- surface selected thread identity in panel

Tests:

- path with spaces matches
- Cyrillic path matches
- punctuation path matches
- pinned thread wins
- loaded thread wins over merely listed thread
- newest thread wins when no pin/loaded match

Done when:

- Codex mode can identify which session it is displaying

### Milestone 5: Codex Context And Tokens

Goal:

- Show Codex context percentage and token details.

Tasks:

- subscribe to or poll `thread/tokenUsage/updated`
- map `tokenUsage.last` to current context fill
- map `tokenUsage.total` to cumulative token totals
- show last/total breakdown in panel
- include reasoning output tokens
- fail visibly when `modelContextWindow` is missing

Tests:

- last turn drives context percentage
- total usage drives cumulative panel numbers
- reasoning tokens are not dropped
- missing context limit hides percent in bar and shows `limit n/a` in detail

Done when:

- Codex mode shows quota + context in the collapsed bar

### Milestone 6: Codex Cache Display

Goal:

- Show honest cache data without overstating TTL.

Tasks:

- show cached input tokens
- compute cache hit rate
- add `codexCachePolicy.ts`
- add model-based expected retention wording
- show unknown policy for unknown/internal models
- show cache scope as active thread

Tests:

- cached hit rate handles zero input
- cached hit rate uses cached/input relationship correctly
- known model renders expected policy
- unknown model renders unknown policy
- no cache TTL countdown is displayed

Done when:

- panel gives useful cache insight while staying honest

### Milestone 7: Provider Auto Mode

Goal:

- Let the extension choose Claude or Codex automatically in normal use.

Tasks:

- implement activity snapshots for Claude and Codex
- define recency threshold
- implement conflict state
- add provider quick pick
- add tooltip command links
- persist workspace choice

Tests:

- only Claude active -> Claude
- only Codex active -> Codex
- both active -> conflict
- pinned provider wins
- stale activity does not keep forcing a provider forever

Done when:

- `auto` is comfortable for the common case
- conflict is explicit instead of guessed

### Milestone 8: Panel And Tooltip Polish

Goal:

- Make the expanded UI useful for both providers.

Tasks:

- update `render.ts` or add provider-aware render input
- show provider title
- show account/plan/model/thread details
- show diagnostics block
- keep themed CSS tooltips
- keep scripts disabled in webview
- localize new strings

Tests:

- Claude panel still renders existing blocks
- Codex panel renders quota/context/thread/cache
- conflict panel renders provider choices
- HTML escapes dynamic values

Done when:

- hover and panel explain what the status bar is measuring

### Milestone 9: Reliability

Goal:

- Avoid flicker, false errors, and noisy polling.

Tasks:

- app-server reconnect with backoff
- cache last good Codex snapshot briefly
- separate "unavailable" from "stale"
- throttle rate-limit/account reads
- update on notifications when possible
- show Codex CLI/app-server version in diagnostics

Tests:

- transient failure does not clear good data immediately
- app-server restart recovers
- stale snapshot is labeled stale
- manual refresh forces a retry

Done when:

- normal VS Code usage feels stable across windows/projects

### Milestone 10: Documentation And Release Decision

Goal:

- Prepare for either a combined extension or separate Codex package.

Tasks:

- update README
- update CHANGELOG
- add screenshots after UI is real
- document provider setting
- document Codex honesty limits
- document cache limitation clearly
- decide package strategy

Package options:

- keep one extension and rename it to a neutral LLM usage statusbar
- publish a separate Codex statusbar package using shared code
- publish both packages from this repo

Done when:

- user-facing docs match actual behavior
- release path is chosen

## Manual Test Matrix

Run these before release.

Claude-only workspace:

- status bar still matches current release
- 5h/7d reset countdown visible
- context dot works
- panel works

Codex-only workspace:

- status bar shows Codex
- 5h/7d reset countdown visible
- context percent visible after a turn
- panel shows thread/model/token/cache details

Both providers active in one workspace:

- auto mode enters conflict
- tooltip offers provider choice
- manual selection persists

Multiple VS Code windows:

- each window tracks its own workspace/session
- account-wide quota is shared naturally
- context/thread details do not leak across windows

Multiple Codex threads in one workspace:

- selected thread identity is visible
- pinned thread persists
- newest/loaded fallback behaves predictably

Path edge cases:

- spaces
- Cyrillic
- punctuation
- worktree paths
- Windows drive casing differences

Failure cases:

- Codex app-server unavailable
- Codex CLI not installed
- account/rate-limit call fails
- token usage missing
- model context window missing

## Suggested Next Session Start

> **Done, and kept as the record of how it was planned.** Everything in this
> section shipped: the provider setting, the selection commands, the resolver
> and its tests are all in `src/codexProvider.ts` and `src/extension.ts`. Read
> it as history. The one item that did NOT ship is `buildCodexSnapshot` /
> `ProviderSnapshot` — see the status note near the top of this file.

Start with these steps:

1. Read `docs/codex-statusbar-plan.md`.
2. Read this roadmap.
3. Run `npm test`.
4. Implement Milestone 1: provider setting and resolver.
5. Keep Claude behavior unchanged.
6. Add tests before wiring Codex runtime.

The first implementation session should not try to complete all Codex support.
The best first slice is:

- provider setting
- provider selection commands
- conflict result type
- Claude adapter still feeding the existing renderer
- tests for resolver behavior
