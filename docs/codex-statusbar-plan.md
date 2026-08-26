# Codex Statusbar Plan

This document is the handoff for adding Codex support to this extension.
It records the product decisions, source-of-truth choices, and edge cases that
were discovered while studying the existing Claude Code implementation.

For the step-by-step engineering roadmap, see
[`codex-development-roadmap.md`](./codex-development-roadmap.md).

## Current Decision

Build Codex support inside this repository first.

Reasons:

- The extension already has the right shape: VS Code glue in `extension.ts`,
  pure rendering in `render.ts`, pure math in `metrics.ts`, and provider-specific
  IO isolated in separate modules.
- The current Claude Code implementation already solved important UX details:
  quota pacing colors, reset countdowns, context as an informational signal, a
  richer hover/panel view, i18n, graceful degradation, and regression tests for
  path edge cases.
- A separate package/extension id can be created later if product positioning
  requires it. The implementation should still start by generalizing this code.

## Product Shape

There should be one status-bar item, not two competing items.

Add a provider setting:

```json
"ccStatusbar.provider": "auto"
```

Allowed values:

- `auto`
- `claude`
- `codex`

The auto mode should pick one active provider per workspace. It should not mix
Claude Code and Codex numbers in the same visible status bar.

### Auto Mode

Suggested detection:

- Claude Code is active when the workspace's current Claude transcript was
  updated recently.
- Codex is active when a loaded/listed Codex thread for the same `cwd` was
  updated recently, or a `thread/tokenUsage/updated` notification was observed.
- If only one provider is active, show that provider.
- If both providers are active, show a conflict state and ask the user to choose.
- If neither provider is active, show the workspace-pinned provider or the last
  active provider.

Conflict status-bar example:

```text
$(warning) LLM: choose source
```

Conflict tooltip/panel copy:

```text
Active Claude Code and Codex sessions were both detected for this workspace.
Choose which source this status bar should show:
Claude Code · Codex · Auto
```

The choice should be persisted in `workspaceState`, keyed by workspace folder.

## Visible Bar Requirements

The visible collapsed bar must include the reset countdown in parentheses.
This is already implemented for Claude in `render.ts` and must be preserved for
Codex.

Codex example:

```text
Codex · 🟢 5h 47% (2h14m) · 🟢 7d 25% (3d6h) · 🟢 ctx 24%
```

Russian example:

```text
Codex · 🟢 5ч 47% (2ч14м) · 🟢 7д 25% (3д6ч) · 🟢 конт 24%
```

Rules:

- Whole status-bar background is driven only by quota pace.
- The context dot is informational only and must not tint the whole item.
- Cache is not shown in the collapsed bar.
- If quota is unavailable, fail visibly and show a small fallback instead of
  pretending the data is known.

## Codex Data Sources

Preferred source: Codex app-server JSON-RPC.

Use app-server rather than scraping local SQLite files or reading auth files.

Useful Codex app-server payloads:

- `account/rateLimits/read`
- `thread/list`
- `thread/loaded/list`
- `thread/tokenUsage/updated`

The locally generated app-server schema showed:

- `RateLimitSnapshot.primary.usedPercent`
- `RateLimitSnapshot.primary.windowDurationMins`
- `RateLimitSnapshot.primary.resetsAt`
- `RateLimitSnapshot.secondary.usedPercent`
- `RateLimitSnapshot.secondary.windowDurationMins`
- `RateLimitSnapshot.secondary.resetsAt`
- `ThreadTokenUsageUpdatedNotification.threadId`
- `ThreadTokenUsageUpdatedNotification.tokenUsage.last`
- `ThreadTokenUsageUpdatedNotification.tokenUsage.total`
- `ThreadTokenUsageUpdatedNotification.tokenUsage.modelContextWindow`

A live probe on this machine returned:

- primary window: `300` minutes, matching the 5-hour Codex limit
- secondary window: `10080` minutes, matching the 7-day Codex limit
- plan type: `prolite`
- limit id: `codex`

Do not hardcode the labels blindly. If `windowDurationMins` is `300`, label it
`5h`; if `10080`, label it `7d`; otherwise render the actual duration.

## Codex Context

Codex context can be shown honestly from app-server token usage:

```text
context percent = tokenUsage.last.totalTokens / tokenUsage.modelContextWindow
```

Use the last turn for "how full is the current model context right now".
Use totals separately for cumulative thread/session token accounting.

If `modelContextWindow` is unavailable, do not guess:

- omit the `%` from the collapsed bar
- show used tokens plus `limit n/a` in the tooltip/panel

## Codex Cache

Codex exposes cached input token counts, but it does not expose a live cache TTL
countdown in the app-server schema found so far.

Show honest cache information:

- cached input tokens
- cache hit rate
- expected cache-retention policy by model, when known from official docs
- cache scope

Do not claim a live TTL if Codex does not expose one.

OpenAI's prompt-caching guide splits these figures by model generation, and an
earlier draft of this section flattened them into one set. Re-read at the source
on 26 August 2026 (developers.openai.com/api/docs/guides/prompt-caching):

- **Minimum cacheable prompt.** 1,024 tokens for **GPT-5.6 and later**; 2,048
  visible input tokens for earlier models, some of which may cache shorter
  prefixes. Hidden system content does not count toward the minimum.
- **GPT-5.6 and later** use `prompt_cache_options.ttl`, whose only supported
  value is `30m` — also the default. A cached prefix "remains eligible for reuse
  for 30 minutes after its most recent write or reuse, though OpenAI may retain
  it longer": a minimum, not an expiry you can count on to the second.
- **`gpt-5.5` and `gpt-5.5-pro`** support `"24h" only` — one value, not a
  choice.
- **The other earlier models** (`gpt-5.4`, `gpt-5.2`, `gpt-5.1` and its codex
  variants, `gpt-5`, `gpt-5-codex`, `gpt-4.1`) support both `in_memory`
  (typically 5–10 minutes of inactivity, up to an hour) and `24h` (typically
  around 30 minutes, up to 24 hours). For those, the default follows the
  organisation's data-retention policy.

These are somebody else's numbers and they move. Anything we ever print from
them must be re-read at the source first, and the extension still prints none
of them: it shows what Codex states, and shows the rest as unavailable.

Suggested panel wording:

```text
Cache retention: expected extended retention for this model; exact live TTL is not exposed.
```

For unknown/internal model names:

```text
Cache retention: unknown for this model
```

### Cache Scope Warning

OpenAI Codex source currently sets the normal `prompt_cache_key` to the Codex
thread id. Therefore the safe product assumption is:

- cache observations are scoped to the active Codex thread
- do not promise cross-thread cache reuse inside the same project
- show actual `cachedInputTokens` as the ground truth

This differs from the Claude Code workflow where same-project parallel sessions
can benefit from shared hot cache behavior.

## Session And Workspace Rules

Claude Code:

- Uses project slug folders under `~/.claude/projects`.
- Regression lesson: every non-alphanumeric character in the path slug must be
  treated carefully. Spaces, Cyrillic, punctuation, and underscores matter.

Codex:

- Prefer exact `cwd` matching from app-server thread metadata.
- Do not invent a slug.
- Test Windows paths with spaces and non-ASCII characters.

Multiple sessions in one workspace:

- If Codex reports multiple threads for the same `cwd`, prefer pinned thread.
- Otherwise prefer currently loaded thread.
- Otherwise prefer most recently updated thread.
- The panel must show a short thread id/name/updated time so the user can see
  which Codex session is being measured.

## Implementation Phases

### Phase 1: Provider Abstraction

Add shared provider interfaces and adapt current Claude code to produce a common
snapshot.

Keep current behavior unchanged.

### Phase 2: Codex App-Server Client

Implement a small JSON-RPC client for Codex app-server.

Preferred connection order:

1. `codex app-server proxy` when a Codex server is already running.
2. Spawn app-server over stdio when needed.

Do not read `~/.codex/auth.json` directly.

### Phase 3: Codex Quota And Context

Map Codex rate limit and token usage payloads into the shared snapshot:

- primary `300` minute window -> 5h quota
- secondary `10080` minute window -> 7d quota
- `resetsAt` -> reset countdown in the visible bar
- `tokenUsage.last.totalTokens` and `modelContextWindow` -> context percent
- `cachedInputTokens` -> cache hit line

### Phase 4: Auto Provider Mode

Implement:

- provider setting
- provider quick pick
- conflict state
- workspace-pinned source
- tooltip command links

### Phase 5: Panel Details

Extend the panel with provider-specific details:

- source/provider
- account/plan
- model
- thread id
- cwd/worktree
- last token usage
- total token usage
- cache policy and hit rate
- diagnostics when a source is unavailable

### Phase 6: Packaging Decision

After implementation works locally, decide whether to keep this as one extension
or publish separate packages.

Possible package strategies:

- keep one extension and rename product to a neutral "LLM Usage Statusbar"
- publish a separate Codex-branded extension using the same provider/render core
- publish both, with shared source code

## Tests To Add

- Codex rate-limit mapping: `300` minutes renders as `5h`.
- Codex rate-limit mapping: `10080` minutes renders as `7d`.
- Unknown window duration renders dynamically and does not lie.
- Reset countdown appears in the collapsed Codex bar.
- Context percent is based on last turn and model context window.
- Missing model context window fails visibly.
- Cached input hit rate handles zero denominators.
- Whole item background uses only quota pace.
- Context dot does not drive whole item background.
- `auto` mode selects the only active provider.
- `auto` mode enters conflict when both providers are active.
- Workspace-pinned provider wins.
- Codex exact `cwd` matching handles spaces, Cyrillic, punctuation, and
  worktree paths.
- Multiple Codex threads in one cwd choose pinned, then loaded, then newest.

## References

- Codex app-server docs: https://developers.openai.com/codex/app-server
- Prompt caching docs: https://developers.openai.com/api/docs/guides/prompt-caching
- Codex source, request client: https://github.com/openai/codex/blob/b89ce9a2bcedcfddf3a48f387b7912d602d6d87c/codex-rs/core/src/client.rs
- Codex source, API request type: https://github.com/openai/codex/blob/b89ce9a2bcedcfddf3a48f387b7912d602d6d87c/codex-rs/codex-api/src/common.rs
