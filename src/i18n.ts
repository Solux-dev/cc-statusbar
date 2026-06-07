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
  quotaReset: (remaining: string) => string;
  verdict: Record<PaceLevel, string>;
  quotaUnavail: (msg: string) => string;
  quotaStateMsg: Record<Exclude<QuotaState, "ok">, string>;
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
  title: "**Claude Code — session usage**",
  costCompact: (withCache, noCache, mult) =>
    `token-equivalent with cache ≈ **${withCache}** · without cache ≈ **${noCache}** (~${mult}× lower)`,
  detailsLine: (work, cacheRead, cacheWrite) =>
    `work (in+out) ${work} · cache: read ${cacheRead} / write ${cacheWrite}`,
  contextLine: (used, limit, pct) => `context: ${pct}% (${used} / ${limit})`,
  contextNoLimit: (used, detail) => `context: ${used} (limit n/a${detail ? ` — ${detail}` : ""})`,
  contextLimitUnavailable: "context limit unavailable",
  tariffHeader: "**Subscription quota (real, from server):**",
  quotaReset: (remaining) => ` · resets in ${remaining}`,
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
  panelCacheTierLabel: "Tier",
  panelCacheTierValue: { "1h": "1-hour", "5m": "5-minute" },
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
  title: "**Claude Code — расход сессии**",
  costCompact: (withCache, noCache, mult) =>
    `токен-эквивалент с кэшем ≈ **${withCache}** · без кэша ≈ **${noCache}** (в ~${mult}× меньше)`,
  detailsLine: (work, cacheRead, cacheWrite) =>
    `работа (ввод+вывод) ${work} · кэш: чтение ${cacheRead} / запись ${cacheWrite}`,
  contextLine: (used, limit, pct) => `контекст: ${pct}% (${used} / ${limit})`,
  contextNoLimit: (used, detail) => `контекст: ${used} (лимит н/д${detail ? ` — ${detail}` : ""})`,
  contextLimitUnavailable: "лимит контекста недоступен",
  tariffHeader: "**Тариф (реальный, с сервера):**",
  quotaReset: (remaining) => ` · сброс через ${remaining}`,
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
  panelCacheTierLabel: "Тир",
  panelCacheTierValue: { "1h": "часовой", "5m": "5-минутный" },
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
