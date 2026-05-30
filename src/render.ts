// Pure rendering: turn metrics + quota into the status-bar text, the hover
// tooltip (markdown), and an overall pace level (for item color). No VS Code
// imports → unit-testable.
//
// Collapsed bar = TARIFF ONLY (the at-a-glance signal): per-window colored dot
// + % + time-to-reset. Analytical numbers (work / effective / cache) live in
// the hover tooltip.

import {
  Totals,
  Weights,
  QuotaWindow,
  PaceLevel,
  effectiveTokens,
  fmtTokens,
  fmtRemaining,
  paceLevel,
  worstLevel,
  WINDOW_5H_SECONDS,
  WINDOW_7D_SECONDS,
} from "./metrics";

export interface QuotaView {
  fiveH: QuotaWindow | null;
  sevenD: QuotaWindow | null;
  state: "ok" | "no-credentials" | "error" | "rate-limited" | "disabled";
}

export interface View {
  text: string;
  tooltip: string;
  level: PaceLevel;
}

function bar(pct: number, width = 8): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

function dot(level: PaceLevel): string {
  return level === "over" ? "🔴" : level === "tight" ? "🟡" : "🟢";
}

export function buildView(
  totals: Totals,
  weights: Weights,
  quota: QuotaView,
  nowSec: number,
  apiActiveMs = 0
): View {
  const eff = effectiveTokens(totals, weights);
  const cacheCost = Math.max(0, eff - totals.work); // cache portion inside effective

  // ── collapsed bar: tariff-only, per-window dot + % + reset ──
  const segs: string[] = [];
  let level: PaceLevel = "normal";

  const windowSeg = (label: string, w: QuotaWindow | null, windowSec: number): void => {
    if (!w) return;
    const p = paceLevel(w.pct, w.resetAt, nowSec, windowSec);
    level = worstLevel(level, p.level);
    const reset = w.resetAt ? ` (${fmtRemaining(w.resetAt - nowSec)})` : "";
    segs.push(`${dot(p.level)} ${label} ${w.pct.toFixed(0)}%${reset}`);
  };

  if (quota.state === "ok") {
    windowSeg("5ч", quota.fiveH, WINDOW_5H_SECONDS);
    windowSeg("7д", quota.sevenD, WINDOW_7D_SECONDS);
  }
  // fallback when tariff unavailable: show the analytical effective so the bar
  // is never empty/useless.
  const text = segs.length ? segs.join(" · ") : `$(pulse) эфф ${fmtTokens(eff)}`;

  // ── rich tooltip (analytical) ──
  const t: string[] = [];
  t.push("**Claude Code — расход сессии**");
  t.push("");
  t.push(`- работа (вход+выход): **${fmtTokens(totals.work)}** ток (вход ${fmtTokens(totals.input)} / выход ${fmtTokens(totals.output)})`);
  t.push(`- + на кэш (в эфф.): **~${fmtTokens(cacheCost)}** ток`);
  t.push(`- = эффективно: **${fmtTokens(eff)}** ток`);
  const saved = Math.max(0, 0.9 * totals.cacheRead - 0.25 * totals.cacheWrite);
  t.push(`- кэш: чтение ${fmtTokens(totals.cacheRead)} / запись ${fmtTokens(totals.cacheWrite)} · сэкономлено vs без кэша ≈${fmtTokens(saved)}`);
  if (apiActiveMs >= 1000) {
    const perHr = eff / (apiActiveMs / 3_600_000);
    t.push(`- темп: ~${fmtTokens(perHr)} эфф·ток/ч (по активному времени)`);
  }
  t.push("");

  const quotaLine = (label: string, w: QuotaWindow | null, windowSec: number): string => {
    if (!w) return `- ${label}: —`;
    const p = paceLevel(w.pct, w.resetAt, nowSec, windowSec);
    const reset = w.resetAt ? ` · сброс ${fmtRemaining(w.resetAt - nowSec)}` : "";
    return `- ${dot(p.level)} ${label} ${bar(w.pct)} **${w.pct.toFixed(0)}%** ${p.label}${reset}`;
  };

  if (quota.state === "ok") {
    t.push("**Тариф (реальный, с сервера):**");
    t.push(quotaLine("5ч", quota.fiveH, WINDOW_5H_SECONDS));
    t.push(quotaLine("7д", quota.sevenD, WINDOW_7D_SECONDS));
  } else {
    const msg: Record<string, string> = {
      disabled: "опрос тарифа выключен (`ccStatusbar.quota.enabled`)",
      "no-credentials": "не найден токен `~/.claude/.credentials.json`",
      "rate-limited": "временный лимит запросов — повтор позже",
      error: "тариф временно недоступен (запрос не прошёл)",
    };
    t.push(`_Тариф 5ч/7д: ${msg[quota.state] || "недоступен"}._`);
    t.push("_Метрики выше — из локального транскрипта, всегда точны._");
  }
  t.push("");
  t.push("_Цвет точки/плашки: 🟢 в норме · 🟡 впритык · 🔴 опережение. Клик — обновить._");

  return { text, tooltip: t.join("\n"), level };
}
