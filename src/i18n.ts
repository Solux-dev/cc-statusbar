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
  // status-bar (collapsed)
  noFolder: string;
  noFolderTip: string;
  effShort: string; // "eff" / "эфф" — fallback bar prefix
  w5h: string; // short window label "5h" / "5ч"
  w7d: string;
  ctxShort: string; // collapsed-bar context label "ctx" / "конт"
  // tooltip
  title: string;
  // cost-first headline: one compact line (with caching · without · ×cheaper)
  costCompact: (withCache: string, noCache: string, mult: string) => string;
  // muted technical breakdown (tooltip + panel "Details")
  detailsLine: (work: string, cacheRead: string, cacheWrite: string) => string;
  // context window fill
  contextLine: (used: string, limit: string, pct: number) => string;
  contextNoLimit: (used: string) => string;
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
  panelCostLabel: string; // "This session cost" / "Стоило (с учётом кэша)"
  panelNoCacheLabel: string; // "Without caching" / "Без кэша было бы"
  panelSavedLabel: string; // "💰 Cache saved" / "💰 Экономия за счёт кэша"
  cheaperMult: (mult: string) => string; // "(~6.8× cheaper)" / "(в ~6.8× дешевле)"
  panelDetailsHeader: string; // "Details" / "Детали"
  panelQuotaHeader: string;
  panelLocalAccurate: string;
  panelLegend: string;
}

const EN: Messages = {
  units: { d: "d", h: "h", m: "m" },
  noFolder: "$(pulse) cc: no folder",
  noFolderTip: "Open a project folder to track its Claude Code session.",
  effShort: "eff",
  w5h: "5h",
  w7d: "7d",
  ctxShort: "ctx",
  title: "**Claude Code — session usage**",
  costCompact: (withCache, noCache, mult) =>
    `with cache ≈ **${withCache}** · without cache ≈ **${noCache}** (~${mult}× cheaper)`,
  detailsLine: (work, cacheRead, cacheWrite) =>
    `work (in+out) ${work} · cache: read ${cacheRead} / write ${cacheWrite}`,
  contextLine: (used, limit, pct) => `context: ${pct}% (${used} / ${limit})`,
  contextNoLimit: (used) => `context: ${used} (limit n/a)`,
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
  localAlwaysAccurate: "_The numbers above come from the local transcript — always accurate._",
  legend: "_Dot color: 🟢 on track · 🟡 running tight · 🔴 over pace. Click the item to refresh._",
  switchLang: "🌐 Change language",
  openPanel: "⤢ Open panel",
  panelTitle: "Claude Code — Session Usage",
  tok: "tok",
  panelCostLabel: "This session cost",
  panelNoCacheLabel: "Without caching",
  panelSavedLabel: "💰 Cache saved",
  cheaperMult: (mult) => `(~${mult}× cheaper)`,
  panelDetailsHeader: "Details",
  panelQuotaHeader: "Subscription quota (real, from server)",
  panelLocalAccurate: "The numbers above come from the local transcript — always accurate.",
  panelLegend: "🟢 on track · 🟡 running tight · 🔴 over pace · updates live",
};

const RU: Messages = {
  units: { d: "д", h: "ч", m: "м" },
  noFolder: "$(pulse) cc: нет папки",
  noFolderTip: "Откройте папку проекта, чтобы отслеживать его сессию Claude Code.",
  effShort: "эфф",
  w5h: "5ч",
  w7d: "7д",
  ctxShort: "конт",
  title: "**Claude Code — расход сессии**",
  costCompact: (withCache, noCache, mult) =>
    `с кэшем ≈ **${withCache}** · без кэша ≈ **${noCache}** (дешевле в ~${mult}×)`,
  detailsLine: (work, cacheRead, cacheWrite) =>
    `работа (ввод+вывод) ${work} · кэш: чтение ${cacheRead} / запись ${cacheWrite}`,
  contextLine: (used, limit, pct) => `контекст: ${pct}% (${used} / ${limit})`,
  contextNoLimit: (used) => `контекст: ${used} (лимит н/д)`,
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
  localAlwaysAccurate: "_Числа выше — из локального транскрипта, всегда точны._",
  legend: "_Цвет точки: 🟢 в норме · 🟡 близко к лимиту · 🔴 выше нормы. Клик по строке — обновить._",
  switchLang: "🌐 Сменить язык",
  openPanel: "⤢ Открыть панель",
  panelTitle: "Claude Code — расход сессии",
  tok: "ток",
  panelCostLabel: "Стоило (с учётом кэша)",
  panelNoCacheLabel: "Без кэша было бы",
  panelSavedLabel: "💰 Экономия за счёт кэша",
  cheaperMult: (mult) => `(в ~${mult}× дешевле)`,
  panelDetailsHeader: "Детали",
  panelQuotaHeader: "Тариф (реальный, с сервера)",
  panelLocalAccurate: "Числа выше — из локального транскрипта, всегда точны.",
  panelLegend: "🟢 в норме · 🟡 близко к лимиту · 🔴 выше нормы · обновляется в реальном времени",
};

const TABLE: Record<Lang, Messages> = { en: EN, ru: RU };

export function messages(lang: Lang): Messages {
  return TABLE[lang];
}
