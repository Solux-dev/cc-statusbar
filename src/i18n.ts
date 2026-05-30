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
  // tooltip
  title: string;
  workLine: (work: string, input: string, output: string) => string;
  cacheInEff: (cache: string) => string;
  effLine: (eff: string) => string;
  cacheLine: (read: string, write: string, saved: string) => string;
  paceLine: (perHour: string) => string;
  tariffHeader: string;
  quotaReset: (remaining: string) => string;
  verdict: Record<PaceLevel, string>;
  quotaUnavail: (msg: string) => string;
  quotaStateMsg: Record<Exclude<QuotaState, "ok">, string>;
  localAlwaysAccurate: string;
  legend: string;
}

const EN: Messages = {
  units: { d: "d", h: "h", m: "m" },
  noFolder: "$(pulse) cc: no folder",
  noFolderTip: "Open a project folder to track its Claude Code session.",
  effShort: "eff",
  w5h: "5h",
  w7d: "7d",
  title: "**Claude Code — session usage**",
  workLine: (work, input, output) =>
    `- work (in + out): **${work}** tok (in ${input} / out ${output})`,
  cacheInEff: (cache) => `- + cache (counted in eff.): **~${cache}** tok`,
  effLine: (eff) => `- = effective: **${eff}** tok`,
  cacheLine: (read, write, saved) =>
    `- cache: read ${read} / write ${write} · saved vs no-cache ≈${saved}`,
  paceLine: (perHour) => `- pace: ~${perHour} eff·tok/h (by active time)`,
  tariffHeader: "**Subscription quota (real, from server):**",
  quotaReset: (remaining) => ` · resets in ${remaining}`,
  verdict: {
    normal: "on track",
    tight: "cutting it close",
    over: "spending faster than the limit",
  },
  quotaUnavail: (msg) => `_Quota 5h/7d: ${msg}._`,
  quotaStateMsg: {
    disabled: "polling is off (`ccStatusbar.quota.enabled`)",
    "no-credentials": "no token found at `~/.claude/.credentials.json`",
    "rate-limited": "temporary request limit — will retry later",
    error: "temporarily unavailable (request failed)",
  },
  localAlwaysAccurate: "_The numbers above come from the local transcript — always accurate._",
  legend: "_Dot color: 🟢 on track · 🟡 tight · 🔴 over pace. Click to refresh._",
};

const RU: Messages = {
  units: { d: "д", h: "ч", m: "м" },
  noFolder: "$(pulse) cc: нет папки",
  noFolderTip: "Откройте папку проекта, чтобы отслеживать его сессию Claude Code.",
  effShort: "эфф",
  w5h: "5ч",
  w7d: "7д",
  title: "**Claude Code — расход сессии**",
  workLine: (work, input, output) =>
    `- работа (вход + выход): **${work}** ток (вход ${input} / выход ${output})`,
  cacheInEff: (cache) => `- + на кэш (учтено в эфф.): **~${cache}** ток`,
  effLine: (eff) => `- = эффективно: **${eff}** ток`,
  cacheLine: (read, write, saved) =>
    `- кэш: чтение ${read} / запись ${write} · сэкономлено vs без кэша ≈${saved}`,
  paceLine: (perHour) => `- темп: ~${perHour} эфф·ток/ч (по активному времени)`,
  tariffHeader: "**Тариф (реальный, с сервера):**",
  quotaReset: (remaining) => ` · сброс через ${remaining}`,
  verdict: {
    normal: "идём в график",
    tight: "впритык к лимиту",
    over: "тратим быстрее лимита",
  },
  quotaUnavail: (msg) => `_Тариф 5ч/7д: ${msg}._`,
  quotaStateMsg: {
    disabled: "опрос выключен (`ccStatusbar.quota.enabled`)",
    "no-credentials": "не найден токен `~/.claude/.credentials.json`",
    "rate-limited": "временный лимит запросов — повтор позже",
    error: "временно недоступен (запрос не прошёл)",
  },
  localAlwaysAccurate: "_Числа выше — из локального транскрипта, всегда точны._",
  legend: "_Цвет точки: 🟢 в норме · 🟡 впритык · 🔴 опережение. Клик — обновить._",
};

const TABLE: Record<Lang, Messages> = { en: EN, ru: RU };

export function messages(lang: Lang): Messages {
  return TABLE[lang];
}
