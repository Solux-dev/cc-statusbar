// Pure rendering: turn metrics + quota into the status-bar text, the hover
// tooltip (markdown), and an overall pace level (for item color). No VS Code
// imports → unit-testable in both languages.
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
import { Lang, messages } from "./i18n";

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
  lang: Lang = "en",
  apiActiveMs = 0
): View {
  const m = messages(lang);
  const eff = effectiveTokens(totals, weights);
  const cacheCost = Math.max(0, eff - totals.work); // cache portion inside effective

  // ── collapsed bar: tariff-only, per-window dot + % + reset ──
  const segs: string[] = [];
  let level: PaceLevel = "normal";

  const windowSeg = (label: string, w: QuotaWindow | null, windowSec: number): void => {
    if (!w) return;
    const p = paceLevel(w.pct, w.resetAt, nowSec, windowSec);
    level = worstLevel(level, p);
    const reset = w.resetAt ? ` (${fmtRemaining(w.resetAt - nowSec, m.units)})` : "";
    segs.push(`${dot(p)} ${label} ${w.pct.toFixed(0)}%${reset}`);
  };

  if (quota.state === "ok") {
    windowSeg(m.w5h, quota.fiveH, WINDOW_5H_SECONDS);
    windowSeg(m.w7d, quota.sevenD, WINDOW_7D_SECONDS);
  }
  // fallback when tariff unavailable: show the analytical effective so the bar
  // is never empty/useless.
  const text = segs.length ? segs.join(" · ") : `$(pulse) ${m.effShort} ${fmtTokens(eff)}`;

  // ── rich tooltip (analytical) ──
  const t: string[] = [];
  t.push(m.title);
  t.push("");
  t.push(m.workLine(fmtTokens(totals.work), fmtTokens(totals.input), fmtTokens(totals.output)));
  t.push(m.cacheInEff(fmtTokens(cacheCost)));
  t.push(m.effLine(fmtTokens(eff)));
  const saved = Math.max(0, 0.9 * totals.cacheRead - 0.25 * totals.cacheWrite);
  t.push(m.cacheLine(fmtTokens(totals.cacheRead), fmtTokens(totals.cacheWrite), fmtTokens(saved)));
  if (apiActiveMs >= 1000) {
    const perHr = eff / (apiActiveMs / 3_600_000);
    t.push(m.paceLine(fmtTokens(perHr)));
  }
  t.push("");

  const quotaLine = (label: string, w: QuotaWindow | null, windowSec: number): string => {
    if (!w) return `- ${label}: —`;
    const p = paceLevel(w.pct, w.resetAt, nowSec, windowSec);
    const reset = w.resetAt ? m.quotaReset(fmtRemaining(w.resetAt - nowSec, m.units)) : "";
    return `- ${dot(p)} ${label} ${bar(w.pct)} **${w.pct.toFixed(0)}%** ${m.verdict[p]}${reset}`;
  };

  if (quota.state === "ok") {
    t.push(m.tariffHeader);
    t.push(quotaLine(m.w5h, quota.fiveH, WINDOW_5H_SECONDS));
    t.push(quotaLine(m.w7d, quota.sevenD, WINDOW_7D_SECONDS));
  } else {
    t.push(m.quotaUnavail(m.quotaStateMsg[quota.state]));
    t.push(m.localAlwaysAccurate);
  }
  t.push("");
  t.push(m.legend);

  return { text, tooltip: t.join("\n"), level };
}
