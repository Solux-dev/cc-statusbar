// Self-contained i18n for the runtime UI (status bar + hover tooltip).
//
// Why not VS Code's built-in l10n bundles? Those follow the editor's display
// language fixed at startup. We expose a `ccStatusbar.language: auto|en|ru`
// setting so a user can pick the plugin's language independently — handy when
// the editor is in English but the user prefers Russian (or vice-versa). All
// strings live here as plain data + tiny formatters, so render.ts stays pure
// and unit-testable in both languages.

import { PaceLevel } from "./metrics";

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
  codexCostCompact: (withCache: string, noCache: string, mult: string) => string;
  codexUsageWaitingCompact: string;
  codexContextShortUnavailable: string;
  codexContextWaitingLine: string;
  codexContextWaitingPanel: string;
  codexPanelTitle: string;
  codexPanelCostLabel: string;
  codexPanelNoCacheLabel: string;
  codexPanelSavedLabel: string;
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
  codexDetailsLine: (work: string, cacheRead: string) => string;
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
   *  agents spent went on reloading context after a pause. Shown only above the
   *  threshold — an advisory line that is always there is noise. */
  panelSubagentsRebuild: (cost: string) => string;
  /** Hover footnote (ⓘ) for that line. The visible line must read without it. */
  panelSubagentsRebuildHint: string;
  /** Appended to the closing note when reloads dominate what the agents wrote.
   *  States the cause and the measured alternative — never a grade. */
  panelSubagentsRebuildNote: string;
  /** Tooltip fragment appended to the subagents line, same high bar. */
  subagentsRebuildFragment: (cost: string) => string;
  /** The LEAD's own reloads, muted, in Details — raw tokens, no advice: the
   *  owner stepping away is not a defect. */
  detailsRebuild: (tokens: string) => string;
  // tooltip
  title: string;
  // token-equivalent headline: one compact line (with cache · without · ×lower)
  costCompact: (withCache: string, noCache: string, mult: string) => string;
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
  panelTitle: string; // webview panel tab title
  // webview panel (plain text — HTML provides the styling)
  tok: string;
  panelCostLabel: string; // "Token-equivalent with cache" / "Токен-эквивалент с кэшем"
  panelNoCacheLabel: string; // "Without cache" / "Без кэша было бы"
  panelSavedLabel: string; // "Cache saved" / "Сэкономлено кэшем"
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
  codexCostCompact: (withCache, noCache, mult) =>
    `token-equivalent with cache ≈ **${withCache}** · without cache ≈ **${noCache}** (~${mult}× lower)`,
  codexUsageWaitingCompact: "token-equivalent with cache: will appear after the next Codex response",
  codexContextShortUnavailable: "$(info) ctx n/a",
  codexContextWaitingLine: "context: waiting for the next Codex response",
  codexContextWaitingPanel:
    "Context will appear after the next Codex response. Codex does not expose this number for older history yet.",
  codexPanelTitle: "Codex — Session Usage",
  codexPanelCostLabel: "Token-equivalent with cache",
  codexPanelNoCacheLabel: "Without cache",
  codexPanelSavedLabel: "Cache saved",
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
  codexDetailsLine: (work, cacheRead) => `work (input+output) ${work} · cache: read ${cacheRead} / write n/a`,
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
  panelSubagentsRebuild: (cost) =>
    `of that, ≈ ${cost} went on reloading context after pauses — an agent's cache stays warm for 5 minutes`,
  panelSubagentsRebuildHint:
    "While an agent waits, its cache goes cold — 5 minutes for subagents, 1 hour for the main session. " +
    "After a long enough pause it loads its whole context again and pays for that as a new cache write. " +
    "This is how many tokens went into such reloads. A pause is sometimes unavoidable, but it is paid for " +
    "all the same — which is why the figure is shown as it is.",
  panelSubagentsRebuildNote:
    "Usually an agent left open while another one works. Past five minutes of waiting, a fresh agent costs less than the one that waited.",
  subagentsRebuildFragment: (cost) => `${cost} reloaded after pauses`,
  detailsRebuild: (tokens) => `after-idle reloads ${tokens}`,
  title: "**Claude Code — session usage**",
  costCompact: (withCache, noCache, mult) =>
    `token-equivalent with cache ≈ **${withCache}** · without cache ≈ **${noCache}** (~${mult}× lower)`,
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
  panelTitle: "Claude Code — Session Usage",
  tok: "tok",
  panelCostLabel: "Token-equivalent with cache",
  panelNoCacheLabel: "Without cache",
  panelSavedLabel: "Cache saved",
  lowerMult: (mult) => `(~${mult}× lower)`,
  panelTokenCostNote:
    "Calculated from real local token counters. The cache multiplier is this extension's token-equivalent estimate, not a money price.",
  panelDetailsHeader: "Details",
  panelQuotaHeader: "Subscription quota (real, from server)",
  panelLocalAccurate:
    "Raw token counters come from the local transcript. Token-equivalent uses this extension's cache weights.",
  panelLegend: "🟢 on track · 🟡 running tight · 🔴 over pace · updates live",
  cacheTierLine: (tier) =>
    tier === "1h"
      ? "🗄 Cache: 1-hour tier — survives ~1h idle"
      : "🗄 Cache: 5-minute tier — pauses over 5 min rebuild it",
  panelCacheHeader: "Cache",
  // "Tier" was jargon. The label + value now read as one sentence — the hover
  // footnote below is unchanged and still carries the full explanation.
  panelCacheTierLabel: "Cache stays warm",
  panelCacheTierValue: { "1h": "1 hour idle", "5m": "5 minutes idle" },
  panelCacheTierHint:
    "How long your prompt cache stays warm while you are idle — read from this session, not configured. " +
    "1-hour: a subscription within its plan limit, so stepping away for up to an hour stays cheap. " +
    "5-minute: an API key, paid usage after you pass your plan limit, or subagents — short breaks rebuild the cache and cost more. " +
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
  codexCostCompact: (withCache, noCache, mult) =>
    `токен-эквивалент с кэшем ≈ **${withCache}** · без кэша ≈ **${noCache}** (в ~${mult}× меньше)`,
  codexUsageWaitingCompact: "токен-эквивалент с кэшем: появится после следующего ответа Codex",
  codexContextShortUnavailable: "$(info) конт н/д",
  codexContextWaitingLine: "контекст: появится после следующего ответа Codex",
  codexContextWaitingPanel:
    "Контекст появится после следующего ответа Codex. Для старой истории Codex пока не отдаёт это число.",
  codexPanelTitle: "Codex — расход сессии",
  codexPanelCostLabel: "Токен-эквивалент с кэшем",
  codexPanelNoCacheLabel: "Без кэша было бы",
  codexPanelSavedLabel: "Сэкономлено кэшем",
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
  codexDetailsLine: (work, cacheRead) => `работа (ввод+вывод) ${work} · кэш: чтение ${cacheRead} / запись н/д`,
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
  panelSubagentsRebuild: (cost) =>
    `из них ≈ ${cost} ушло на повторную загрузку контекста после пауз — кэш агента держится 5 минут`,
  panelSubagentsRebuildHint:
    "Пока агент ждёт, его кэш остывает — 5 минут у субагентов, 1 час у основной сессии. " +
    "После долгой паузы он загружает весь свой контекст заново и платит за это как за новую запись. " +
    "Здесь показано, сколько токенов ушло на такие повторные загрузки. Пауза бывает вынужденной, " +
    "но оплачена она в любом случае — поэтому цифра показана как есть.",
  panelSubagentsRebuildNote:
    "Обычно это агент, оставленный открытым, пока работает другой. После пяти минут ожидания новый агент обходится дешевле, чем тот, который ждал.",
  subagentsRebuildFragment: (cost) => `${cost} на повторную загрузку после пауз`,
  detailsRebuild: (tokens) => `повторные загрузки после простоя ${tokens}`,
  title: "**Claude Code — расход сессии**",
  costCompact: (withCache, noCache, mult) =>
    `токен-эквивалент с кэшем ≈ **${withCache}** · без кэша ≈ **${noCache}** (в ~${mult}× меньше)`,
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
  panelTitle: "Claude Code — расход сессии",
  tok: "ток",
  panelCostLabel: "Токен-эквивалент с кэшем",
  panelNoCacheLabel: "Без кэша было бы",
  panelSavedLabel: "Сэкономлено кэшем",
  lowerMult: (mult) => `(в ~${mult}× меньше)`,
  panelTokenCostNote:
    "Рассчитано из реальных локальных счётчиков токенов. Коэффициент кэша — токен-эквивалент расширения, не денежная цена.",
  panelDetailsHeader: "Детали",
  panelQuotaHeader: "Тариф (реальный, с сервера)",
  panelLocalAccurate:
    "Сырые счётчики токенов взяты из локального транскрипта. Токен-эквивалент использует веса кэша расширения.",
  panelLegend: "🟢 в норме · 🟡 близко к лимиту · 🔴 выше нормы · обновляется в реальном времени",
  cacheTierLine: (tier) =>
    tier === "1h"
      ? "🗄 Кэш: часовой тир — живёт ~1ч простоя"
      : "🗄 Кэш: 5-мин тир — паузы дольше 5 мин перестраивают его",
  panelCacheHeader: "Кэш",
  // «Тир» — жаргон. Метка и значение теперь читаются одной фразой; сноска ⓘ
  // ниже не изменилась и по-прежнему объясняет всё полностью.
  panelCacheTierLabel: "Кэш держится",
  panelCacheTierValue: { "1h": "1 час простоя", "5m": "5 минут простоя" },
  panelCacheTierHint:
    "Сколько prompt-кэш остаётся «тёплым», пока вы не печатаете — определяется из этой сессии, не настраивается. " +
    "Часовой: подписка в пределах лимита плана — можно отойти на час, и это дёшево. " +
    "5-минутный: API-ключ, платный расход после превышения плана или субагенты — короткие паузы перестраивают кэш и стоят дороже. " +
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
