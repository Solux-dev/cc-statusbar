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
  /** Unix seconds the shown reading was obtained (network fetch or local
   *  statusline bridge write). Drives the "updated N ago" freshness note. */
  asOfSec?: number;
  /** Which source the shown reading came from (for the panel/diagnostics). */
  source?: "network" | "local";
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
  // why the limit is unavailable (e.g. "http 403", a network error) — shown next
  // to "(limit n/a)" for diagnosability.
  limitDetail?: string;
}

/** Cache insight: which TTL tier the main session is on (auto-detected) and the
 *  descriptive share of input served from cache. Both nullable — null → hidden. */
export interface CacheView {
  tier: "1h" | "5m" | null;
  hitRatePct: number | null;
}

export interface View {
  text: string;
  tooltip: string;
  level: PaceLevel;
}

export interface CodexQuotaDetails {
  source: "proxy" | "stdio" | null;
  planType?: string | null;
  userAgent?: string | null;
  thread?: {
    id: string;
    name: string | null;
    preview: string | null;
    cwd: string | null;
    updatedAtSec: number | null;
    status: string | null;
    source: string | null;
    modelProvider: string | null;
    cliVersion: string | null;
    loaded: boolean;
  } | null;
  context?: ContextView;
  contextState?: "waiting" | "unavailable";
  cache?: CacheView;
  cacheState?: "waiting" | "unavailable";
  weights?: Weights;
  usage?: {
    totalTokens: number;
    lastTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  } | null;
  diagnostics?: string[];
}

/** Context % when both numbers are known, else null (fail-visibly). */
function contextPct(ctx?: ContextView): number | null {
  if (!ctx || ctx.usedTokens == null || ctx.limitTokens == null || ctx.limitTokens <= 0) return null;
  return Math.round((ctx.usedTokens / ctx.limitTokens) * 100);
}

/** Collapsed-bar context segment: `🟢 ctx 47%`. The dot is INFORMATIONAL only
 *  (🟢 <50% · 🟡 50–80% · 🔴 ≥80%) and never tints the whole bar — context is a
 *  "room for the next step" read, not a quota with consequences. Null → omit
 *  (no limit, or no context yet). */
function contextSegment(ctx: ContextView | undefined, m: Messages): string | null {
  const pct = contextPct(ctx);
  if (pct == null) return null;
  return `${dot(contextLevel(pct))} ${m.ctxShort} ${pct}%`;
}

/** Context line for tooltip/panel: full `context: X% (used / limit)`, or
 *  `context: used (limit n/a)` when the limit is unavailable, or null. */
function contextLine(ctx: ContextView | undefined, m: Messages): string | null {
  if (!ctx || ctx.usedTokens == null) return null;
  const pct = contextPct(ctx);
  if (pct != null) return m.contextLine(fmtTokens(ctx.usedTokens), fmtTokens(ctx.limitTokens!), pct);
  if (ctx.limitState === "unavailable") return m.contextNoLimit(fmtTokens(ctx.usedTokens), ctx.limitDetail);
  return null; // pending → show nothing yet
}

function codexContextLine(details: CodexQuotaDetails, m: Messages): string | null {
  const cl = contextLine(details.context, m);
  if (cl) return cl;
  if (details.contextState === "waiting") return m.codexContextWaitingLine;
  return null;
}

function codexCacheLine(details: CodexQuotaDetails, m: Messages): string | null {
  if (details.cache?.hitRatePct != null) return m.codexCacheHitLine(`${details.cache.hitRatePct.toFixed(0)}%`);
  if (details.cacheState === "waiting") return m.codexCacheWaitingLine;
  return null;
}

function codexEconomy(details: CodexQuotaDetails): { effective: number; noCache: number; saved: number; mult: string; work: number } | null {
  if (!details.usage) return null;
  const cacheReadWeight = details.weights?.cacheRead ?? 0.1;
  const cachedInput = Math.max(0, details.usage.cachedInputTokens);
  const freshInput = Math.max(0, details.usage.inputTokens - cachedInput);
  // Codex total_tokens = input_tokens + output_tokens; reasoning is a detail of output.
  const output = Math.max(0, details.usage.outputTokens);
  const work = freshInput + output;
  const effective = work + cachedInput * cacheReadWeight;
  const noCache = details.usage.inputTokens + output;
  const saved = Math.max(0, noCache - effective);
  return {
    effective,
    noCache,
    saved,
    mult: effective > 0 ? fmtMult(noCache / effective) : "1",
    work,
  };
}

function codexUsageCompact(details: CodexQuotaDetails, m: Messages): string {
  const economy = codexEconomy(details);
  if (!economy) return m.codexUsageWaitingCompact;
  return m.codexCostCompact(fmtTokens(economy.effective), fmtTokens(economy.noCache), economy.mult);
}

function codexDetailsLine(details: CodexQuotaDetails, m: Messages): string {
  if (!details.usage) return m.codexDetailsWaitingLine;
  const economy = codexEconomy(details);
  return m.codexDetailsLine(fmtTokens(economy?.work ?? 0), fmtTokens(details.usage.cachedInputTokens));
}

function bar(pct: number, width = 8): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

function dot(level: PaceLevel): string {
  return level === "over" ? "🔴" : level === "tight" ? "🟡" : "🟢";
}

/** A reading older than this is no longer "live": the bar stops painting the
 *  colored % and shows the neutral offline marker instead (the % moves to the
 *  tooltip). Comfortably above the normal 5-min poll cadence so healthy polling
 *  never trips it, but short enough that a stuck poll flips to honest-offline. */
const QUOTA_FRESH_SECONDS = 6 * 60;

export function buildView(
  totals: Totals,
  weights: Weights,
  quota: QuotaView,
  nowSec: number,
  lang: Lang = "en",
  context?: ContextView,
  cache?: CacheView
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

  // The colored % is the whole point of the bar — a glance must read "within
  // limits / tight / over". So we ONLY paint it when the reading is actually
  // LIVE. A stale reading (poll stuck on a flaky link) is NOT painted: coloring
  // old numbers tells a confident lie. Stale → fall through to the neutral
  // offline marker below; the exact last-known values stay in the tooltip.
  const fresh = quota.asOfSec == null || nowSec - quota.asOfSec < QUOTA_FRESH_SECONDS;
  if (quota.state === "ok" && fresh) {
    windowSeg(m.w5h, quota.fiveH, WINDOW_5H_SECONDS);
    windowSeg(m.w7d, quota.sevenD, WINDOW_7D_SECONDS);
  }

  // Context is a FIXED-fill signal — it colours its OWN segment but does NOT
  // drive the item background (that stays tariff-pace, two different models).
  const ctxSeg = contextSegment(context, m);
  // fallback when no LIVE tariff in the bar: show effective so the bar is never
  // empty, prefixed by a neutral marker saying WHY there's no live %. A stale
  // ok-reading is treated as "offline" here (no live refresh) — same neutral,
  // un-colored signal as a network error. "disabled" is an intentional user
  // choice → stay silent.
  const effFallback = `$(pulse) ${m.effShort} ${fmtTokens(eff)}`;
  let offlineMarker: string | null = null;
  if (quota.state !== "ok" && quota.state !== "disabled") {
    offlineMarker = m.quotaOfflineShort[quota.state];
  } else if (quota.state === "ok" && !fresh) {
    offlineMarker = m.quotaOfflineShort.error; // had data once, but it's not live now
  }
  const tariffText = segs.length
    ? segs.join(" · ")
    : offlineMarker
    ? `${offlineMarker} · ${effFallback}`
    : effFallback;
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
    // Honest freshness: if the shown reading isn't brand-new (a poll that hasn't
    // refreshed yet, or a local-bridge value while the link is down), say how
    // old it is — the % stays visible, never silently dropped.
    if (quota.asOfSec) {
      const ageSec = nowSec - quota.asOfSec;
      if (ageSec >= 60) t.push(m.quotaAsOf(fmtRemaining(ageSec, m.units)));
    }
  } else {
    t.push(m.quotaUnavail(m.quotaStateMsg[quota.state]));
    t.push(m.localAlwaysAccurate);
  }
  const cl = contextLine(context, m);
  if (cl) t.push(`- ${cl}`);
  // cache tier — concise, self-explanatory (full footnotes live in the panel)
  if (cache?.tier) t.push(`- ${m.cacheTierLine(cache.tier)}`);
  t.push("");
  // muted technical breakdown
  t.push(`_${m.detailsLine(fmtTokens(totals.work), fmtTokens(totals.cacheRead), fmtTokens(totals.cacheWrite))}_`);
  t.push("");
  t.push(m.legend);
  t.push("");
  t.push(`[${m.openPanel}](command:ccStatusbar.openPanel) · [${m.switchLang}](command:ccStatusbar.switchLanguage)`);

  return { text, tooltip: t.join("\n"), level };
}

export function buildCodexQuotaView(
  quota: QuotaView,
  nowSec: number,
  lang: Lang = "en",
  details: CodexQuotaDetails = { source: null }
): View {
  const m = messages(lang);
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

  const ctxSeg = contextSegment(details.context, m) || (details.contextState === "waiting" ? m.codexContextShortUnavailable : null);
  const text = segs.length
    ? `Codex · ${segs.join(" · ")}${ctxSeg ? ` · ${ctxSeg}` : ""}`
    : m.providerUnavailableText("Codex");
  const t: string[] = [m.codexTitle, ""];
  t.push(codexUsageCompact(details, m));
  t.push("");

  const quotaLine = (label: string, w: QuotaWindow | null, windowSec: number): string => {
    if (!w) return `- ${label}: —`;
    const p = paceLevel(w.pct, w.resetAt, nowSec, windowSec);
    const reset = w.resetAt ? m.quotaReset(fmtRemaining(w.resetAt - nowSec, m.units)) : "";
    return `- ${dot(p)} ${label} ${bar(w.pct)} **${w.pct.toFixed(0)}%** ${m.verdict[p]}${reset}`;
  };

  if (quota.state === "ok") {
    t.push(m.codexQuotaHeader);
    t.push(quotaLine(m.w5h, quota.fiveH, WINDOW_5H_SECONDS));
    t.push(quotaLine(m.w7d, quota.sevenD, WINDOW_7D_SECONDS));
  } else {
    t.push(m.quotaUnavail(m.quotaStateMsg[quota.state]));
  }

  const codexCtx = codexContextLine(details, m);
  if (codexCtx) t.push(`- ${codexCtx}`);
  const codexCache = codexCacheLine(details, m);
  if (codexCache) t.push(`- ${codexCache}`);

  t.push("");
  t.push(`_${codexDetailsLine(details, m)}_`);
  t.push("");
  t.push(m.legend);
  t.push("");
  t.push(`[${m.openPanel}](command:ccStatusbar.openPanel)`);
  return { text, tooltip: t.join("\n"), level: segs.length ? level : "tight" };
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
  context?: ContextView,
  cache?: CacheView
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
  rows.push(`<div class="row save"><span>${esc(m.panelSavedLabel)}</span><b>≈ ${fmtTokens(saved)} ${esc(m.tok)} <span class="mult">${esc(m.lowerMult(mult))}</span></b></div>`);
  rows.push(`<div class="sub">${esc(m.panelTokenCostNote)}</div>`);

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

  // Same freshness rule as the status bar: only paint the colored % when the
  // reading is LIVE. A stale "ok" reading is shown as offline (with the exact
  // last-known values kept as muted text), so the panel never presents an
  // out-of-date number as current.
  const fresh = quota.asOfSec == null || nowSec - quota.asOfSec < QUOTA_FRESH_SECONDS;
  let quotaSection: string;
  if (quota.state === "ok" && fresh) {
    windowRow(m.w5h, quota.fiveH, WINDOW_5H_SECONDS);
    windowRow(m.w7d, quota.sevenD, WINDOW_7D_SECONDS);
    quotaSection = `<h3>${esc(m.panelQuotaHeader)}</h3>${quotaBlock.join("")}${ctxRow}`;
  } else {
    const reason = quota.state === "ok" ? m.quotaStateMsg.error : m.quotaStateMsg[quota.state];
    let lastKnown = "";
    if (quota.state === "ok" && (quota.fiveH || quota.sevenD)) {
      const parts: string[] = [];
      if (quota.fiveH) parts.push(`${m.w5h} ${quota.fiveH.pct.toFixed(0)}%`);
      if (quota.sevenD) parts.push(`${m.w7d} ${quota.sevenD.pct.toFixed(0)}%`);
      const ago = quota.asOfSec ? fmtRemaining(nowSec - quota.asOfSec, m.units) : "?";
      lastKnown = `<p class="muted">${esc(m.quotaLastKnown(parts.join(", "), ago))}</p>`;
    }
    quotaSection =
      `<p class="muted">${esc(reason)}</p>` +
      lastKnown +
      `<p class="muted">${esc(m.panelLocalAccurate)}</p>` +
      ctxRow;
  }

  // cache insight: auto-detected tier + descriptive hit rate, each with a
  // hover footnote (title=) so any user can learn what the line means.
  let cacheSection = "";
  if (cache && (cache.tier || cache.hitRatePct != null)) {
    const crows: string[] = [];
    const hintSpan = (label: string, hint: string): string =>
      `<span class="hint" tabindex="0">${esc(label)} ⓘ<span class="tip">${esc(hint)}</span></span>`;
    if (cache.tier) {
      crows.push(
        `<div class="row">${hintSpan(m.panelCacheTierLabel, m.panelCacheTierHint)}` +
          `<b>${esc(m.panelCacheTierValue[cache.tier])}</b></div>`
      );
    }
    if (cache.hitRatePct != null) {
      crows.push(
        `<div class="row">${hintSpan(m.panelCacheHitLabel, m.panelCacheHitHint)}` +
          `<b>${cache.hitRatePct.toFixed(0)}%</b></div>`
      );
    }
    cacheSection = `<h3>${esc(m.panelCacheHeader)}</h3>${crows.join("")}`;
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
  .hint { position:relative; opacity:.9; border-bottom:1px dotted currentColor; cursor:help; outline:none; }
  .hint .tip {
    visibility:hidden; opacity:0; position:absolute; left:0; bottom:140%; z-index:10;
    width:max-content; max-width:300px; padding:8px 10px; border-radius:6px;
    font-size:12px; font-weight:normal; line-height:1.45; white-space:normal; text-align:left;
    background:var(--vscode-editorHoverWidget-background, var(--vscode-menu-background, #252526));
    color:var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
    border:1px solid var(--vscode-editorHoverWidget-border, rgba(128,128,128,.35));
    box-shadow:0 2px 8px rgba(0,0,0,.35); transition:opacity .1s ease; pointer-events:none;
  }
  .hint:hover .tip, .hint:focus .tip { visibility:visible; opacity:1; }
  .legend { margin-top:18px; opacity:.6; font-size:12px; }
</style>
</head>
<body>
  <h2>${esc(m.panelTitle)}</h2>
  ${rows.join("\n  ")}
  ${quotaSection}
  ${cacheSection}
  ${detailsSection}
  <div class="legend">${esc(m.panelLegend)}</div>
</body>
</html>`;
}

export function buildCodexPanelHtml(
  quota: QuotaView,
  nowSec: number,
  lang: Lang = "en",
  details: CodexQuotaDetails = { source: null }
): string {
  const m = messages(lang);
  const economy = codexEconomy(details);

  const usageRows: string[] = [];
  if (economy) {
    usageRows.push(
      `<div class="row big"><span>${esc(m.codexPanelCostLabel)}</span><b>≈ ${fmtTokens(economy.effective)} ${esc(m.tok)}</b></div>`
    );
    usageRows.push(
      `<div class="row"><span>${esc(m.codexPanelNoCacheLabel)}</span><b>≈ ${fmtTokens(economy.noCache)} ${esc(m.tok)}</b></div>`
    );
    usageRows.push(
      `<div class="row save"><span>${esc(m.codexPanelSavedLabel)}</span><b>≈ ${fmtTokens(economy.saved)} ${esc(m.tok)} <span class="mult">${esc(m.codexLowerMult(economy.mult))}</span></b></div>`
    );
  } else {
    usageRows.push(`<div class="row big"><span>${esc(m.codexPanelCostLabel)}</span><b>—</b></div>`);
    usageRows.push(`<div class="row"><span>${esc(m.codexPanelNoCacheLabel)}</span><b>—</b></div>`);
    usageRows.push(`<div class="row save"><span>${esc(m.codexPanelSavedLabel)}</span><b>—</b></div>`);
    usageRows.push(`<div class="empty">${esc(m.codexPanelUsageWaiting)}</div>`);
  }
  usageRows.push(`<div class="sub">${esc(m.codexPanelTokenCostNote)}</div>`);

  const quotaRows: string[] = [];
  const windowRow = (label: string, w: QuotaWindow | null, windowSec: number): void => {
    if (!w) {
      quotaRows.push(`<div class="qrow"><span class="qlabel">${esc(label)}</span><span class="muted">—</span></div>`);
      return;
    }
    const lvl = paceLevel(w.pct, w.resetAt, nowSec, windowSec);
    const color = lvl === "over" ? "var(--cc-red)" : lvl === "tight" ? "var(--cc-yellow)" : "var(--cc-green)";
    const pct = Math.max(0, Math.min(100, w.pct));
    const reset = w.resetAt ? esc(m.quotaReset(fmtRemaining(w.resetAt - nowSec, m.units))) : "";
    quotaRows.push(
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
    quotaSection = `<h3>${esc(m.codexPanelQuotaHeader)}</h3>${quotaRows.join("")}`;
  } else {
    quotaSection = `<h3>${esc(m.codexPanelQuotaHeader)}</h3><div class="empty">${esc(m.quotaStateMsg[quota.state])}</div>`;
  }

  const ctxLine = codexContextLine(details, m);
  const contextSection = `<div class="ctxrow">${esc(ctxLine || m.codexContextWaitingPanel)}</div>`;

  const cacheLine = codexCacheLine(details, m);
  const cacheRows: string[] = [];
  cacheRows.push(`<div class="row"><span>${esc(m.panelCacheTierLabel)}</span><b>${esc(m.codexCacheTierUnavailable)}</b></div>`);
  if (details.cache?.hitRatePct != null) {
    cacheRows.push(`<div class="row"><span>${esc(m.panelCacheHitLabel)}</span><b>${details.cache.hitRatePct.toFixed(0)}%</b></div>`);
  } else {
    cacheRows.push(`<div class="row"><span>${esc(m.panelCacheHitLabel)}</span><b class="soft">—</b></div>`);
    cacheRows.push(`<div class="sub">${esc(details.cacheState === "waiting" ? m.codexCacheWaitingPanel : cacheLine || m.codexCacheWaitingPanel)}</div>`);
  }
  const cacheSection = `<h3>${esc(m.codexPanelCacheHeader)}</h3>${cacheRows.join("")}`;

  const detailsSection =
    `<h3>${esc(m.panelDetailsHeader)}</h3>` +
    `<div class="sub">${esc(codexDetailsLine(details, m))}</div>`;

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
  h3 { font-size: 13px; margin: 18px 0 8px; opacity: .88; }
  .row { display:flex; justify-content:space-between; align-items:baseline; gap:14px; padding:3px 0; }
  .row span { opacity:.9; min-width:0; overflow-wrap:anywhere; }
  .row b { font-variant-numeric: tabular-nums; white-space:nowrap; }
  .row.big b { font-size: 16px; }
  .row.save b { color: var(--cc-green); }
  .row.save .mult { opacity:.8; font-weight:normal; font-size:12px; }
  .row .soft, .soft { opacity:.7; font-weight:600; }
  .sub { opacity:.6; font-size:12px; line-height:1.45; padding:2px 0 6px; }
  .ctxrow { padding:6px 0 2px; opacity:.85; font-variant-numeric: tabular-nums; }
  .empty { opacity:.7; font-size:12px; line-height:1.5; padding:6px 0 2px; max-width:720px; }
  .qrow { display:flex; align-items:center; gap:8px; padding:5px 0; }
  .qrow.ctx { padding-bottom:2px; }
  .dot { width:10px; height:10px; border-radius:50%; flex:0 0 auto; }
  .qlabel { width:28px; opacity:.85; }
  .bar { flex:1; height:8px; border-radius:4px; background:var(--vscode-input-background,rgba(255,255,255,.08)); overflow:hidden; min-width:120px; }
  .bar i { display:block; height:100%; }
  .qrow b { width:42px; text-align:right; font-variant-numeric: tabular-nums; }
  .verdict { opacity:.7; font-size:12px; }
  .muted { opacity:.55; }
</style>
</head>
<body>
  <h2>${esc(m.codexPanelTitle)}</h2>
  ${usageRows.join("\n  ")}
  ${quotaSection}
  ${contextSection}
  ${cacheSection}
  ${detailsSection}
</body>
</html>`;
}
