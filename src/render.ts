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
  fmtMult,
  fmtRemaining,
  paceLevel,
  contextLevel,
  worstLevel,
  WINDOW_5H_SECONDS,
  WINDOW_7D_SECONDS,
} from "./metrics";
import { Lang, Messages, messages } from "./i18n";

export interface QuotaView {
  fiveH: QuotaWindow | null;
  sevenD: QuotaWindow | null;
  state: "ok" | "no-credentials" | "error" | "rate-limited" | "disabled";
}

/** Context-window fill for the active (Lead) session. `usedTokens` = the real
 *  input the model received last turn (MAIN transcript only); `limitTokens` =
 *  the model's max_input_tokens from the Models API. Either may be null →
 *  fail-visibly: with no limit the % is omitted, never guessed. */
export interface ContextView {
  usedTokens: number | null;
  limitTokens: number | null;
  // "pending" = limit not fetched yet (suppress the line to avoid a flicker of
  // "(limit n/a)"); "unavailable" = a definitive failure → show used + "(n/a)".
  limitState?: "ok" | "pending" | "unavailable";
}

export interface View {
  text: string;
  tooltip: string;
  level: PaceLevel;
}

/** Context % when both numbers are known, else null (fail-visibly). */
function contextPct(ctx?: ContextView): number | null {
  if (!ctx || ctx.usedTokens == null || ctx.limitTokens == null || ctx.limitTokens <= 0) return null;
  return Math.round((ctx.usedTokens / ctx.limitTokens) * 100);
}

/** Collapsed-bar context segment: `ctx 47%`, dot-prefixed only when ≥85% so the
 *  bar stays clean at normal fill. Null → omit (no limit, or no context yet). */
function contextSegment(ctx: ContextView | undefined, m: Messages): string | null {
  const pct = contextPct(ctx);
  if (pct == null) return null;
  const lvl = contextLevel(pct);
  const prefix = lvl === "normal" ? "" : `${dot(lvl)} `;
  return `${prefix}${m.ctxShort} ${pct}%`;
}

/** Context line for tooltip/panel: full `context: X% (used / limit)`, or
 *  `context: used (limit n/a)` when the limit is unavailable, or null. */
function contextLine(ctx: ContextView | undefined, m: Messages): string | null {
  if (!ctx || ctx.usedTokens == null) return null;
  const pct = contextPct(ctx);
  if (pct != null) return m.contextLine(fmtTokens(ctx.usedTokens), fmtTokens(ctx.limitTokens!), pct);
  if (ctx.limitState === "unavailable") return m.contextNoLimit(fmtTokens(ctx.usedTokens));
  return null; // pending → show nothing yet
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
  context?: ContextView
): View {
  const m = messages(lang);
  const eff = effectiveTokens(totals, weights);
  // raw face-value cost if caching didn't exist: every token at 1× price.
  const noCache = totals.work + totals.cacheRead + totals.cacheWrite;
  const mult = eff > 0 ? fmtMult(noCache / eff) : "1";

  // ── collapsed bar: tariff dots + (optional) context segment ──
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

  // Context is a FIXED-fill signal — it colours its OWN segment but does NOT
  // drive the item background (that stays tariff-pace, two different models).
  const ctxSeg = contextSegment(context, m);
  // fallback when tariff unavailable: show effective so the bar is never empty.
  const tariffText = segs.length ? segs.join(" · ") : `$(pulse) ${m.effShort} ${fmtTokens(eff)}`;
  const text = ctxSeg ? `${tariffText} · ${ctxSeg}` : tariffText;

  // ── rich tooltip: cost-first headline, then tariff + context, then details ──
  const t: string[] = [];
  t.push(m.title);
  t.push("");
  t.push(m.costCompact(fmtTokens(eff), fmtTokens(noCache), mult));
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
  const cl = contextLine(context, m);
  if (cl) t.push(`- ${cl}`);
  t.push("");
  // muted technical breakdown
  t.push(`_${m.detailsLine(fmtTokens(totals.work), fmtTokens(totals.cacheRead), fmtTokens(totals.cacheWrite))}_`);
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
  lang: Lang = "en",
  context?: ContextView
): string {
  const m = messages(lang);
  const eff = effectiveTokens(totals, weights);
  const noCache = totals.work + totals.cacheRead + totals.cacheWrite;
  const saved = Math.max(0, noCache - eff);
  const mult = eff > 0 ? fmtMult(noCache / eff) : "1";

  // headline: cost comparison + savings multiplier (lead with the answer)
  const rows: string[] = [];
  rows.push(`<div class="row big"><span>${esc(m.panelCostLabel)}</span><b>≈ ${fmtTokens(eff)} ${esc(m.tok)}</b></div>`);
  rows.push(`<div class="row"><span>${esc(m.panelNoCacheLabel)}</span><b>≈ ${fmtTokens(noCache)} ${esc(m.tok)}</b></div>`);
  rows.push(`<div class="row save"><span>${esc(m.panelSavedLabel)}</span><b>≈ ${fmtTokens(saved)} ${esc(m.tok)} <span class="mult">${esc(m.cheaperMult(mult))}</span></b></div>`);

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

  // context-window fill — its own line right under the tariff (see spec).
  const cl = contextLine(context, m);
  const ctxRow = cl ? `<div class="ctxrow">${esc(cl)}</div>` : "";

  let quotaSection: string;
  if (quota.state === "ok") {
    windowRow(m.w5h, quota.fiveH, WINDOW_5H_SECONDS);
    windowRow(m.w7d, quota.sevenD, WINDOW_7D_SECONDS);
    quotaSection = `<h3>${esc(m.panelQuotaHeader)}</h3>${quotaBlock.join("")}${ctxRow}`;
  } else {
    quotaSection =
      `<p class="muted">${esc(m.quotaStateMsg[quota.state])}</p>` +
      `<p class="muted">${esc(m.panelLocalAccurate)}</p>` +
      ctxRow;
  }

  // muted technical breakdown
  const detailsSection =
    `<h3>${esc(m.panelDetailsHeader)}</h3>` +
    `<div class="sub">${esc(m.detailsLine(fmtTokens(totals.work), fmtTokens(totals.cacheRead), fmtTokens(totals.cacheWrite)))}</div>`;

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
  .row.big b { font-size: 16px; }
  .row.save b { color: var(--cc-green); }
  .row.save .mult { opacity:.8; font-weight:normal; font-size:12px; }
  .row span { opacity:.9; } .row b { font-variant-numeric: tabular-nums; }
  .sub { opacity:.6; font-size:12px; padding:1px 0 6px; }
  .ctxrow { padding:6px 0 2px; opacity:.85; font-variant-numeric: tabular-nums; }
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
  ${detailsSection}
  <div class="legend">${esc(m.panelLegend)}</div>
</body>
</html>`;
}
