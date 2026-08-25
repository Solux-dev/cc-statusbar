// Self-contained i18n for the runtime UI (status bar + hover tooltip).
//
// Why not VS Code's built-in l10n bundles? Those follow the editor's display
// language fixed at startup. We expose a `ccStatusbar.language: auto|en|ru`
// setting so a user can pick the plugin's language independently — handy when
// the editor is in English but the user prefers Russian (or vice-versa). All
// strings live here as plain data + tiny formatters, so render.ts stays pure
// and unit-testable in both languages.

import { PaceLevel, CostDirection } from "./metrics";

export type Lang = "en" | "ru";
export type LangSetting = "auto" | "en" | "ru";

/** Resolve the effective language from the setting + the editor's locale. */
export function resolveLang(setting: LangSetting, envLang: string): Lang {
  if (setting === "en" || setting === "ru") return setting;
  // auto: follow the editor; Russian for any ru* locale, English otherwise.
  return (envLang || "").toLowerCase().startsWith("ru") ? "ru" : "en";
}

/** Time-unit suffixes for fmtRemaining, per language. */
export interface TimeUnits {
  d: string;
  h: string;
  m: string;
}

/** Reason the real 5h/7d quota line can't be shown right now. */
export type QuotaState = "ok" | "no-credentials" | "error" | "rate-limited" | "disabled";

export interface Messages {
  units: TimeUnits;
  providerNames: Record<"auto" | "claude" | "codex", string>;
  providerDescriptions: Record<"auto" | "claude" | "codex", string>;
  providerSelectPlaceholder: string;
  providerSet: (provider: string) => string;
  providerTooltipLine: (mode: string, active: string) => string;
  languageChoicesHeader: string;
  languageNames: Record<"auto" | "ru" | "en", string>;
  providerUnavailableText: (provider: string) => string;
  providerUnavailableTooltip: (provider: string, detail: string) => string;
  providerConflictText: string;
  providerConflictTooltip: string;
  chooseProvider: string;
  useClaude: string;
  codexTitle: string;
  codexQuotaHeader: string;
  codexAppServerLine: (source: string, plan: string | null, userAgent: string | null) => string;
  /** Same `canReverse` rule as `panelCostCompare`. The hover names no CAUSE at
   *  all — it has no room for the full explanation, and now that Codex writes
   *  are priced there are two possible causes, so naming one would be a guess. */
  codexCostCompact: (
    withCache: string,
    noCache: string,
    mult: string | null,
    dir: CostDirection,
    canReverse?: boolean
  ) => string;
  codexUsageWaitingCompact: string;
  codexContextShortUnavailable: string;
  /** Why a Codex context percentage is missing: the model states no window.
   *  A normal state, so it is UI text and follows the panel's language. */
  codexContextNoWindow: string;
  codexContextWaitingLine: string;
  codexContextWaitingPanel: string;
  codexPanelTitle: string;
  codexPanelCostLabel: string;
  codexPanelSavedLabel: string;
  /** Codex's own version of "no cache activity yet". It must NOT be the Claude
   *  string: Codex states a cache-WRITE counter separately and never says how it
   *  relates to its input count, so "nothing has been written to cache" is a
   *  fact this provider does not give us. */
  codexPanelNoCacheReadHint: string;
  /** Codex twins of the two Claude hints that name cache TIERS. Codex states no
   *  cache lifetime, so a write here can only be priced by the unstated-tier
   *  setting; repeating Claude's "1-hour ×2.0, 5-minute ×1.25" would name tiers
   *  this provider does not have. The tier-free hints (`panelCostWeightHint`,
   *  `panelCostEvenHint`) are shared, not duplicated. */
  codexPanelWarmupHint: string;
  codexPanelBothHint: string;
  /** Shown when Codex DOES state a non-zero cache-write count. Its protocol
   *  documents no relationship between that counter and `input_tokens`, so the
   *  figure above cannot absorb it without guessing — and a silent omission of
   *  a number the provider states is exactly the wrong way to be wrong. */
  codexPanelWritePricedHint: (tokens: string) => string;
  codexLowerMult: (mult: string) => string;
  codexPanelUsageWaiting: string;
  codexPanelTokenCostNote: string;
  codexPanelQuotaHeader: string;
  codexPanelContextHeader: string;
  codexPanelCacheHeader: string;
  codexCacheWaitingLine: string;
  codexCacheWaitingPanel: string;
  codexCacheHitLine: (pct: string) => string;
  codexCacheTierUnavailable: string;
  /** `cacheWrite` is the counter Codex itself states, already formatted, or
   *  null when the payload stated none — a missing counter and a stated zero
   *  are different facts and must not print the same. */
  codexDetailsLine: (work: string, cacheRead: string, cacheWrite: string | null) => string;
  codexDetailsWaitingLine: string;
  diagnosticsHeader: string;
  // status-bar (collapsed)
  noFolder: string;
  noFolderTip: string;
  effShort: string; // "eff" / "эфф" — fallback bar prefix
  w5h: string; // short window label "5h" / "5ч"
  w7d: string;
  ctxShort: string; // collapsed-bar context label "ctx" / "конт"
  // model identity (collapsed bar + tooltip/panel)
  modelPlannedShort: string; // bar suffix for a not-yet-confirmed model
  modelDefaultShort: string; // bar text when nothing is pinned in settings
  modelActualLine: (label: string) => string;
  modelPlannedLine: (label: string) => string;
  modelDefaultLine: string;
  modelChangedLine: (from: string, to: string) => string;
  // an unanswered chat open beside this one, set to start on another model
  modelPendingShort: string;
  modelPendingLine: (label: string) => string;
  // reasoning effort — deliberately NOT "эфф": that already means "эффективные
  // токены" in this UI (effShort) and the two can appear in the same line.
  effortShort: string;
  effortActualLine: (value: string) => string;
  effortPlannedLine: (value: string) => string;
  effortChangedLine: (from: string, to: string) => string;
  // subagents (delegated work)
  subagentsLine: (count: number, total: string, breakdown: string) => string;
  subagentsMore: (n: number) => string;
  subagentsCount: (n: number) => string;
  subagentDepth: (depth: number) => string;
  panelSubagentsHeader: string;
  panelSubagentsSummary: (count: number, total: string, share: string) => string;
  panelSubagentsNote: string;
  /** One muted line under the delegated-work summary: how much of what the
   *  agents spent went on reloading context after a pause, and what share of
   *  their spend that is — the yardstick a per-agent % is read against. Shown
   *  only above the threshold — an advisory line that is always there is noise. */
  panelSubagentsRebuild: (cost: string, share: string) => string;
  /** Explains the ≥ marker, shown only when something actually carries it. */
  panelAtLeastNote: string;
  /** The same rule in one clause, for the two places the `≥` can appear without
   *  the delegated section's ⓘ beside it: the panel's `Details` line (the LEAD's
   *  own reloads, which do not depend on any agent being listed) and the hover
   *  fragment. A marker with no definition in view is a number the reader
   *  cannot interpret. */
  atLeastShort: string;
  /** Hover footnote (ⓘ) for that line. The visible line must read without it. */
  panelSubagentsRebuildHint: string;
  /** Appended to the closing note when reloads dominate what the agents wrote.
   *  States the cause and the measured alternative — never a grade. */
  panelSubagentsRebuildNote: string;
  /** Tooltip fragment appended to the subagents line, same high bar. */
  subagentsRebuildFragment: (cost: string) => string;
  /** Link labels for the collapsible agent list. The panel re-renders whole on
   *  every tick and runs no scripts, so the state lives in the extension and the
   *  link is a command URI — a plain <details> would snap shut every 10s. */
  panelSubagentsExpand: string;
  panelSubagentsCollapse: string;
  /** Right-hand cell of an agent row: what waiting cost THAT agent, as a share
   *  of its own spend (0% = it never waited longer than its cache lives) plus
   *  the tokens, so a big % on a tiny agent cannot read as a big loss. */
  panelAgentIdle: (pct: string | null, cost: string | null, atLeast: boolean) => string;
  /** Same cell when the figure cannot be claimed: the agent's cache lifetime was
   *  never stated, or one of its gaps could not be judged. A `—`, never a `0%` —
   *  zero would be a claim the transcript does not support. */
  panelAgentIdleUnknown: string;
  /** What an agent row calls an agent whose type the transcript never named.
   *  Shown to the reader, so it follows the panel's language. */
  agentFallbackName: string;
  /** One muted line under the agent list explaining that cell, so the number
   *  never has to be guessed at — and stating it is not the agent's doing. */
  panelAgentIdleLegend: string;
  /** The LEAD's own reloads, muted, in Details — raw tokens, no advice: the
   *  owner stepping away is not a defect. */
  detailsRebuild: (tokens: string) => string;
  // tooltip
  title: string;
  // token-equivalent headline: one compact line (with cache · without · ×lower)
  costCompact: (withCache: string, noCache: string, mult: string | null, dir: CostDirection) => string;
  // muted technical breakdown (tooltip + panel "Details")
  detailsLine: (work: string, cacheRead: string, cacheWrite: string) => string;
  // context window fill
  contextLine: (used: string, limit: string, pct: number) => string;
  contextNoLimit: (used: string, detail?: string) => string;
  contextLimitUnavailable: string;
  tariffHeader: string;
  /** Group label for the "this session" lines (context / cache / subagents), so
   *  they stop reading as more tariff bullets. */
  sessionHeader: string;
  quotaReset: (remaining: string) => string;
  /** Label for a per-model weekly window ("Fable" → "Fable (7d)"), so the row
   *  can never be mistaken for a second 5h window. */
  scopedLabel: (model: string) => string;
  /** Inline age suffix for a scoped row — that reading comes from Claude Code's
   *  own on-disk cache, which refreshes on its own schedule, so an old value is
   *  labelled instead of silently shown as current. */
  quotaScopedAge: (ago: string) => string;
  /** Panel footnote explaining what a per-model weekly row is. */
  panelScopedHint: string;
  verdict: Record<PaceLevel, string>;
  quotaUnavail: (msg: string) => string;
  quotaStateMsg: Record<Exclude<QuotaState, "ok">, string>;
  // collapsed-bar marker shown when the 5h/7d quota could NOT be fetched
  // (not "ok"/"disabled"): names WHY, then the local token-equivalent stays
  // visible beside it — so a connectivity blip reads as "offline, local data
  // shown", never as a silent disappearance of the %.
  quotaOfflineShort: Record<Exclude<QuotaState, "ok" | "disabled">, string>;
  // tooltip note when the shown quota is a last-known reading (e.g. fetched a
  // while ago, or read from the local statusline bridge): "updated N ago".
  quotaAsOf: (ago: string) => string;
  // shown while a 429 backoff is holding the poll: names WHY the number is not
  // moving and when it will resume. Plain text — the caller adds emphasis.
  quotaPaused: (left: string) => string;
  // panel line for a non-live reading: "Last known: 5h 1%, 7d 10% (updated N ago)".
  quotaLastKnown: (windows: string, ago: string) => string;
  localAlwaysAccurate: string;
  legend: string;
  switchLang: string; // tooltip link label → ccStatusbar.switchLanguage
  openPanel: string; // tooltip link label → ccStatusbar.openPanel
  /** Link label to the issue tracker. The only route from the extension to the
   *  project: 90% of installs happen inside the editor and never open the
   *  marketplace page, so a reader who hits a wrong number has nowhere to say
   *  so unless the extension itself offers the way. */
  reportIssue: string;
  panelTitle: string; // webview panel tab title
  // webview panel (plain text — HTML provides the styling)
  tok: string;
  panelCostLabel: string; // "Token-equivalent with cache" / "Токен-эквивалент с кэшем"
  panelSavedLabel: string; // "Cache saved" / "Сэкономлено кэшем"
  /** The comparison, as a VISIBLE line under the headline number: what the same
   *  session would have cost with nothing reused. It is the one figure that says
   *  what the cache is doing for you, so it is not left to a hover. */
  /** `canReverse` is what every "so far" on this line hangs on. The gap between
   *  the two figures is `Σ bucket × (weight − 1)`, so it can only narrow if some
   *  bucket is priced below a fresh token. Where no weight is below 1 — a read
   *  weight above 1 with writes at 1.25×, say — the direction is fixed while the
   *  settings stand, and hedging it promises a turn the arithmetic forbids. It
   *  governs the `same` branch as well as `less`: two figures that are equal
   *  because nothing can separate them are not "the same *so far*". */
  panelCostCompare: (noCache: string, mult: string | null, dir: CostDirection, canReverse?: boolean) => string;
  /** Replaces the "cache saved" footnote while the with-cache figure is NOT the
   *  smaller one. Two texts, because there are two different causes and naming
   *  the wrong one invents a fact: `Warmup` when this session has written to
   *  cache (a write is priced above a fresh token and earns that back on later
   *  reads), `Weight` when it has not — then the only thing that can invert the
   *  comparison is a `cacheReadWeight` set above 1. Codex never gets `Warmup`:
   *  its write counter is a breakdown of its input count, not a separate charge,
   *  so `codexEconomy` prices no write premium and a read weight above 1 is the
   *  only thing that can invert the Codex comparison. */
  panelCostWarmupHint: string;
  panelCostWeightHint: string;
  /** …and the third case: no cache activity at all, so the two figures are the
   *  same number for a reason that has nothing to do with pricing. */
  panelCostNoCacheHint: string;
  /** …and the fourth: the cache IS working, but at the current weights it adds
   *  nothing to the figure either way. Naming a cause there would invent one. */
  panelCostEvenHint: string;
  /** …and the fifth: it costs more than it saves so far, but by less than this
   *  page can print — both figures round to the same text AND the ratio rounds
   *  to 1×. Naming the premium contradicts a page that shows no difference;
   *  saying the cache "moves nothing" would deny arithmetic that is real. */
  panelCostTooSmallHint: string;
  /** …and the sixth: BOTH sides add. Reachable only with `cacheReadWeight`
   *  above 1, where reads save nothing — so neither single-cause sentence is
   *  true, whichever of the two contributed more. */
  panelCostBothHint: string;
  lowerMult: (mult: string) => string; // "(~6.8× lower)" / "(в ~6.8× меньше)"
  panelTokenCostNote: string;
  panelDetailsHeader: string; // "Details" / "Детали"
  panelQuotaHeader: string;
  panelLocalAccurate: string;
  panelLegend: string;
  // cache insight (tier + descriptive hit rate)
  cacheTierLine: (tier: "1h" | "5m") => string; // concise tooltip line
  panelCacheHeader: string;
  panelCacheTierLabel: string;
  panelCacheTierValue: Record<"1h" | "5m", string>;
  panelCacheTierHint: string; // hover footnote
  panelCacheHitLabel: string;
  panelCacheHitHint: string; // hover footnote
}

const EN: Messages = {
  units: { d: "d", h: "h", m: "m" },
  providerNames: { auto: "Auto", claude: "Claude Code", codex: "Codex" },
  providerDescriptions: {
    auto: "Choose the active source for this workspace",
    claude: "Use the existing Claude Code transcript and quota path",
    codex: "Use Codex usage, quota, context, and cache data",
  },
  providerSelectPlaceholder: "Usage provider",
  providerSet: (provider) => `Provider: ${provider}`,
  providerTooltipLine: (mode, active) => `provider: ${mode} · showing ${active}`,
  languageChoicesHeader: "Language",
  languageNames: { auto: "Auto", ru: "RU", en: "EN" },
  providerUnavailableText: (provider) => `$(warning) ${provider}: n/a`,
  providerUnavailableTooltip: (provider, detail) =>
    `**${provider} unavailable**\n\n${detail}\n\n[Choose provider](command:ccStatusbar.selectProvider) · [Use Claude Code](command:ccStatusbar.useClaude)`,
  providerConflictText: "$(warning) LLM: choose source",
  providerConflictTooltip:
    "**Choose usage source**\n\nActive Claude Code and Codex sessions were both detected for this workspace.\n\n[Choose provider](command:ccStatusbar.selectProvider)",
  chooseProvider: "Choose provider",
  useClaude: "Use Claude Code",
  codexTitle: "**Codex — session usage**",
  codexQuotaHeader: "**Subscription quota (real, from server):**",
  codexAppServerLine: (source, plan, userAgent) =>
    `app-server: ${source}${plan ? ` · plan ${plan}` : ""}${userAgent ? ` · ${userAgent}` : ""}`,
  codexCostCompact: (withCache, noCache, mult, dir, canReverse = true) =>
    `token-equivalent with cache ≈ **${withCache}** · without cache ≈ **${noCache}**` +
    (dir === "same"
      ? ` (about the same${canReverse ? " so far" : ""})`
      : !mult
      ? ""
      : dir === "more"
      ? ` (~${mult}× lower)`
      : ` (~${mult}× higher${canReverse ? " so far" : ""})`),
  codexUsageWaitingCompact: "token-equivalent with cache: will appear after the next Codex response",
  codexContextShortUnavailable: "$(info) ctx n/a",
  codexContextNoWindow: "model context window unavailable",
  codexContextWaitingLine: "context: waiting for the next Codex response",
  codexContextWaitingPanel:
    "Context will appear after the next Codex response. Codex does not expose this number for older history yet.",
  codexPanelTitle: "Codex — Session Usage",
  codexPanelCostLabel: "Token-equivalent with cache",
  codexPanelSavedLabel: "Cache saved",
  codexPanelNoCacheReadHint:
    "Nothing has been read from cache in this session yet, so the two figures are the same number. " +
    "Codex keeps its own counter for cache writes, so this says nothing about what it may already have stored.",
  codexPanelWarmupHint:
    "The cache has not earned back what it cost yet. Codex states no cache lifetime, so a write is " +
    "priced by your `ccStatusbar.cacheWriteWeight` (default 1.25) — above a fresh input token. While " +
    "that premium is bigger than what the reads save, the with-cache figure is the larger of the two. " +
    "At the default read weight (0.1) each later read on the same cache narrows the gap.",
  codexPanelBothHint:
    "Both sides of the cache add to this figure here. A write is charged above the tokens it holds " +
    "(Codex states no cache lifetime, so yours are priced by `ccStatusbar.cacheWriteWeight`), and reads " +
    "add to it too, because your `ccStatusbar.cacheReadWeight` is above 1 — so reuse saves nothing " +
    "against reading the same input fresh. At its default (0.1) it would.",
  codexPanelWritePricedHint: (tokens) =>
    `Of the input above, ${tokens} tok were written to cache. OpenAI documents that counter as a part ` +
    `of the input count rather than an extra beside it, so those tokens are counted once — at the write ` +
    `weight instead of as ordinary fresh input, which is dearer than a fresh token and is what a warm-up ` +
    `costs. The Details line shows the figure exactly as Codex stated it.`,
  codexLowerMult: (mult) => `(~${mult}× lower)`,
  codexPanelUsageWaiting: "Token-equivalent will appear after the next Codex response.",
  codexPanelTokenCostNote:
    "Calculated from real local token counters. The cache multiplier is this extension's token-equivalent estimate, not a money price.",
  codexPanelQuotaHeader: "Subscription quota (real, from server)",
  codexPanelContextHeader: "Context",
  codexPanelCacheHeader: "Cache",
  codexCacheWaitingLine: "cache: waiting for the next Codex response",
  codexCacheWaitingPanel: "Cache usage will appear after the next Codex response.",
  codexCacheHitLine: (pct) => `input from cache: ${pct}`,
  codexCacheTierUnavailable: "n/a",
  codexDetailsLine: (work, cacheRead, cacheWrite) =>
    `work (input+output) ${work} · cache: read ${cacheRead} / write ${cacheWrite ?? "n/a"}`,
  codexDetailsWaitingLine: "Token details will appear after the next Codex response.",
  diagnosticsHeader: "**Diagnostics:**",
  noFolder: "$(pulse) cc: no folder",
  noFolderTip: "Open a project folder to track its Claude Code session.",
  effShort: "eff",
  w5h: "5h",
  w7d: "7d",
  ctxShort: "ctx",
  modelPlannedShort: "planned",
  modelDefaultShort: "default model",
  modelActualLine: (label) => `model: **${label}** — confirmed by the last turn`,
  modelPlannedLine: (label) =>
    `model: **${label}** — planned for this chat (from Claude Code settings); confirmed after the first reply`,
  modelDefaultLine:
    "model: **account default** — no model pinned in Claude Code settings; the exact one shows after the first reply",
  modelChangedLine: (from, to) => `⚠ **model changed:** ${from} → ${to}`,
  modelPendingShort: "new chat:",
  modelPendingLine: (label) =>
    `⚠ another chat is open here with no reply yet — it starts on **${label}**`,
  effortShort: "effort",
  effortActualLine: (value) => `effort: **${value}** — confirmed by the last turn`,
  effortPlannedLine: (value) => `effort: **${value}** — planned (from Claude Code settings)`,
  effortChangedLine: (from, to) => `⚠ **effort changed:** ${from} → ${to}`,
  subagentsLine: (count, total, breakdown) => `subagents: ${count} · ≈${total} tok — ${breakdown}`,
  subagentsMore: (n) => `+${n} more`,
  subagentsCount: (n) => (n === 1 ? "1 agent" : `${n} agents`),
  subagentDepth: (depth) => `depth ${depth}`,
  panelSubagentsHeader: "Delegated work (subagents)",
  panelSubagentsSummary: (count, total, share) =>
    `${count} subagent${count === 1 ? "" : "s"} · ≈ ${total} tok — ${share}% of this session's consumption`,
  panelSubagentsNote:
    "Models here are chosen by the agent that spawned each worker — the Lead, or another agent when depth > 1. Ask for a specific model in your task if a cheaper one would do: this is where delegated tokens actually go.",
  panelSubagentsRebuild: (cost, share) =>
    `of that, ${cost} (${share} of what the agents spent) went on reloading context after pauses — an agent's cache usually stays warm for 5 minutes`,
  panelSubagentsRebuildHint:
    "While an agent waits, its cache goes cold — usually 5 minutes for a subagent, an hour for the main " +
    "session, though each stream's own lifetime is read from its transcript rather than assumed. " +
    "After a long enough pause it loads its whole context again and pays for that as a new cache write. " +
    "This is how many tokens went into such reloads. A pause is sometimes unavoidable, but it is paid for " +
    "all the same — which is why the figure is shown as it is.",
  panelSubagentsRebuildNote:
    "A pause past the agent's cache lifetime — five minutes for most agents — makes it load its whole context again. The pause can be the agent left open while another one works, or the agent's own command running long, such as a test suite or a build. Where it is the first, starting a fresh agent with a smaller prompt is often cheaper.",
  subagentsRebuildFragment: (cost) => `${cost} reloaded after pauses`,
  panelSubagentsExpand: "Show each agent ▾",
  panelSubagentsCollapse: "Hide the agent list ▴",
  panelAgentIdle: (pct, cost, atLeast) =>
    pct && cost
      ? atLeast
        ? `idle ≥ ${pct}% (≥ ${cost})`
        : `idle ${pct}% (≈ ${cost})`
      : pct
      ? atLeast
        ? `idle ≥ ${pct}%`
        : `idle ${pct}%`
      : cost
      ? atLeast
        ? `idle ≥ ${cost}`
        : `idle ≈ ${cost}`
      : "idle —",
  panelAgentIdleUnknown: "idle —",
  agentFallbackName: "agent",
  panelAgentIdleLegend:
    "idle — the share of that agent's own spend that went on loading its context again after a pause. " +
    "0% means no waiting cost was measured for it — every pause it took was judged, and none of them " +
    "priced to anything; " +
    "a dash means the log did not allow the measurement, which is a different thing from zero. " +
    "A figure above zero means one of its pauses outlasted its cache. This measurement does not look at " +
    "what filled the pause: the agent may have been left open while another one worked, or its own " +
    "command may have run long — a test run, a build.",
  panelAtLeastNote:
    "≥ marks a figure measured from part of the log only: some pauses could not be judged, so the real " +
    "number can be higher, never lower.",
  atLeastShort: "≥ = measured from part of the log; the real figure can be higher, never lower",
  detailsRebuild: (tokens) => `after-idle reloads ${tokens}`,
  title: "**Claude Code — session usage**",
  costCompact: (withCache, noCache, mult, dir) =>
    `token-equivalent with cache ≈ **${withCache}** · without cache ≈ **${noCache}**` +
    (dir === "same"
      ? " (about the same so far)"
      : !mult
      ? ""
      : dir === "more"
      ? ` (~${mult}× lower)`
      : ` (~${mult}× higher so far)`),
  detailsLine: (work, cacheRead, cacheWrite) =>
    `work (in+out) ${work} · cache: read ${cacheRead} / write ${cacheWrite}`,
  contextLine: (used, limit, pct) => `context: ${pct}% (${used} / ${limit})`,
  contextNoLimit: (used, detail) => `context: ${used} (limit n/a${detail ? ` — ${detail}` : ""})`,
  contextLimitUnavailable: "context limit unavailable",
  tariffHeader: "**Subscription quota (real, from server):**",
  sessionHeader: "**This session:**",
  quotaReset: (remaining) => ` · resets in ${remaining}`,
  scopedLabel: (model) => `${model} (7d)`,
  quotaScopedAge: (ago) => ` · read ${ago} ago`,
  panelScopedHint:
    "A weekly window scoped to one model: it is capped at a share of the plan's weekly allowance, " +
    "so it can run out while the overall weekly limit still has room. Read from Claude Code's own " +
    "usage cache, which refreshes on its schedule — the age is shown when the reading is not recent.",
  verdict: {
    normal: "on track",
    tight: "running tight",
    over: "over pace",
  },
  quotaUnavail: (msg) => `_Quota 5h/7d: ${msg}._`,
  quotaStateMsg: {
    disabled: "polling is off (`ccStatusbar.quota.enabled`)",
    "no-credentials": "no token found at `~/.claude/.credentials.json`",
    "rate-limited": "temporary request limit — will retry later",
    error: "temporarily unavailable (request failed)",
  },
  quotaOfflineShort: {
    "no-credentials": "$(warning) no token",
    "rate-limited": "$(clock) quota paused",
    error: "$(cloud-offline) quota offline",
  },
  quotaAsOf: (ago) => `_Updated ${ago} ago._`,
  quotaPaused: (left) => `Polling paused by the server (rate limit) — resumes in ${left}. Click to retry now.`,
  quotaLastKnown: (windows, ago) => `Last known: ${windows} (updated ${ago} ago)`,
  localAlwaysAccurate:
    "_Raw token counters come from the local transcript. Token-equivalent uses this extension's cache weights._",
  legend: "_Dot color: 🟢 on track · 🟡 running tight · 🔴 over pace. Click the item to refresh._",
  switchLang: "🌐 Change language",
  openPanel: "⤢ Open panel",
  reportIssue: "Report an issue",
  panelTitle: "Claude Code — Session Usage",
  tok: "tok",
  panelCostLabel: "Token-equivalent with cache",
  panelSavedLabel: "Cache saved",
  panelCostCompare: (noCache, mult, dir, canReverse = true) =>
    dir === "same"
      ? `without cache ≈ ${noCache} tok — about the same${canReverse ? " so far" : ""}`
      : !mult
      ? `without cache ≈ ${noCache} tok`
      : dir === "more"
      ? `without cache ≈ ${noCache} tok — ~${mult}× more`
      : `without cache ≈ ${noCache} tok — ~${mult}× less${canReverse ? ", so far" : ""}`,
  panelCostWarmupHint:
    "The cache has not earned back what it cost yet. A cache write is charged at more than a fresh input " +
    "token (1-hour ×2.0, 5-minute ×1.25). While the premium those writes pay is bigger than what the " +
    "reads save, the with-cache figure is the larger of the two. At the default read weight (0.1) each " +
    "later read on the same cache narrows that gap.",
  panelCostWeightHint:
    "Cached input is priced above fresh input here, so reusing the cache does not lower this figure. " +
    "That is this extension's `ccStatusbar.cacheReadWeight` setting, not something the provider charges: " +
    "at its default (0.1) a cached token counts as a tenth of a fresh one.",
  panelCostNoCacheHint:
    "Nothing has been read from or written to cache in this session yet, so the two figures are the " +
    "same number. Once the cache is used, the weights in your settings decide whether they part " +
    "company — and by how much.",
  panelCostEvenHint:
    // No second sentence. Every "at the default weights it would…" that stood
    // here was false in some state that reaches this branch — a write-only
    // session at weight 1 is level here and dearer at the defaults.
    "The cache is being used, but at the weights in your settings it is not moving this figure either " +
    "way.",
  panelCostTooSmallHint:
    "The cache has cost slightly more than it has saved so far — by too little to change either figure " +
    "as they are printed here. At the default read weight (0.1) each later read on the same cache " +
    "narrows that gap.",
  panelCostBothHint:
    "Both sides of the cache add to this figure here. A write is charged above the tokens it holds " +
    "(1-hour ×2.0, 5-minute ×1.25, an unstated tier by your `ccStatusbar.cacheWriteWeight`), and reads " +
    "add to it too, because your `ccStatusbar.cacheReadWeight` is above 1 — so reuse saves nothing " +
    "against reading the same input fresh. At its default (0.1) it would.",
  lowerMult: (mult) => `(~${mult}× lower)`,
  panelTokenCostNote:
    "Calculated from real local token counters. The cache multiplier is this extension's token-equivalent estimate, not a money price.",
  panelDetailsHeader: "Details",
  panelQuotaHeader: "Subscription quota (real, from server)",
  panelLocalAccurate:
    "Raw token counters come from the local transcript. Token-equivalent uses this extension's cache weights.",
  panelLegend: "🟢 on track · 🟡 running tight · 🔴 over pace · updates live",
  // Same rename as the panel: "tier" is jargon, and it survived here when the
  // panel row was reworded. One vocabulary across every surface.
  cacheTierLine: (tier) =>
    tier === "1h"
      ? "🗄 Cache stays warm — 1 hour idle"
      : "🗄 Cache stays warm — 5 minutes idle; longer pauses rebuild it",
  panelCacheHeader: "Cache",
  // "Tier" was jargon. The label + value now read as one sentence — the hover
  // footnote below is unchanged and still carries the full explanation.
  panelCacheTierLabel: "Cache stays warm",
  panelCacheTierValue: { "1h": "1 hour idle", "5m": "5 minutes idle" },
  panelCacheTierHint:
    "How long your prompt cache stays warm while you are idle — read from this session, not configured. " +
    "1-hour: a subscription within its plan limit, so stepping away for up to an hour stays cheap. " +
    "5-minute: an API key, paid usage after you pass your plan limit, or (usually) a subagent — short breaks rebuild the cache and cost more. " +
    "Check it once to know how long a break you can take; you do not need to watch it.",
  panelCacheHitLabel: "Input from cache",
  panelCacheHitHint:
    "Share of your prompt served from cache (cheap) instead of re-read fresh. Higher means the cache is being reused well. " +
    "It is normal to start low and climb as the session warms up; a persistently low value usually means frequent model/effort switches or many new files. " +
    "A descriptive read of where this session's tokens went — not a score.",
};

/** Russian plural forms: 1 саб-агент · 2–4 саб-агента · 5+ саб-агентов.
 *  "саб-агент(ов)" reads like a form field, not a sentence. */
function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const RU: Messages = {
  units: { d: "д", h: "ч", m: "м" },
  providerNames: { auto: "Авто", claude: "Claude Code", codex: "Codex" },
  providerDescriptions: {
    auto: "Выбирать активный источник для этой рабочей папки",
    claude: "Использовать текущий путь Claude Code: транскрипт и тариф",
    codex: "Использовать данные Codex: расход, тариф, контекст и кэш",
  },
  providerSelectPlaceholder: "Провайдер расхода",
  providerSet: (provider) => `Провайдер: ${provider}`,
  providerTooltipLine: (mode, active) => `провайдер: ${mode} · показан ${active}`,
  languageChoicesHeader: "Язык",
  languageNames: { auto: "Авто", ru: "RU", en: "EN" },
  providerUnavailableText: (provider) => `$(warning) ${provider}: н/д`,
  providerUnavailableTooltip: (provider, detail) =>
    `**${provider} недоступен**\n\n${detail}\n\n[Выбрать провайдера](command:ccStatusbar.selectProvider) · [Claude Code](command:ccStatusbar.useClaude)`,
  providerConflictText: "$(warning) LLM: выберите источник",
  providerConflictTooltip:
    "**Выберите источник расхода**\n\nДля этой рабочей папки обнаружены активные сессии Claude Code и Codex.\n\n[Выбрать провайдера](command:ccStatusbar.selectProvider)",
  chooseProvider: "Выбрать провайдера",
  useClaude: "Claude Code",
  codexTitle: "**Codex — расход сессии**",
  codexQuotaHeader: "**Тариф (реальный, с сервера):**",
  codexAppServerLine: (source, plan, userAgent) =>
    `app-server: ${source}${plan ? ` · план ${plan}` : ""}${userAgent ? ` · ${userAgent}` : ""}`,
  codexCostCompact: (withCache, noCache, mult, dir, canReverse = true) =>
    `токен-эквивалент с кэшем ≈ **${withCache}** · без кэша ≈ **${noCache}**` +
    (dir === "same"
      ? ` (${canReverse ? "пока " : ""}примерно столько же)`
      : !mult
      ? ""
      : dir === "more"
      ? ` (в ~${mult}× меньше)`
      : ` (${canReverse ? "пока " : ""}в ~${mult}× больше)`),
  codexUsageWaitingCompact: "токен-эквивалент с кэшем: появится после следующего ответа Codex",
  codexContextShortUnavailable: "$(info) конт н/д",
  codexContextNoWindow: "окно контекста модели недоступно",
  codexContextWaitingLine: "контекст: появится после следующего ответа Codex",
  codexContextWaitingPanel:
    "Контекст появится после следующего ответа Codex. Для старой истории Codex пока не отдаёт это число.",
  codexPanelTitle: "Codex — расход сессии",
  codexPanelCostLabel: "Токен-эквивалент с кэшем",
  codexPanelSavedLabel: "Сэкономлено кэшем",
  codexPanelNoCacheReadHint:
    "В этой сессии из кэша ещё ничего не читалось, поэтому оба числа одинаковые. " +
    "Для записей в кэш у Codex отдельный счётчик, поэтому о том, что он уже мог сохранить, это ничего не говорит.",
  codexPanelWarmupHint:
    "Кэш пока не вернул того, что стоил. Срок жизни кэша Codex не сообщает, поэтому запись оценивается " +
    "по вашему параметру `ccStatusbar.cacheWriteWeight` (по умолчанию 1.25) — дороже свежего входного " +
    "токена. Пока эта надбавка больше, чем экономия на чтениях, число с кэшем оказывается больше. " +
    "При весе чтения по умолчанию (0.1) каждое следующее чтение из того же кэша сокращает разрыв.",
  codexPanelBothHint:
    "Здесь обе стороны кэша только увеличивают это число. Запись считается дороже тех токенов, что в " +
    "ней (срок жизни кэша Codex не сообщает, поэтому запись идёт по вашему " +
    "`ccStatusbar.cacheWriteWeight`), и чтение тоже, потому что ваш `ccStatusbar.cacheReadWeight` " +
    "больше 1 — переиспользование не экономит ничего против свежего чтения того же ввода. " +
    "При значении по умолчанию (0.1) — экономило бы.",
  codexPanelWritePricedHint: (tokens) =>
    `Из ввода выше ${tokens} ток. записаны в кэш. В документации OpenAI этот счётчик — часть счётчика ` +
    `ввода, а не добавка к нему, поэтому эти токены посчитаны один раз: по весу записи, а не как обычный ` +
    `свежий ввод. Запись дороже свежего токена — это и есть цена прогрева. В строке «Детали» число ` +
    `показано ровно так, как его назвал Codex.`,
  codexLowerMult: (mult) => `(в ~${mult}× меньше)`,
  codexPanelUsageWaiting: "Токен-эквивалент появится после следующего ответа Codex.",
  codexPanelTokenCostNote:
    "Рассчитано из реальных локальных счётчиков токенов. Коэффициент кэша — токен-эквивалент расширения, не денежная цена.",
  codexPanelQuotaHeader: "Тариф (реальный, с сервера)",
  codexPanelContextHeader: "Контекст",
  codexPanelCacheHeader: "Кэш",
  codexCacheWaitingLine: "кэш: появится после следующего ответа Codex",
  codexCacheWaitingPanel: "Данные по кэшу появятся после следующего ответа Codex.",
  codexCacheHitLine: (pct) => `ввод из кэша: ${pct}`,
  codexCacheTierUnavailable: "н/д",
  codexDetailsLine: (work, cacheRead, cacheWrite) =>
    `работа (ввод+вывод) ${work} · кэш: чтение ${cacheRead} / запись ${cacheWrite ?? "н/д"}`,
  codexDetailsWaitingLine: "Детали по токенам появятся после следующего ответа Codex.",
  diagnosticsHeader: "**Диагностика:**",
  noFolder: "$(pulse) cc: нет папки",
  noFolderTip: "Откройте папку проекта, чтобы отслеживать его сессию Claude Code.",
  effShort: "эфф",
  w5h: "5ч",
  w7d: "7д",
  ctxShort: "конт",
  modelPlannedShort: "план",
  modelDefaultShort: "модель по умолчанию",
  modelActualLine: (label) => `модель: **${label}** — подтверждена последним ходом`,
  modelPlannedLine: (label) =>
    `модель: **${label}** — план для этого чата (из настроек Claude Code); подтвердится после первого ответа`,
  modelDefaultLine:
    "модель: **по умолчанию для аккаунта** — в настройках Claude Code ничего не закреплено; точная появится после первого ответа",
  modelChangedLine: (from, to) => `⚠ **модель сменилась:** ${from} → ${to}`,
  modelPendingShort: "новый чат:",
  modelPendingLine: (label) =>
    `⚠ рядом открыт чат без ответов — он стартует на **${label}**`,
  effortShort: "усилие",
  effortActualLine: (value) => `усилие: **${value}** — подтверждено последним ходом`,
  effortPlannedLine: (value) => `усилие: **${value}** — план (из настроек Claude Code)`,
  effortChangedLine: (from, to) => `⚠ **усилие сменилось:** ${from} → ${to}`,
  subagentsLine: (count, total, breakdown) => `саб-агенты: ${count} · ≈${total} ток — ${breakdown}`,
  subagentsMore: (n) => `ещё +${n}`,
  subagentsCount: (n) => `${n} шт.`,
  subagentDepth: (depth) => `уровень ${depth}`,
  panelSubagentsHeader: "Делегировано саб-агентам",
  panelSubagentsSummary: (count, total, share) =>
    `${count} ${pluralRu(count, "саб-агент", "саб-агента", "саб-агентов")} · ≈ ${total} ток — ${share}% расхода этой сессии`,
  panelSubagentsNote:
    "Модель выбирает тот, кто запустил агента: лид — или другой агент, если уровень больше 1. Если задача проще, попросите конкретную модель прямо в ТЗ: именно сюда уходят делегированные токены.",
  panelSubagentsRebuild: (cost, share) =>
    `из них ${cost} (${share} расхода агентов) ушло на повторную загрузку контекста после пауз — кэш агента обычно держится 5 минут`,
  panelSubagentsRebuildHint:
    "Пока агент ждёт, его кэш остывает — обычно 5 минут у субагента и час у основной сессии, но срок " +
    "жизни каждого кэша читается из его же журнала, а не предполагается. " +
    "После долгой паузы он загружает весь свой контекст заново и платит за это как за новую запись. " +
    "Здесь показано, сколько токенов ушло на такие повторные загрузки. Пауза бывает вынужденной, " +
    "но оплачена она в любом случае — поэтому цифра показана как есть.",
  panelSubagentsRebuildNote:
    "Пауза дольше срока жизни кэша — у большинства агентов это пять минут — заставляет агента загрузить весь свой контекст заново. Паузой может быть и агент, оставленный открытым, пока работает другой, и его собственная долгая команда — прогон тестов, сборка. В первом случае дешевле бывает запустить нового агента с коротким заданием.",
  subagentsRebuildFragment: (cost) => `${cost} на повторную загрузку после пауз`,
  panelSubagentsExpand: "Показать по агентам ▾",
  panelSubagentsCollapse: "Свернуть список агентов ▴",
  panelAgentIdle: (pct, cost, atLeast) =>
    pct && cost
      ? atLeast
        ? `простой ≥ ${pct}% (≥ ${cost})`
        : `простой ${pct}% (≈ ${cost})`
      : pct
      ? atLeast
        ? `простой ≥ ${pct}%`
        : `простой ${pct}%`
      : cost
      ? atLeast
        ? `простой ≥ ${cost}`
        : `простой ≈ ${cost}`
      : "простой —",
  panelAgentIdleUnknown: "простой —",
  agentFallbackName: "агент",
  panelAgentIdleLegend:
    "простой — доля расхода самого агента, ушедшая на повторную загрузку его контекста после паузы. " +
    "0% значит, что расхода на ожидание у него не обнаружено — все паузы измерены, и ни одна ничего " +
    "не стоила; " +
    "прочерк значит, что измерить по журналу не удалось, а это не то же самое, что ноль. " +
    "Цифра больше нуля значит, что одна из пауз пережила его кэш. Чем была занята пауза, этот замер не " +
    "смотрит: агента могли держать открытым, пока работал другой, а могла долго идти его собственная " +
    "команда — прогон тестов, сборка.",
  panelAtLeastNote:
    "Знак ≥ значит, что цифра измерена не по всему журналу: часть пауз оценить не удалось, поэтому " +
    "настоящее число может быть больше, но не меньше.",
  atLeastShort: "≥ — измерено не по всему журналу; настоящее число может быть больше, но не меньше",
  detailsRebuild: (tokens) => `повторные загрузки после простоя ${tokens}`,
  title: "**Claude Code — расход сессии**",
  costCompact: (withCache, noCache, mult, dir) =>
    `токен-эквивалент с кэшем ≈ **${withCache}** · без кэша ≈ **${noCache}**` +
    (dir === "same"
      ? " (пока примерно столько же)"
      : !mult
      ? ""
      : dir === "more"
      ? ` (в ~${mult}× меньше)`
      : ` (пока в ~${mult}× больше)`),
  detailsLine: (work, cacheRead, cacheWrite) =>
    `работа (ввод+вывод) ${work} · кэш: чтение ${cacheRead} / запись ${cacheWrite}`,
  contextLine: (used, limit, pct) => `контекст: ${pct}% (${used} / ${limit})`,
  contextNoLimit: (used, detail) => `контекст: ${used} (лимит н/д${detail ? ` — ${detail}` : ""})`,
  contextLimitUnavailable: "лимит контекста недоступен",
  tariffHeader: "**Тариф (реальный, с сервера):**",
  sessionHeader: "**Эта сессия:**",
  quotaReset: (remaining) => ` · сброс через ${remaining}`,
  scopedLabel: (model) => `${model} (7д)`,
  quotaScopedAge: (ago) => ` · данные ${ago} назад`,
  panelScopedHint:
    "Недельное окно для одной модели: ей отведена доля недельного лимита плана, поэтому она может " +
    "закончиться раньше, чем общий недельный лимит. Читается из собственного кэша расхода Claude Code, " +
    "он обновляется по своему расписанию — если значение не свежее, рядом показан его возраст.",
  verdict: {
    normal: "в норме",
    tight: "близко к лимиту",
    over: "выше нормы",
  },
  quotaUnavail: (msg) => `_Тариф 5ч/7д: ${msg}._`,
  quotaStateMsg: {
    disabled: "опрос выключен (`ccStatusbar.quota.enabled`)",
    "no-credentials": "не найден токен `~/.claude/.credentials.json`",
    "rate-limited": "временный лимит запросов — повтор позже",
    error: "временно недоступен (запрос не прошёл)",
  },
  quotaOfflineShort: {
    "no-credentials": "$(warning) нет токена",
    "rate-limited": "$(clock) лимиты: пауза",
    error: "$(cloud-offline) лимиты офлайн",
  },
  quotaAsOf: (ago) => `_Обновлено ${ago} назад._`,
  quotaPaused: (left) => `Опрос на паузе по требованию сервера (лимит запросов) — возобновится через ${left}. Клик — повторить сейчас.`,
  quotaLastKnown: (windows, ago) => `Последнее известное: ${windows} (обновлено ${ago} назад)`,
  localAlwaysAccurate:
    "_Сырые счётчики токенов взяты из локального транскрипта. Токен-эквивалент использует веса кэша расширения._",
  legend: "_Цвет точки: 🟢 в норме · 🟡 близко к лимиту · 🔴 выше нормы. Клик по строке — обновить._",
  switchLang: "🌐 Сменить язык",
  openPanel: "⤢ Открыть панель",
  reportIssue: "Сообщить о проблеме",
  panelTitle: "Claude Code — расход сессии",
  tok: "ток",
  panelCostLabel: "Токен-эквивалент с кэшем",
  panelSavedLabel: "Сэкономлено кэшем",
  panelCostCompare: (noCache, mult, dir, canReverse = true) =>
    dir === "same"
      ? `без кэша было бы ≈ ${noCache} ток — ${canReverse ? "пока " : ""}примерно столько же`
      : !mult
      ? `без кэша было бы ≈ ${noCache} ток`
      : dir === "more"
      ? `без кэша было бы ≈ ${noCache} ток — в ~${mult}× больше`
      : `без кэша было бы ≈ ${noCache} ток — ${canReverse ? "пока " : ""}в ~${mult}× меньше`,
  panelCostWarmupHint:
    "Кэш пока не вернул того, что стоил. Запись в кэш дороже свежего входного токена (часовая ×2.0, " +
    "пятиминутная ×1.25). Пока эта надбавка за записи больше, чем экономия на чтениях, число с кэшем " +
    "оказывается больше. При весе чтения по умолчанию (0.1) каждое следующее чтение из того же кэша " +
    "сокращает разрыв.",
  panelCostWeightHint:
    "Ввод из кэша здесь оценён дороже свежего, поэтому переиспользование кэша это число не уменьшает. " +
    "Так настроен параметр `ccStatusbar.cacheReadWeight` самого расширения, это не цена провайдера: " +
    "по умолчанию (0.1) токен из кэша считается за десятую часть свежего.",
  panelCostNoCacheHint:
    "В этой сессии кэш ещё не читался и не записывался, поэтому оба числа одинаковые. " +
    "Когда кэш заработает, разойдутся ли эти числа — и насколько — решают веса из ваших настроек.",
  panelCostEvenHint:
    // Второго предложения нет: любое «а при весах по умолчанию было бы…»
    // оказывалось ложным в каком-то из состояний, попадающих сюда.
    "Кэш работает, но при весах из ваших настроек он это число не меняет ни в одну сторону.",
  panelCostTooSmallHint:
    "Кэш пока стоил чуть больше, чем сэкономил, — и разница слишком мала, чтобы изменить хоть одну " +
    "цифру в том виде, в каком они здесь напечатаны. При весе чтения по умолчанию (0.1) каждое " +
    "следующее чтение из того же кэша сокращает разрыв.",
  panelCostBothHint:
    "Здесь обе стороны кэша только увеличивают это число. Запись считается дороже тех токенов, что в " +
    "ней (часовая ×2.0, пятиминутная ×1.25, тир не указан — по вашему `ccStatusbar.cacheWriteWeight`), " +
    "и чтение тоже, потому что ваш `ccStatusbar.cacheReadWeight` больше 1 — переиспользование не " +
    "экономит ничего против свежего чтения того же ввода. При значении по умолчанию (0.1) — экономило бы.",
  lowerMult: (mult) => `(в ~${mult}× меньше)`,
  panelTokenCostNote:
    "Рассчитано из реальных локальных счётчиков токенов. Коэффициент кэша — токен-эквивалент расширения, не денежная цена.",
  panelDetailsHeader: "Детали",
  panelQuotaHeader: "Тариф (реальный, с сервера)",
  panelLocalAccurate:
    "Сырые счётчики токенов взяты из локального транскрипта. Токен-эквивалент использует веса кэша расширения.",
  panelLegend: "🟢 в норме · 🟡 близко к лимиту · 🔴 выше нормы · обновляется в реальном времени",
  // Та же правка, что в панели: «тир» — жаргон, и здесь он уцелел, когда строку
  // панели переписали. Один словарь на всех поверхностях.
  cacheTierLine: (tier) =>
    tier === "1h"
      ? "🗄 Кэш держится — 1 час простоя"
      : "🗄 Кэш держится — 5 минут простоя; паузы дольше перестраивают его",
  panelCacheHeader: "Кэш",
  // «Тир» — жаргон. Метка и значение теперь читаются одной фразой; сноска ⓘ
  // ниже не изменилась и по-прежнему объясняет всё полностью.
  panelCacheTierLabel: "Кэш держится",
  panelCacheTierValue: { "1h": "1 час простоя", "5m": "5 минут простоя" },
  panelCacheTierHint:
    "Сколько prompt-кэш остаётся «тёплым», пока вы не печатаете — определяется из этой сессии, не настраивается. " +
    "Часовой: подписка в пределах лимита плана — можно отойти на час, и это дёшево. " +
    "5-минутный: API-ключ, платный расход после превышения плана или (обычно) субагент — короткие паузы перестраивают кэш и стоят дороже. " +
    "Достаточно глянуть один раз, чтобы понять, какую паузу можно себе позволить; постоянно следить не нужно.",
  panelCacheHitLabel: "Ввод из кэша",
  panelCacheHitHint:
    "Доля промпта, обслуженная из кэша (дёшево), а не прочитанная заново. Выше — кэш переиспользуется хорошо. " +
    "Нормально начинать с низкого и расти по мере прогрева сессии; стабильно низкое обычно значит частые переключения модели/effort или много новых файлов. " +
    "Это описание того, куда ушли токены сессии, — не оценка.",
};

const TABLE: Record<Lang, Messages> = { en: EN, ru: RU };

export function messages(lang: Lang): Messages {
  return TABLE[lang];
}
