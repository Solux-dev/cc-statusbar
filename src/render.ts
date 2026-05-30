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
  lang: Lang = "en"
): View {
  const m = messages(lang);
  const eff = effectiveTokens(totals, weights);
  // raw face-value cost if caching didn't exist: every token at 1× price.
  const noCache = totals.work + totals.cacheRead + totals.cacheWrite;
  const saved = Math.max(0, noCache - eff); // exactly the displayed difference

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
  t.push(m.cacheRaw(fmtTokens(totals.cacheRead), fmtTokens(totals.cacheWrite)));
  t.push(m.noCacheLine(fmtTokens(noCache)));
  t.push(m.withCacheLine(fmtTokens(eff), fmtTokens(saved)));
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
  t.push("");
  t.push(`[${m.openPanel}](command:ccStatusbar.openPanel) · [${m.switchLang}](command:ccStatusbar.switchLanguage)`);

  return { text, tooltip: t.join("\n"), level };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Full HTML document for the persistent webview panel — same numbers as the
 *  tooltip, themed with VS Code variables. Pure: no VS Code imports, no scripts
 *  (the extension re-renders this string on each tick). */
export function buildPanelHtml(
  totals: Totals,
  weights: Weights,
  quota: QuotaView,
  nowSec: number,
  lang: Lang = "en"
): string {
  const m = messages(lang);
  const eff = effectiveTokens(totals, weights);
  const noCache = totals.work + totals.cacheRead + totals.cacheWrite;
  const saved = Math.max(0, noCache - eff);

  const rows: string[] = [];
  rows.push(`<div class="row"><span>${esc(m.panelWork)}</span><b>${fmtTokens(totals.work)} ${esc(m.tok)}</b></div>`);
  rows.push(`<div class="sub">${esc(m.panelInOut(fmtTokens(totals.input), fmtTokens(totals.output)))}</div>`);
  rows.push(`<div class="row"><span>${esc(m.panelCacheLabel)}</span><b>${esc(m.panelCacheValue(fmtTokens(totals.cacheRead), fmtTokens(totals.cacheWrite)))}</b></div>`);
  rows.push(`<div class="row"><span>${esc(m.panelNoCache)}</span><b>≈ ${fmtTokens(noCache)} ${esc(m.tok)}</b></div>`);
  rows.push(`<div class="row big"><span>${esc(m.panelWithCache)}</span><b>≈ ${fmtTokens(eff)} ${esc(m.tok)}</b></div>`);
  rows.push(`<div class="sub">${esc(m.panelSaved(fmtTokens(saved)))}</div>`);

  const quotaBlock: string[] = [];
  const windowRow = (label: string, w: QuotaWindow | null, windowSec: number): void => {
    if (!w) {
      quotaBlock.push(`<div class="qrow"><span class="qlabel">${esc(label)}</span><span>—</span></div>`);
      return;
    }
    const lvl = paceLevel(w.pct, w.resetAt, nowSec, windowSec);
    const color = lvl === "over" ? "var(--cc-red)" : lvl === "tight" ? "var(--cc-yellow)" : "var(--cc-green)";
    const pct = Math.max(0, Math.min(100, w.pct));
    const reset = w.resetAt ? esc(m.quotaReset(fmtRemaining(w.resetAt - nowSec, m.units))) : "";
    quotaBlock.push(
      `<div class="qrow">` +
        `<span class="dot" style="background:${color}"></span>` +
        `<span class="qlabel">${esc(label)}</span>` +
        `<span class="bar"><i style="width:${pct.toFixed(0)}%;background:${color}"></i></span>` +
        `<b>${w.pct.toFixed(0)}%</b>` +
        `<span class="verdict">${esc(m.verdict[lvl])}${reset}</span>` +
        `</div>`
    );
  };

  let quotaSection: string;
  if (quota.state === "ok") {
    windowRow(m.w5h, quota.fiveH, WINDOW_5H_SECONDS);
    windowRow(m.w7d, quota.sevenD, WINDOW_7D_SECONDS);
    quotaSection = `<h3>${esc(m.panelQuotaHeader)}</h3>${quotaBlock.join("")}`;
  } else {
    quotaSection =
      `<p class="muted">${esc(m.quotaStateMsg[quota.state])}</p>` +
      `<p class="muted">${esc(m.panelLocalAccurate)}</p>`;
  }

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  :root { --cc-green:#3fb950; --cc-yellow:#d6a31a; --cc-red:#e5534b; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 14px 18px; font-size: 13px; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  h3 { font-size: 13px; margin: 18px 0 8px; opacity: .85; }
  .row { display:flex; justify-content:space-between; align-items:baseline; padding:3px 0; }
  .row.big b { font-size: 15px; }
  .row span { opacity:.9; } .row b { font-variant-numeric: tabular-nums; }
  .sub { opacity:.6; font-size:12px; padding:1px 0 6px; }
  .qrow { display:flex; align-items:center; gap:8px; padding:5px 0; }
  .dot { width:10px; height:10px; border-radius:50%; flex:0 0 auto; }
  .qlabel { width:28px; opacity:.85; }
  .bar { flex:1; height:8px; border-radius:4px; background:var(--vscode-input-background,rgba(255,255,255,.08)); overflow:hidden; }
  .bar i { display:block; height:100%; }
  .qrow b { width:42px; text-align:right; font-variant-numeric: tabular-nums; }
  .verdict { opacity:.7; font-size:12px; }
  .muted { opacity:.65; font-size:12px; }
  .legend { margin-top:18px; opacity:.6; font-size:12px; }
</style>
</head>
<body>
  <h2>${esc(m.panelTitle)}</h2>
  ${rows.join("\n  ")}
  ${quotaSection}
  <div class="legend">${esc(m.panelLegend)}</div>
</body>
</html>`;
}
