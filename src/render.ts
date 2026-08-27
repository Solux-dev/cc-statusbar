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
  ScopedQuotaWindow,
  PaceLevel,
  IdleRebuild,
  CACHE_WRITE_WEIGHT_1H,
  CACHE_WRITE_WEIGHT_5M,
  effectiveTokens,
  costDirection,
  writeBound,
  boundMark,
  fmtTokens,
  fmtRemaining,
  paceLevel,
  contextLevel,
  worstLevel,
  WINDOW_5H_SECONDS,
  WINDOW_7D_SECONDS,
} from "./metrics";
// Every decision this file makes about NUMBERS lives next door; what is left
// here is the wording and the markup. An import that grows back into arithmetic
// is the drift this split undid.
import {
  CacheView,
  CodexEconomy,
  CodexQuotaDetails,
  ContextView,
  ModelView,
  QuotaView,
  RebuildView,
  SubagentView,
  ZERO_TOLERANCE,
  agentIdle,
  cacheCanReverse,
  codexCacheWrite,
  codexCanReverse,
  codexCostCause,
  codexEconomy,
  contextPct,
  costCause,
  rebuildDisplay,
  subagentGroups,
} from "./panelModel";
import { Lang, Messages, messages } from "./i18n";

/** The footnote under the token-equivalent, in words. Which cause it is, and
 *  whether the hedge may be spoken, are `costCause`'s answers; this maps them
 *  to sentences. `invisible` = the difference is invisible everywhere the page
 *  states it — see the parameter's own note next door. */
export function costCauseHint(
  totals: Totals,
  weights: Weights,
  m: Messages,
  invisible = false
): string {
  const { kind, canReverse } = costCause(totals, weights, invisible);
  switch (kind) {
    case "noCache":
      return m.panelCostNoCacheHint;
    case "even":
      return m.panelCostEvenHint;
    case "tooSmall":
      return m.panelCostTooSmallHint(canReverse);
    case "both":
      return m.panelCostBothHint;
    case "warmup":
      return m.panelCostWarmupHint(canReverse);
    case "weight":
      return m.panelCostWeightHint;
  }
}

/** The same footnote on the Codex page. Four of the six causes are the Claude
 *  sentence word for word; two have Codex twins, because they name Claude's
 *  cache tiers and Codex states none — and one state is Codex's alone. The
 *  CHOICE is `codexCostCause`'s and is made once for both panels; what differs
 *  here is only which words it comes out as. */
function codexCostCauseText(economy: CodexEconomy, details: CodexQuotaDetails, m: Messages): string {
  const { kind, canReverse } = codexCostCause(economy, details);
  switch (kind) {
    case "noCacheRead":
      return m.codexPanelNoCacheReadHint;
    case "even":
      return m.panelCostEvenHint;
    case "tooSmall":
      return m.panelCostTooSmallHint(canReverse);
    case "both":
      return m.codexPanelBothHint;
    case "warmup":
      return m.codexPanelWarmupHint(canReverse);
    case "weight":
      return m.panelCostWeightHint;
  }
}

/** The one command a panel link may run: it flips the agent list open/closed.
 *  Exported so the registration, the package.json contribution and the link
 *  cannot drift apart (a test pins all three). */
export const DELEGATED_TOGGLE_COMMAND = "ccStatusbar.toggleDelegated";

// The CURRENT choice used to be plain bold text — the same colour as every other
// word in the hover, while the alternatives were blue links, so it could not be
// told apart from ordinary prose at a glance. It is now marked with a check and
// bold, giving the row three states that cannot be confused: blue = clickable ·
// ✓ bold = current · 🟢 = this source has data right now (a different question
// from "selected").
//
// Colour and underline were TRIED and do not work here. Even with `supportHtml`
// and an inline `<span style=…>` — whose tag and attribute are both in the
// markdown sanitiser's default allowlists — the status-bar tooltip strips the
// styling and renders only the text. That surface is not the editor's regular
// markdown hover. Verified on a real screenshot, not assumed; the markup is gone
// rather than left in as dead weight that some other editor might print raw.
const SELECTED_MARK = "✓";

/** Render one row of choices: the active one marked, the rest as links. */
export function choicesMarkdown<T extends string>(
  header: string,
  selected: T,
  choices: Array<{ value: T; label: string; command: string }>
): string {
  const rendered = choices.map(({ value, label, command }) =>
    selected === value ? `${SELECTED_MARK} **${label}**` : `[${label}](command:${command})`
  );
  return `**${header}:** ${rendered.join(" · ")}`;
}

/** Bar marker for a CONFIRMED model (a real turn ran on it). */
const MODEL_FACT = "◆";
/** Bar marker for an EXPECTED model (from settings, not yet confirmed by a turn). */
const MODEL_PLAN = "◇";

/** Collapsed-bar model segment — first, leftmost, most stable thing in the line.
 *  Never tints the item background: like context, it is an identity signal, not
 *  a quota with consequences (the background stays tariff-pace only). */
function modelSegment(model: ModelView | undefined, m: Messages): string | null {
  if (!model) return null;
  if (model.changedFrom && model.label) {
    return `$(warning) ${model.changedFrom} → ${model.label}`;
  }
  if (model.state === "planned-default") return `${MODEL_PLAN} ${m.modelDefaultShort}`;
  if (!model.label) return null;
  if (model.state === "planned") return `${MODEL_PLAN} ${model.label} (${m.modelPlannedShort})`;
  return `${MODEL_FACT} ${model.label}`;
}

/** Segment naming an unanswered chat open beside this one, when it would start
 *  on a different model. Silent otherwise. */
function pendingSegment(model: ModelView | undefined, m: Messages): string | null {
  if (!model?.pendingLabel) return null;
  return `$(warning) ${m.modelPendingShort} ${model.pendingLabel}`;
}

/** Tooltip/panel line for the model — states the provenance in words. */
function modelLine(model: ModelView | undefined, m: Messages): string | null {
  if (!model) return null;
  if (model.changedFrom && model.label) return m.modelChangedLine(model.changedFrom, model.label);
  if (model.state === "planned-default") return m.modelDefaultLine;
  if (!model.label) return null;
  return model.state === "planned" ? m.modelPlannedLine(model.label) : m.modelActualLine(model.label);
}

/** Collapsed-bar effort segment, right after the model — the second half of the
 *  same "what am I about to run" question. Its state is inherited from the model
 *  segment (◆/◇ there), so it stays word-light. */
function effortSegment(model: ModelView | undefined, m: Messages): string | null {
  if (!model?.effort) return null;
  if (model.effortChangedFrom) {
    return `$(warning) ${m.effortShort} ${model.effortChangedFrom} → ${model.effort}`;
  }
  return `${m.effortShort} ${model.effort}`;
}

/** Tooltip/panel line for the effort level. */
function effortLine(model: ModelView | undefined, m: Messages): string | null {
  if (!model?.effort) return null;
  if (model.effortChangedFrom) return m.effortChangedLine(model.effortChangedFrom, model.effort);
  return model.state === "actual" ? m.effortActualLine(model.effort) : m.effortPlannedLine(model.effort);
}

/** How many subagents the tooltip names before summarising the rest. The hover
 *  card must stay readable; the full list lives in the panel. */
const TOOLTIP_AGENT_GROUPS = 3;

/** Muted technical breakdown, plus the LEAD's own reloads when it has any.
 *  RAW tokens here, not weighted: every other number in this line is raw, and a
 *  reload figure has to be a subset of the cache write printed beside it. */
function detailsText(totals: Totals, rebuild: RebuildView | undefined, m: Messages): string {
  const base = m.detailsLine(fmtTokens(totals.work), fmtTokens(totals.cacheRead), fmtTokens(totals.cacheWrite));
  const lead = rebuild?.lead;
  if (!lead || lead.tokens <= 0) return base;
  // Same completeness rule as the panel rows: where part of the log could not be
  // judged, this is a floor. A quieter line is still a claim.
  const value = `${lead.unjudged > 0 ? "≥ " : ""}${fmtTokens(lead.tokens, lead.unjudged > 0)}`;
  // The marker carries its definition with it here: this line does not depend on
  // the delegated section, whose ⓘ is the only other place `≥` is explained.
  const marker = lead.unjudged > 0 ? ` (${m.atLeastShort})` : "";
  return `${base} · ${m.detailsRebuild(value)}${marker}`;
}

/** One compact tooltip line: how much of this session was delegated, to which
 *  models. Null when the session spawned no subagents. */
function subagentTooltipLine(
  list: SubagentView[] | undefined,
  m: Messages,
  weights: Weights,
  rebuild?: IdleRebuild,
  sessionEffective = 0
): string | null {
  if (!list || !list.length) return null;
  const groups = subagentGroups(list);
  const total = groups.reduce((s, g) => s + g.effective, 0);
  const shown = groups.slice(0, TOOLTIP_AGENT_GROUPS).map((g) => {
    const name = g.modelLabel ?? "?";
    const eff = g.effort ? `/${g.effort}` : "";
    return `${name}${eff} ×${g.count} ≈${fmtTokens(g.effective)}`;
  });
  const rest = groups.length - shown.length;
  if (rest > 0) shown.push(m.subagentsMore(rest));
  // The hover is already dense: the reload fragment clears the same high bar as
  // the guidance sentence, or it is not there at all.
  const reb = rebuildDisplay(rebuild, sessionEffective, weights);
  if (reb.advise) {
    const bounded = (rebuild?.unjudged ?? 0) > 0;
    shown.push(m.subagentsRebuildFragment(`${bounded ? "≥ " : ""}${fmtTokens(reb.cost, bounded)}`));
    // The hover has no ⓘ to hide a definition in, so the marker explains itself
    // or it is a symbol the reader has to guess at.
    if (bounded) shown.push(m.atLeastShort);
  }
  return m.subagentsLine(list.length, fmtTokens(total), shown.join(" · "));
}

export interface View {
  text: string;
  tooltip: string;
  level: PaceLevel;
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
  if (ctx.limitState === "unavailable") {
    // A named reason is UI text and follows the panel's language; a raw
    // transport detail is reported verbatim and stays as it arrived.
    const detail = ctx.limitDetailKey === "codexNoWindow" ? m.codexContextNoWindow : ctx.limitDetail;
    return m.contextNoLimit(fmtTokens(ctx.usedTokens), detail);
  }
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

function codexUsageCompact(details: CodexQuotaDetails, m: Messages): string {
  const economy = codexEconomy(details);
  if (!economy) return m.codexUsageWaitingCompact;
  // No direction, no multiplier, no "so far" where an unstated write count puts
  // the two figures on either side of each other. The hover has no ⓘ to carry a
  // caveat, so the caveat has to be the line itself.
  if (!economy.directionCertain) {
    return m.codexCostUnknownCompact(
      fmtTokens(economy.effective, economy.effectiveBound),
      fmtTokens(economy.noCache),
      boundMark(economy.effectiveBound)
    );
  }
  // …and `economy.mult` is already null where an unstated count could change
  // what it prints, so the hover and the panel drop it on the same tick.
  return m.codexCostCompact(
    fmtTokens(economy.effective, economy.effectiveBound),
    fmtTokens(economy.noCache),
    economy.mult,
    economy.dir,
    codexCanReverse(details),
    boundMark(economy.effectiveBound)
  );
}

function codexDetailsLine(details: CodexQuotaDetails, m: Messages): string {
  if (!details.usage) return m.codexDetailsWaitingLine;
  const economy = codexEconomy(details);
  const write = codexCacheWrite(details);
  return m.codexDetailsLine(
    fmtTokens(economy?.work ?? 0),
    fmtTokens(details.usage.cachedInputTokens),
    write == null ? null : fmtTokens(write)
  );
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

/** "Polling is paused for another N (rate limit)" — or null when it is not.
 *  Stated as a countdown rather than a wall-clock time: no timezone to get
 *  wrong, and it matches how every other reset in this UI reads.
 *
 *  Only ever said about a reading that has actually gone stale. The two routes
 *  back off independently, so one can be paused while the other keeps the
 *  numbers current — and announcing a pause next to a figure that is visibly
 *  updating is not a warning, it is a contradiction. The note answers "why has
 *  this stopped moving?", so it appears exactly when something has. Pure. */
function pausedLine(quota: QuotaView, nowSec: number, m: Messages): string | null {
  const until = quota.pausedUntilSec;
  if (!until || until <= nowSec) return null;
  const live = quota.asOfSec != null && nowSec - quota.asOfSec < QUOTA_FRESH_SECONDS;
  if (live) return null;
  return m.quotaPaused(fmtRemaining(until - nowSec, m.units));
}

/** A per-model weekly reading older than this stops being presented as current:
 *  the row keeps its %, but states its age inline. Comfortably above the ~5-min
 *  write throttle of the cache we read, so a normally-refreshed value reads
 *  clean and only a genuinely old one is flagged. */
const SCOPED_AGE_NOTE_SECONDS = 15 * 60;

/** Beyond this the row is dropped entirely. A weekly % moves slowly, so a few
 *  hours old is still worth showing WITH its age — but a day-old value can be
 *  wrong by a whole working day, and showing nothing is the honest answer. */
const SCOPED_MAX_AGE_SECONDS = 24 * 3600;

/** Scoped windows that are recent enough to show, plus their age. Unknown age
 *  counts as too old (we never present an undated reading as current). Pure. */
function shownScoped(quota: QuotaView, nowSec: number): { windows: ScopedQuotaWindow[]; ageSec: number } {
  const windows = quota.scoped || [];
  if (!windows.length) return { windows: [], ageSec: 0 };
  const asOf = quota.scopedAsOfSec || 0;
  const ageSec = asOf > 0 ? Math.max(0, nowSec - asOf) : Infinity;
  if (ageSec > SCOPED_MAX_AGE_SECONDS) return { windows: [], ageSec: 0 };
  return { windows, ageSec };
}

/** Tooltip bullets for the per-model weekly windows — same shape as the 5h/7d
 *  bullets so the block reads as one list, with the age carried INLINE (a
 *  separate note under the list would be read as applying to all rows). */
function scopedTooltipLines(quota: QuotaView, nowSec: number, m: Messages): string[] {
  const { windows, ageSec } = shownScoped(quota, nowSec);
  const age = ageSec >= SCOPED_AGE_NOTE_SECONDS ? m.quotaScopedAge(fmtRemaining(ageSec, m.units)) : "";
  return windows.map((w) => {
    const p = paceLevel(w.pct, w.resetAt, nowSec, WINDOW_7D_SECONDS);
    const reset = w.resetAt ? m.quotaReset(fmtRemaining(w.resetAt - nowSec, m.units)) : "";
    return `- ${dot(p)} ${m.scopedLabel(w.label)} ${bar(w.pct)} **${w.pct.toFixed(0)}%** ${m.verdict[p]}${reset}${age}`;
  });
}

export function buildView(
  totals: Totals,
  weights: Weights,
  quota: QuotaView,
  nowSec: number,
  lang: Lang = "en",
  context?: ContextView,
  cache?: CacheView,
  model?: ModelView,
  subagents?: SubagentView[],
  rebuild?: RebuildView
): View {
  const m = messages(lang);
  const eff = effectiveTokens(totals, weights);
  // raw face-value cost if caching didn't exist: every token at 1× price.
  const noCache = totals.work + totals.cacheRead + totals.cacheWrite;
  const { dir: costDir, mult } = costDirection(eff, noCache);

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
  const body = ctxSeg ? `${tariffText} · ${ctxSeg}` : tariffText;
  // Model goes FIRST: it is the most stable part of the line, so the eye always
  // finds it in the same place — the whole point is a glance that answers "am I
  // on the right model?" before typing.
  const identity = [modelSegment(model, m), effortSegment(model, m), pendingSegment(model, m)]
    .filter(Boolean)
    .join(" · ");
  const text = identity ? `${identity} · ${body}` : body;

  // ── rich tooltip ──
  // Grouped into blocks separated by a rule, because the hover had grown into one
  // undifferentiated column: identity · cost · tariff + session · technical
  // detail · actions. A reader should find "what am I running" and "how much is
  // left" without parsing the whole card. (A Markdown hover offers no colour or
  // width control — a thematic break is the one grouping device it does support.
  // The panel, where we own the CSS, uses a short left-aligned line instead.)
  const RULE = "---";
  const t: string[] = [];
  t.push(m.title);
  t.push("");
  const identityLines = [
    modelLine(model, m),
    effortLine(model, m),
    model?.pendingLabel ? m.modelPendingLine(model.pendingLabel) : null,
  ].filter(Boolean) as string[];
  if (identityLines.length) {
    t.push(identityLines.join("  \n"));
    t.push("");
    t.push(RULE);
    t.push("");
  }
  // Same hedge, same condition as the panel twelve lines below: the tooltip and
  // the panel are two views of one tick, and a "so far" on one and not the other
  // tells the same reader two different things about the same two numbers.
  t.push(
    m.costCompact(
      fmtTokens(eff),
      fmtTokens(noCache),
      mult,
      costDir,
      cacheCanReverse(weights, [CACHE_WRITE_WEIGHT_1H, CACHE_WRITE_WEIGHT_5M, weights.cacheWrite])
    )
  );
  t.push("");

  const quotaLine = (label: string, w: QuotaWindow | null, windowSec: number): string => {
    if (!w) return `- ${label}: —`;
    const p = paceLevel(w.pct, w.resetAt, nowSec, windowSec);
    const reset = w.resetAt ? m.quotaReset(fmtRemaining(w.resetAt - nowSec, m.units)) : "";
    return `- ${dot(p)} ${label} ${bar(w.pct)} **${w.pct.toFixed(0)}%** ${m.verdict[p]}${reset}`;
  };

  // Per-model weekly windows come from their OWN source, so they survive a dead
  // 5h/7d poll — and are worth showing exactly then.
  const scopedLines = scopedTooltipLines(quota, nowSec, m);
  if (quota.state === "ok") {
    t.push(m.tariffHeader);
    t.push(quotaLine(m.w5h, quota.fiveH, WINDOW_5H_SECONDS));
    t.push(quotaLine(m.w7d, quota.sevenD, WINDOW_7D_SECONDS));
    t.push(...scopedLines);
    // Honest freshness: if the shown reading isn't brand-new (a poll that hasn't
    // refreshed yet, or a local-bridge value while the link is down), say how
    // old it is — the % stays visible, never silently dropped.
    if (quota.asOfSec) {
      const ageSec = nowSec - quota.asOfSec;
      // Blank line first: without it Markdown folds this note INTO the last
      // quota bullet, so the tooltip read "…resets in 3d0h Updated 5m ago."
      if (ageSec >= 60) t.push("", m.quotaAsOf(fmtRemaining(ageSec, m.units)));
    }
    const paused = pausedLine(quota, nowSec, m);
    if (paused) t.push("", `_${paused}_`);
  } else {
    t.push(m.quotaUnavail(m.quotaStateMsg[quota.state]));
    const paused = pausedLine(quota, nowSec, m);
    if (paused) t.push(`_${paused}_`);
    t.push(m.localAlwaysAccurate);
    if (scopedLines.length) {
      t.push("");
      t.push(m.tariffHeader);
      t.push(...scopedLines);
    }
  }
  // "This session" facts answer a different question from the tariff (which is
  // about the subscription), so they get their own labelled group instead of
  // trailing the quota list as if they were more quota.
  const sessionLines: string[] = [];
  const cl = contextLine(context, m);
  if (cl) sessionLines.push(`- ${cl}`);
  // cache tier — concise, self-explanatory (full footnotes live in the panel)
  if (cache?.tier) sessionLines.push(`- ${m.cacheTierLine(cache.tier)}`);
  // delegated work: which models were spawned and what they cost
  const sub = subagentTooltipLine(subagents, m, weights, rebuild?.subagents, eff);
  if (sub) sessionLines.push(`- ${sub}`);
  if (sessionLines.length) {
    t.push("");
    t.push(m.sessionHeader);
    t.push(...sessionLines);
  }
  t.push("");
  t.push(RULE);
  t.push("");
  // muted technical breakdown
  t.push(`_${detailsText(totals, rebuild, m)}_`);
  t.push("");
  t.push(m.legend);
  t.push("");
  t.push(RULE);
  t.push("");
  t.push(
    `[${m.openPanel}](command:ccStatusbar.openPanel) · [${m.switchLang}](command:ccStatusbar.switchLanguage)` +
      ` · [${m.reportIssue}](${ISSUES_URL})`
  );

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
  const body = segs.length
    ? `Codex · ${segs.join(" · ")}${ctxSeg ? ` · ${ctxSeg}` : ""}`
    : m.providerUnavailableText("Codex");
  const identity = [modelSegment(details.model, m), effortSegment(details.model, m)]
    .filter(Boolean)
    .join(" · ");
  const text = identity ? `${identity} · ${body}` : body;
  const t: string[] = [m.codexTitle, ""];
  const identityLines = [modelLine(details.model, m), effortLine(details.model, m)].filter(Boolean) as string[];
  if (identityLines.length) {
    t.push(identityLines.join("  \n"));
    t.push("", "---", "");
  }
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
  t.push(`[${m.openPanel}](command:ccStatusbar.openPanel) · [${m.reportIssue}](${ISSUES_URL})`);
  return { text, tooltip: t.join("\n"), level: segs.length ? level : "tight" };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Issue tracker — the extension's only route back to the project. Kept in sync
 *  with `bugs.url` in package.json by a test, so the two cannot drift. */
export const ISSUES_URL = "https://github.com/Solux-dev/cc-statusbar/issues";

/** A label (or a whole sentence) plus its ⓘ footnote. The visible text must read
 *  on its own — the footnote adds the full story, never carries it. Shared by
 *  both panels so a hover behaves identically whichever provider is active. */
function hintSpan(label: string, hint: string): string {
  return `<span class="hint" tabindex="0">${esc(label)} ⓘ<span class="tip">${esc(hint)}</span></span>`;
}

/** Styling for `hintSpan`, identical in both panels.
 *
 *  Nothing on the way down to a `.tip` may dim itself with `opacity`. Opacity
 *  multiplies through the whole subtree, so a muted label was taking its
 *  footnote with it and the page read straight through the box — worst where
 *  the label was dimmed twice over (a `.sub` line inside a hinted row). Labels
 *  are muted with COLOUR from here on; the overrides below undo the opacity the
 *  containers still set for their unhinted neighbours. */
const HINT_CSS = `
  .hint { position:relative; border-bottom:1px dotted currentColor; cursor:help; outline:none; }
  .row .hint { opacity:1; color:var(--vscode-descriptionForeground, var(--vscode-foreground)); }
  .hint .tip {
    visibility:hidden; opacity:0; position:absolute; left:0; bottom:140%; z-index:10;
    /* Viewport-aware: the panel can be docked into a narrow side column, and the
       longest footnote (the RU cost line) would otherwise push the whole page
       into horizontal scrolling. border-box keeps padding inside the cap, so
       the number is the OUTER width — 322px reproduces exactly the box the flat
       300px content cap used to draw, and 36px is the body's 18px side padding
       doubled. The plain declaration first is a fallback: a renderer without
       CSS min() drops the second line and keeps a cap instead of none. */
    box-sizing:border-box;
    width:max-content; max-width:322px; max-width:min(322px, calc(100vw - 36px));
    padding:8px 10px; border-radius:6px;
    font-size:12px; font-weight:normal; line-height:1.45; white-space:normal; text-align:left;
    background:var(--vscode-editorHoverWidget-background, var(--vscode-menu-background, #252526));
    color:var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
    border:1px solid var(--vscode-editorHoverWidget-border, rgba(128,128,128,.35));
    box-shadow:0 2px 8px rgba(0,0,0,.35); transition:opacity .1s ease; pointer-events:none;
  }
  .hint:hover .tip, .hint:focus .tip { visibility:visible; opacity:1; }`;

/** Footer link back to the project, identical in both panels. No opacity on the
 *  anchor: dimming a coloured link is what pushes 12px text under the readable
 *  contrast ratio, and this link is the one thing on the page a user must be
 *  able to find. The fallback is the theme's own text colour rather than a
 *  hard-coded blue — a blue that reads on dark is unreadable on light. */
const FOOT_CSS = `
  .foot { margin-top:16px; font-size:12px; }
  .foot a { color: var(--vscode-textLink-foreground, var(--vscode-foreground)); text-decoration:none; }
  .foot a:hover, .foot a:focus { text-decoration:underline; }`;

/** The one place the extension points back at the project. Rendered in both
 *  panels; the marketplace page is not the route, because most people install
 *  from inside the editor and never see it. */
function footHtml(m: Messages): string {
  return `<div class="foot"><a href="${ISSUES_URL}">${esc(m.reportIssue)}</a></div>`;
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
  cache?: CacheView,
  model?: ModelView,
  subagents?: SubagentView[],
  leadEffective?: number,
  rebuild?: RebuildView,
  /** Is the per-agent list open? The panel runs no scripts and is re-rendered
   *  whole on every tick, so a plain <details> would snap shut every 10 seconds:
   *  the state has to live in the extension and come back in here. */
  delegatedExpanded = false
): string {
  const m = messages(lang);
  const eff = effectiveTokens(totals, weights);
  const noCache = totals.work + totals.cacheRead + totals.cacheWrite;
  const saved = Math.max(0, noCache - eff);
  // Never assume the comparison points the way we hope — see costDirection.
  const { dir: costDir, mult } = costDirection(eff, noCache);

  // Identity only — which model and effort produced the numbers below. The page
  // opens on "how much have I got left" (quota + context); the token-equivalent
  // follows as the third block, above cache and delegated work. See
  // `costSection`.
  const rows: string[] = [];
  const identity = [
    modelLine(model, m),
    effortLine(model, m),
    model?.pendingLabel ? m.modelPendingLine(model.pendingLabel) : null,
  ].filter(Boolean) as string[];
  for (const line of identity) {
    rows.push(`<div class="ctxrow">${esc(line.replace(/\*\*/g, ""))}</div>`);
  }
  // No closing rule here: the next block is an <h3> section, and h3 already
  // draws the same short rule above itself. Two rules in a row read as a gap.

  const quotaBlock: string[] = [];
  const windowRow = (
    label: string,
    w: QuotaWindow | null,
    windowSec: number,
    // extras used only by the per-model rows: an inline age suffix and a hover
    // footnote explaining what a model-scoped weekly window is.
    suffix = "",
    hint = ""
  ): void => {
    const title = hint ? ` title="${esc(hint)}"` : "";
    if (!w) {
      quotaBlock.push(`<div class="qrow"${title}><span class="qlabel">${esc(label)}</span><span>—</span></div>`);
      return;
    }
    const lvl = paceLevel(w.pct, w.resetAt, nowSec, windowSec);
    const color = lvl === "over" ? "var(--cc-red)" : lvl === "tight" ? "var(--cc-yellow)" : "var(--cc-green)";
    const pct = Math.max(0, Math.min(100, w.pct));
    const reset = w.resetAt ? esc(m.quotaReset(fmtRemaining(w.resetAt - nowSec, m.units))) : "";
    quotaBlock.push(
      `<div class="qrow"${title}>` +
        `<span class="dot" style="background:${color}"></span>` +
        `<span class="qlabel">${esc(label)}</span>` +
        `<span class="bar"><i style="width:${pct.toFixed(0)}%;background:${color}"></i></span>` +
        `<b>${w.pct.toFixed(0)}%</b>` +
        `<span class="verdict">${esc(m.verdict[lvl])}${reset}${esc(suffix)}</span>` +
        `</div>`
    );
  };

  // Per-model weekly rows (today: Fable). Their own source and their own clock,
  // so they render in BOTH branches below — a dead 5h/7d poll must not hide a
  // number that is still perfectly valid.
  const scoped = shownScoped(quota, nowSec);
  const scopedRows = (): void => {
    const suffix =
      scoped.ageSec >= SCOPED_AGE_NOTE_SECONDS ? m.quotaScopedAge(fmtRemaining(scoped.ageSec, m.units)) : "";
    for (const w of scoped.windows) {
      windowRow(m.scopedLabel(w.label), w, WINDOW_7D_SECONDS, suffix, m.panelScopedHint);
    }
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
    scopedRows();
    const paused = pausedLine(quota, nowSec, m);
    quotaSection =
      `<h3>${esc(m.panelQuotaHeader)}</h3>${quotaBlock.join("")}` +
      (paused ? `<p class="muted">${esc(paused)}</p>` : "") +
      ctxRow;
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
    // Keep the heading in the offline branch too: without it the panel opened
    // with a bare "temporarily unavailable", giving no clue WHAT is unavailable.
    scopedRows(); // independent source — still valid while 5h/7d is down
    const paused = pausedLine(quota, nowSec, m);
    quotaSection =
      `<h3>${esc(m.panelQuotaHeader)}</h3>` +
      `<p class="muted">${esc(reason)}</p>` +
      (paused ? `<p class="muted">${esc(paused)}</p>` : "") +
      lastKnown +
      quotaBlock.join("") +
      `<p class="muted">${esc(m.panelLocalAccurate)}</p>` +
      ctxRow;
  }

  // cache insight: auto-detected tier + descriptive hit rate, each with a
  // hover footnote (ⓘ) so any user can learn what the line means.
  let cacheSection = "";
  if (cache && (cache.tier || cache.hitRatePct != null)) {
    const crows: string[] = [];
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

  // Delegated work. The Lead chooses subagent models on its own, so this is the
  // only place the owner can see WHERE the session's tokens actually went —
  // e.g. an expensive model quietly doing a research errand.
  let subagentSection = "";
  if (subagents && subagents.length) {
    const groups = subagentGroups(subagents);
    const subTotal = groups.reduce((s, g) => s + g.effective, 0);
    const lead = leadEffective ?? Math.max(0, eff - subTotal);
    const sessionTotal = lead + subTotal;
    const sharePct = sessionTotal > 0 ? Math.round((subTotal / sessionTotal) * 100) : 0;
    // A real but small share must not print as "0%" — in a section about what
    // delegation COST, that reads as "it cost nothing". And the mirror: a real
    // lead spend must not vanish into "100%", which reads as "the main session
    // spent nothing".
    const shareText =
      sharePct === 0 && subTotal > 0
        ? "<1"
        : sharePct === 100 && lead > ZERO_TOLERANCE
        ? ">99"
        : String(sharePct);

    const gRows = groups
      .map((g) => {
        const name = `${g.modelLabel ?? "?"}${g.effort ? ` · ${g.effort}` : ""}`;
        const share = subTotal > 0 ? Math.round((g.effective / subTotal) * 100) : 0;
        return (
          `<div class="qrow sub">` +
          `<span class="alabel">${esc(name)}</span>` +
          `<span class="bar"><i style="width:${share}%;background:var(--cc-green)"></i></span>` +
          `<b>≈ ${fmtTokens(g.effective)}</b>` +
          `<span class="verdict">${esc(m.subagentsCount(g.count))}</span>` +
          `</div>`
        );
      })
      .join("");

    // Individual agents, MOST EXPENSIVE first (the caller sorts them). This
    // section answers "where did my tokens go", so ordering by recency could hide
    // the biggest spender below the cut. Capped so a 40-agent session stays a
    // readable page, with the remainder stated — a silent cut would read as
    // "that's all of them".
    const LIST_CAP = 12;
    const shown = subagents.slice(0, LIST_CAP);
    // The idle cell is offered only when at least one row can actually carry a
    // number: a column of "—" teaches nothing and costs every row its width.
    const idles = shown.map((a) => agentIdle(a, weights));
    const anyIdle = idles.some((i) => i.known);
    // The column defines itself in its own cell's ⓘ rather than in a paragraph
    // under the list. The definition is read once and never again, and as
    // running text it was longer than every row it explained put together.
    // The ≥ is defined next to it only where a cell actually carries one — an
    // explanation of a marker nobody can see is just more text to read.
    const idleHint = idles.some((i) => i.atLeast)
      ? `${m.panelAgentIdleLegend} ${m.panelAtLeastNote}`
      : m.panelAgentIdleLegend;
    const listRows = shown
      .map((a, i) => {
        const depth = a.spawnDepth && a.spawnDepth > 1 ? m.subagentDepth(a.spawnDepth) : null;
        const who = [a.agentType || m.agentFallbackName, a.modelLabel || "?", a.effort || null, depth]
          .filter(Boolean)
          .join(" · ");
        const what = a.description ? ` — ${a.description}` : "";
        const idle = idles[i];
        // Tokens beside the % on purpose: 31% of a small agent is a rounding
        // error, 31% of a large one is worth changing how you work.
        const idleCell = !anyIdle
          ? ""
          : `<span class="idle">${hintSpan(
              idle.known
                ? m.panelAgentIdle(
                    idle.pctText,
                    idle.cost > 0 ? fmtTokens(idle.cost, idle.atLeast) : null,
                    idle.atLeast
                  )
                : m.panelAgentIdleUnknown,
              idleHint
            )}</span>`;
        return `<div class="arow"><b>≈ ${fmtTokens(a.effective)}</b><span>${esc(who)}${esc(what)}</span>${idleCell}</div>`;
      })
      .join("");
    const more = subagents.length > LIST_CAP ? `<div class="sub">${esc(m.subagentsMore(subagents.length - LIST_CAP))}</div>` : "";

    // What waiting cost. One muted line in the same style as the summary above
    // it, carrying three facts: how much, why, and how long an agent's cache
    // lives. It belongs HERE and not in the Cache section: the reader is
    // already thinking about agents, so it costs one line and no new section.
    // WEIGHTED tokens, like every figure in this section.
    const reb = rebuildDisplay(rebuild?.subagents, eff, weights);
    // Share of what the AGENTS spent, not of the session: it is the yardstick
    // for the per-agent percentages right below it, so both must divide by the
    // same thing or the reader compares two different scales.
    // Marked as a lower bound when any agent had a gap we could not judge: the
    // reloads we DID measure are real, the ones we could not are not zero. A
    // bound is floored, not rounded — see fmtTokens(…, floor).
    const rebUnjudged = (rebuild?.subagents?.unjudged ?? 0) > 0;
    const rawShare = subTotal > 0 ? (reb.cost / subTotal) * 100 : 0;
    const rebShare = rebUnjudged ? Math.floor(rawShare) : Math.round(rawShare);
    const rebAtLeast = rebUnjudged && reb.cost > 0;
    // "<1%" is an UPPER bound on the share, and with unjudged gaps the tokens
    // beside it are a LOWER one. Two opposite bounds on a single measurement is
    // not a hedge, it is a contradiction — and "≥ <1%" is not a way out of it.
    // So the share is dropped entirely there, exactly as `agentIdle` drops it
    // in the per-agent cells; everywhere else it keeps the marker the tokens do.
    const rebShareText =
      rebAtLeast && rebShare === 0
        ? null
        : `${rebAtLeast ? "≥" : ""}${
            rebShare === 0 && reb.cost > 0
              ? "<1"
              : rebShare === 100 && subTotal - reb.cost > ZERO_TOLERANCE
              ? ">99"
              : String(rebShare)
          }%`;
    const rebuildRow = reb.show
      ? `<div class="sub solid">${hintSpan(
          m.panelSubagentsRebuild(`${rebAtLeast ? "≥" : "≈"} ${fmtTokens(reb.cost, rebAtLeast)}`, rebShareText),
          rebAtLeast ? `${m.panelSubagentsRebuildHint} ${m.panelAtLeastNote}` : m.panelSubagentsRebuildHint
        )}</div>`
      : "";
    // The guidance sentence stays with the number it explains — and stays
    // visible while the list is collapsed, because it is the actionable half.
    const adviceRow = reb.advise ? `<div class="sub">${esc(m.panelSubagentsRebuildNote)}</div>` : "";

    // The list is the long part, so it is what collapses. Everything a reader
    // needs at a glance — how much was delegated, to which models, what waiting
    // cost — stays visible either way.
    const toggleRow =
      `<div class="sub toggle"><a href="command:${DELEGATED_TOGGLE_COMMAND}">` +
      `${esc(delegatedExpanded ? m.panelSubagentsCollapse : m.panelSubagentsExpand)}</a></div>`;

    subagentSection =
      `<h3>${esc(m.panelSubagentsHeader)}</h3>` +
      `<div class="sub">${esc(m.panelSubagentsSummary(subagents.length, fmtTokens(subTotal), shareText))}</div>` +
      rebuildRow +
      adviceRow +
      gRows +
      (delegatedExpanded
        ? listRows + more + `<div class="sub">${esc(m.panelSubagentsNote)}</div>`
        : "") +
      toggleRow;
  }

  // Token-equivalent — the headline number, and under it the ONE comparison that
  // says what the cache is doing for you. That comparison used to sit inside the
  // ⓘ; a hover is the wrong place for the figure this extension exists to show,
  // and it was invisible to anyone who never hovers. What stays in the ⓘ is the
  // derived total ("cache saved", = the difference of the two visible numbers)
  // and the disclaimer. Composed from the existing labels, so neither language
  // can drift out of sync with the other.
  // The saving is only a saving while the comparison points that way. Decided on
  // the EXACT numbers, not on `costDir`: that field rounds 1.04× to "about the
  // same", and a rounded presentation state must never be read as the sign — a
  // cache that has saved 3.6k has still saved something.
  const costHint =
    noCache > eff
      ? // No multiplier here. It used to read "Cache saved: ≈ 26.8M tok (~6.1×
        // lower)", where the ratio follows a figure that is neither of its two
        // operands — the saving is not 6.1× lower than anything. The visible
        // line above the ⓘ already states the ratio, against the figures it is
        // actually between.
        `${m.panelSavedLabel}: ≈ ${fmtTokens(saved)} ${m.tok}. ${m.panelTokenCostNote}`
      : // Which cause is named matters, and "a write exists" is not the same
        // question as "a write is what moved this number". Both sides are priced
        // against a fresh token, so each one's CONTRIBUTION is what it adds over
        // reading that input fresh — and the bigger positive contribution is the
        // cause. With no contribution at all — or with one too small to change
        // either figure on screen — no cause is named.
        // "Too small to show" needs BOTH of the page's own statements to be
        // blind to it: the two printed figures and the multiplier. `costDir`
        // alone rounds the RATIO (1.3k vs 1.2k is "about the same" at 1.04×),
        // and formatted equality alone rounds the FIGURES (two "1.2M" can sit
        // above a visible "~1.1× less"). Either one on its own suppresses a
        // cause the reader can see stated.
        `${costCauseHint(
          totals,
          weights,
          m,
          fmtTokens(eff) === fmtTokens(noCache) && costDir === "same"
        )} ${m.panelTokenCostNote}`;
  const costSection =
    `<div class="sep"></div>` +
    `<div class="row">${hintSpan(m.panelCostLabel, costHint)}` +
    `<b>≈ ${fmtTokens(eff)} ${esc(m.tok)}</b></div>` +
    // Claude prices writes by tier, so all three write weights are in play when
    // asking whether a later turn could still narrow the gap.
    `<div class="sub">${esc(
      m.panelCostCompare(
        fmtTokens(noCache),
        mult,
        costDir,
        cacheCanReverse(weights, [CACHE_WRITE_WEIGHT_1H, CACHE_WRITE_WEIGHT_5M, weights.cacheWrite])
      )
    )}</div>`;

  // muted technical breakdown
  const detailsSection =
    `<h3>${esc(m.panelDetailsHeader)}</h3>` +
    `<div class="sub">${esc(detailsText(totals, rebuild, m))}</div>`;

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  :root { --cc-green:#3fb950; --cc-yellow:#d6a31a; --cc-red:#e5534b; }
  .alabel { width:150px; opacity:.9; overflow-wrap:anywhere; }
  /* a subagent's value reads "≈ 27.5k" — wider than the quota column's bare "%" */
  .qrow.sub b { width:auto; min-width:78px; white-space:nowrap; }
  .qrow.sub .verdict { white-space:nowrap; }
  /* wrap, so a docked side column drops the idle cell onto its own line instead
     of squeezing the task description into a one-word column */
  .arow { display:flex; flex-wrap:wrap; gap:10px; align-items:baseline; padding:2px 0; font-size:12px; }
  .arow b { min-width:64px; text-align:right; font-variant-numeric: tabular-nums; }
  .arow span { opacity:.75; overflow-wrap:anywhere; }
  /* muted by colour, not opacity — this cell carries a footnote (see HINT_CSS) */
  .arow .idle { margin-left:auto; white-space:nowrap; opacity:1;
                color:var(--vscode-descriptionForeground, var(--vscode-foreground));
                font-variant-numeric: tabular-nums; }
  /* the toggle is a link people must be able to find: no .sub dimming on it */
  .toggle { opacity:1; padding-top:4px; }
  .toggle a { color: var(--vscode-textLink-foreground, var(--vscode-foreground)); text-decoration:none; }
  .toggle a:hover, .toggle a:focus { text-decoration:underline; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 14px 18px; font-size: 13px; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  /* Sections are separated by a SHORT left-aligned rule rather than a full-width
     one: enough to group the page visually without turning it into a form. */
  h3 { font-size: 13px; margin: 22px 0 8px; opacity: .85; position:relative; padding-top: 14px; }
  h3::before { content:""; position:absolute; top:0; left:0; width:44%; height:1px;
               background: var(--vscode-panel-border, rgba(128,128,128,.32)); }
  .sep { width:44%; height:1px; margin:14px 0 12px;
         background: var(--vscode-panel-border, rgba(128,128,128,.32)); }
  .row { display:flex; justify-content:space-between; align-items:baseline; padding:3px 0; }
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
  /* A .sub line that carries a footnote mutes itself by colour instead — see
     HINT_CSS. The rest of the .sub lines keep the opacity: they hold no tip. */
  .sub.solid { opacity:1; color:var(--vscode-descriptionForeground, var(--vscode-foreground)); }
  .muted { opacity:.65; font-size:12px; }${HINT_CSS}
  /* .arow span would dim this one back down; and the cell hangs on the right
     edge, so its footnote has to open leftward or it opens off the page. */
  .arow .idle .hint { opacity:1; }
  .arow .idle .tip { left:auto; right:0; }${FOOT_CSS}
  .legend { margin-top:18px; opacity:.6; font-size:12px; }
</style>
</head>
<body>
  <h2>${esc(m.panelTitle)}</h2>
  ${rows.join("\n  ")}
  ${quotaSection}
  ${costSection}
  ${detailsSection}
  ${cacheSection}
  ${subagentSection}
  <div class="legend">${esc(m.panelLegend)}</div>
  ${footHtml(m)}
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

  // Identity only, same as the Claude panel: the page opens on the quota.
  const identityRows: string[] = [];
  const identityLines = [modelLine(details.model, m), effortLine(details.model, m)].filter(Boolean) as string[];
  for (const line of identityLines) {
    identityRows.push(`<div class="ctxrow">${esc(line.replace(/\*\*/g, ""))}</div>`);
  }

  // Token-equivalent — one line at the foot, its extras in the ⓘ. Kept in step
  // with the Claude panel on purpose: switching provider must not rearrange the
  // page under the reader.
  const costRows: string[] = [];
  if (economy) {
    // Same shape as the Claude panel, and since round 16 the same arithmetic:
    // both sides of the cache exist here too, so both can move this figure.
    // Codex states no cache TIER, so a write can only be priced by the
    // unstated-tier setting — which is why the two hints that name Claude's
    // tiers have Codex twins instead of being reused.
    // Three different facts, three different sentences — and the priced one
    // quotes what was PRICED, never the raw count the clamp may have cut down.
    const writeW = details.weights?.cacheWrite ?? 1.25;
    const writeNote =
      economy.writeStated == null
        ? // Only worth saying where it could have changed the figure: with no
          // ordinary input left, an unstated write count could not have moved it.
          // …and which WAY it could have moved it is the write weight's answer,
          // not the fact that the count is missing: a weight below 1 makes the
          // very same figure a ceiling. `cacheWriteWeight` goes down to 0.
          economy.ordinaryInput > 0
          ? ` ${m.codexPanelWriteUnstatedHint(String(writeW), writeBound(writeW))}`
          : ""
        : economy.writeStated > economy.writeInput
        ? ` ${m.codexPanelWriteClampedHint(fmtTokens(economy.writeStated), fmtTokens(economy.writeInput))}`
        : economy.writeInput > 0
        ? ` ${m.codexPanelWritePricedHint(fmtTokens(economy.writeInput))}`
        : "";
    const savedBound = economy.savedBound;
    const costHint = !economy.directionCertain
      ? // Ahead of every other branch, including the cause chain: each of those
        // names which figure is larger or why, and that is the one thing an
        // unstated write count makes unknowable here. It also carries the
        // missing counter itself, so `writeNote` is NOT appended — it would say
        // the same sentence a second time, more weakly.
        `${m.codexPanelDirectionUnknownHint(
          fmtTokens(economy.effectiveNone),
          fmtTokens(economy.effectiveAll),
          fmtTokens(economy.noCache)
        )} ${m.codexPanelTokenCostNote}`
      : economy.noCache > economy.effective
        ? // The saving is `noCache − effective`, and `noCache` is exact — so it
          // carries the OPPOSITE bound to the figure it is subtracted from: a
          // token-equivalent that can only be higher leaves a saving that can
          // only be smaller. The multiplier is that same ratio and moves with
          // it, so it is dropped rather than printed unmarked; the ⓘ that
          // follows says which way and why.
          // No multiplier, for the same reason as the Claude twin: the ratio
          // would follow the saving, which is neither of its operands, and the
          // visible line above already states it against the right two figures.
          `${m.codexPanelSavedLabel}: ${boundMark(savedBound)} ${fmtTokens(economy.saved, savedBound)} ` +
          `${m.tok}.${writeNote}${savedBound === "exact" ? "" : ` ${m.savedBoundNote(savedBound)}`} ` +
          m.codexPanelTokenCostNote
        : `${codexCostCauseText(economy, details, m)}${writeNote} ${m.codexPanelTokenCostNote}`;
    costRows.push(
      // The headline carries its own sign. An unstated write count that would
      // change what this prints makes it a bound, and a bound printed bare as
      // "≈" is read as a measurement — the ⓘ under it is not where a reader
      // learns that the visible number is not the number.
      `<div class="row">${hintSpan(m.codexPanelCostLabel, costHint)}` +
        `<b>${boundMark(economy.effectiveBound)} ${fmtTokens(economy.effective, economy.effectiveBound)} ` +
        `${esc(m.tok)}</b></div>`
    );
    // Same visible comparison as the Claude panel — switching provider must not
    // move a number the reader has learned to look for.
    costRows.push(
      // See the note on `panelCostCompare`: the hedge is dropped where no weight
      // is below 1, because then no later turn can narrow the gap. And every one
      // of its branches names a direction, so it may not be used at all where an
      // unstated write count leaves the direction unknown.
      // `economy.mult` is already null where the unstated count could change
      // what it prints, so the line states the two figures and nothing about how
      // far apart they are — which is all that state can support.
      `<div class="sub">${esc(
        economy.directionCertain
          ? m.panelCostCompare(fmtTokens(economy.noCache), economy.mult, economy.dir, codexCanReverse(details))
          : m.codexCompareUnknown(fmtTokens(economy.noCache))
      )}</div>`
    );
  } else {
    costRows.push(`<div class="row">${hintSpan(m.codexPanelCostLabel, m.codexPanelTokenCostNote)}<b>—</b></div>`);
    costRows.push(`<div class="empty">${esc(m.codexPanelUsageWaiting)}</div>`);
  }
  const costSection = `<div class="sep"></div>${costRows.join("")}`;

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
  .row .soft, .soft { opacity:.7; font-weight:600; }
  .sub { opacity:.6; font-size:12px; line-height:1.45; padding:2px 0 6px; }
  .ctxrow { padding:6px 0 2px; opacity:.85; font-variant-numeric: tabular-nums; }
  .sep { width:44%; height:1px; margin:14px 0 12px;
         background: var(--vscode-panel-border, rgba(128,128,128,.32)); }
  .empty { opacity:.7; font-size:12px; line-height:1.5; padding:6px 0 2px; max-width:720px; }
  .qrow { display:flex; align-items:center; gap:8px; padding:5px 0; }
  .qrow.ctx { padding-bottom:2px; }
  .dot { width:10px; height:10px; border-radius:50%; flex:0 0 auto; }
  .qlabel { width:28px; opacity:.85; }
  .bar { flex:1; height:8px; border-radius:4px; background:var(--vscode-input-background,rgba(255,255,255,.08)); overflow:hidden; min-width:120px; }
  .bar i { display:block; height:100%; }
  .qrow b { width:42px; text-align:right; font-variant-numeric: tabular-nums; }
  .verdict { opacity:.7; font-size:12px; }
  .muted { opacity:.55; }${HINT_CSS}${FOOT_CSS}
</style>
</head>
<body>
  <h2>${esc(m.codexPanelTitle)}</h2>
  ${identityRows.join("\n  ")}
  ${quotaSection}
  ${contextSection}
  ${costSection}
  ${detailsSection}
  ${cacheSection}
  ${footHtml(m)}
</body>
</html>`;
}
