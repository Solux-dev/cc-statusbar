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
  effectiveTokens,
  rebuildCost,
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
  /** Which source the shown reading came from (for the panel/diagnostics):
   *  "usage" = our own GET of the account's usage payload (free, carries every
   *  window), "network" = the rate-limit header poll, "local" = a file written
   *  by Claude Code itself (statusLine bridge or its usage cache). */
  source?: "network" | "local" | "usage";
  /** Per-model weekly windows (today: Fable). Deliberately tooltip/panel-only —
   *  they answer "can I still run THIS model this week?", a question you ask
   *  before switching models, not something the collapsed bar must carry. They
   *  come from a THIRD source with its own clock, hence their own asOf. */
  scoped?: ScopedQuotaWindow[];
  /** Unix seconds the scoped windows were read from the server. 0/undefined =
   *  unknown → treated as too old to show. */
  scopedAsOfSec?: number;
  /** Unix seconds a 429 backoff ends, when one is in force. An ageing number
   *  with no stated reason is unreportable — the reader cannot tell a paused
   *  poll from a broken one, so we name it. */
  pausedUntilSec?: number;
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

/** Which model the session runs on. `state` is the PROVENANCE, and it is shown,
 *  never smoothed over: "actual" = a real turn ran on it, "planned" = no turn
 *  yet and Claude Code's settings say a new chat starts on it, "planned-default"
 *  = no turn yet and nothing pinned (account default). `changedFrom` is set for
 *  a short window right after the model changed → the segment shouts instead of
 *  quietly updating. */
export interface ModelView {
  label: string | null;
  state: "actual" | "planned" | "planned-default";
  changedFrom?: string | null;
  /** A chat tab is open next to this one and has NOT answered yet, and it is set
   *  to start on a DIFFERENT model. VS Code exposes no way to know which tab is
   *  focused, so instead of guessing, the bar names the other one. Null when
   *  there is no such chat or it would start on the same model (silent when
   *  nothing can go wrong). */
  pendingLabel?: string | null;
  /** Reasoning effort of the same turn / the same settings ("high", "xhigh"…).
   *  Null when the transcript predates the field and nothing is pinned. */
  effort?: string | null;
  effortChangedFrom?: string | null;
}

/** One subagent of the current session, already reduced to display data. The
 *  point is transparency about DELEGATED spend: the Lead picks these models on
 *  its own, and without this they are invisible tokens. */
export interface SubagentView {
  agentType: string | null;
  description: string | null;
  /** Raw model id — the grouping key. Two deployments of the same family (a
   *  Bedrock ARN and a plain id, or two dated snapshots) must not merge into one
   *  row just because they render to the same short label. */
  modelId: string | null;
  modelLabel: string | null;
  effort: string | null;
  /** 1 = spawned by the Lead; >1 = spawned by another agent. */
  spawnDepth?: number | null;
  /** Cache-weighted token-equivalent, same metric as the session headline. */
  effective: number;
}

/** Group subagents by model+effort — the answer to "which models did the Lead
 *  hand my work to, and what did each cost". Sorted by spend, biggest first, so
 *  an expensive delegation stands out. Pure. */
export function subagentGroups(
  list: SubagentView[]
): Array<{ modelLabel: string | null; effort: string | null; count: number; effective: number }> {
  const map = new Map<string, { modelLabel: string | null; effort: string | null; count: number; effective: number }>();
  for (const a of list) {
    // key on the RAW id (not the display label) so distinct models never merge
    const key = `${a.modelId ?? a.modelLabel ?? "?"}|${a.effort ?? ""}`;
    const cur = map.get(key) || { modelLabel: a.modelLabel, effort: a.effort, count: 0, effective: 0 };
    cur.count += 1;
    cur.effective += a.effective;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.effective - a.effective);
}

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

/** What waiting cost, as the UI receives it: the lead's own idle gaps and the
 *  sum over the subagent streams. */
export interface RebuildView {
  lead?: IdleRebuild;
  subagents?: IdleRebuild;
}

/** Absolute floor for the reload line. Below this the number is real but not
 *  worth a director's attention. */
const REBUILD_MIN_COST = 1_000_000;
/** …and it must also be this share of the session, for the same reason. */
const REBUILD_MIN_SESSION_SHARE = 0.03;
/** The guidance sentence fires on ONE condition: reloads are this share of
 *  everything the subagents wrote to cache. A second condition ("and at least
 *  3 separate pauses") was rejected on purpose — a single long pause is not a
 *  false positive, the tokens were spent either way, and suppressing a true
 *  number would be complexity bought with accuracy. */
const REBUILD_ADVICE_SHARE = 0.2;

/** Should the reload figure be shown, and should the guidance sentence come
 *  with it? Pure, so both thresholds are unit-testable away from the markup.
 *  The advice is gated on the line being visible: a sentence about reloads with
 *  no number above it is the always-on advisory that wording rule 5 forbids. */
export function rebuildDisplay(
  r: IdleRebuild | undefined,
  sessionEffective: number,
  weights: Weights
): { show: boolean; advise: boolean; cost: number } {
  if (!r || r.tokens <= 0) return { show: false, advise: false, cost: 0 };
  const cost = rebuildCost(r, weights);
  const share = sessionEffective > 0 ? cost / sessionEffective : 0;
  const show = cost >= REBUILD_MIN_COST && share >= REBUILD_MIN_SESSION_SHARE;
  const dominant = r.cacheWrite > 0 && r.tokens / r.cacheWrite >= REBUILD_ADVICE_SHARE;
  return { show, advise: show && dominant, cost };
}

/** Muted technical breakdown, plus the LEAD's own reloads when it has any.
 *  RAW tokens here, not weighted: every other number in this line is raw, and a
 *  reload figure has to be a subset of the cache write printed beside it. */
function detailsText(totals: Totals, rebuild: RebuildView | undefined, m: Messages): string {
  const base = m.detailsLine(fmtTokens(totals.work), fmtTokens(totals.cacheRead), fmtTokens(totals.cacheWrite));
  const lead = rebuild?.lead;
  return lead && lead.tokens > 0 ? `${base} · ${m.detailsRebuild(fmtTokens(lead.tokens))}` : base;
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
  if (reb.advise) shown.push(m.subagentsRebuildFragment(fmtTokens(reb.cost)));
  return m.subagentsLine(list.length, fmtTokens(total), shown.join(" · "));
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
  model?: ModelView;
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
  t.push(m.costCompact(fmtTokens(eff), fmtTokens(noCache), mult));
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
  cache?: CacheView,
  model?: ModelView,
  subagents?: SubagentView[],
  leadEffective?: number,
  rebuild?: RebuildView
): string {
  const m = messages(lang);
  const eff = effectiveTokens(totals, weights);
  const noCache = totals.work + totals.cacheRead + totals.cacheWrite;
  const saved = Math.max(0, noCache - eff);
  const mult = eff > 0 ? fmtMult(noCache / eff) : "1";

  // headline: cost comparison + savings multiplier (lead with the answer)
  const rows: string[] = [];
  const identity = [
    modelLine(model, m),
    effortLine(model, m),
    model?.pendingLabel ? m.modelPendingLine(model.pendingLabel) : null,
  ].filter(Boolean) as string[];
  for (const line of identity) {
    rows.push(`<div class="ctxrow">${esc(line.replace(/\*\*/g, ""))}</div>`);
  }
  if (identity.length) rows.push(`<div class="sep"></div>`);
  rows.push(`<div class="row big"><span>${esc(m.panelCostLabel)}</span><b>≈ ${fmtTokens(eff)} ${esc(m.tok)}</b></div>`);
  rows.push(`<div class="row"><span>${esc(m.panelNoCacheLabel)}</span><b>≈ ${fmtTokens(noCache)} ${esc(m.tok)}</b></div>`);
  rows.push(`<div class="row save"><span>${esc(m.panelSavedLabel)}</span><b>≈ ${fmtTokens(saved)} ${esc(m.tok)} <span class="mult">${esc(m.lowerMult(mult))}</span></b></div>`);
  rows.push(`<div class="sub">${esc(m.panelTokenCostNote)}</div>`);

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
  // hover footnote (title=) so any user can learn what the line means.
  // A label (or a whole sentence) plus its ⓘ footnote. The visible text must
  // read on its own — the footnote adds the full story, never carries it.
  const hintSpan = (label: string, hint: string): string =>
    `<span class="hint" tabindex="0">${esc(label)} ⓘ<span class="tip">${esc(hint)}</span></span>`;

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
    // delegation COST, that reads as "it cost nothing".
    const shareText = sharePct === 0 && subTotal > 0 ? "<1" : String(sharePct);

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
    const listRows = shown
      .map((a) => {
        const depth = a.spawnDepth && a.spawnDepth > 1 ? m.subagentDepth(a.spawnDepth) : null;
        const who = [a.agentType || "agent", a.modelLabel || "?", a.effort || null, depth]
          .filter(Boolean)
          .join(" · ");
        const what = a.description ? ` — ${a.description}` : "";
        return `<div class="arow"><b>≈ ${fmtTokens(a.effective)}</b><span>${esc(who)}${esc(what)}</span></div>`;
      })
      .join("");
    const more = subagents.length > LIST_CAP ? `<div class="sub">${esc(m.subagentsMore(subagents.length - LIST_CAP))}</div>` : "";

    // What waiting cost. One muted line in the same style as the summary above
    // it, carrying three facts: how much, why, and how long an agent's cache
    // lives. It belongs HERE and not in the Cache section: the reader is
    // already thinking about agents, so it costs one line and no new section.
    // WEIGHTED tokens, like every figure in this section.
    const reb = rebuildDisplay(rebuild?.subagents, eff, weights);
    const rebuildRow = reb.show
      ? `<div class="sub">${hintSpan(m.panelSubagentsRebuild(fmtTokens(reb.cost)), m.panelSubagentsRebuildHint)}</div>`
      : "";
    // The guidance sentence leads the closing note rather than starting a
    // paragraph of its own — no new block of text for one sentence.
    const note = reb.advise ? `${m.panelSubagentsRebuildNote} ${m.panelSubagentsNote}` : m.panelSubagentsNote;

    subagentSection =
      `<h3>${esc(m.panelSubagentsHeader)}</h3>` +
      `<div class="sub">${esc(m.panelSubagentsSummary(subagents.length, fmtTokens(subTotal), shareText))}</div>` +
      rebuildRow +
      gRows +
      listRows +
      more +
      `<div class="sub">${esc(note)}</div>`;
  }

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
  .arow { display:flex; gap:10px; align-items:baseline; padding:2px 0; font-size:12px; }
  .arow b { min-width:64px; text-align:right; font-variant-numeric: tabular-nums; }
  .arow span { opacity:.75; overflow-wrap:anywhere; }
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
  ${subagentSection}
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
  const identityLines = [modelLine(details.model, m), effortLine(details.model, m)].filter(Boolean) as string[];
  for (const line of identityLines) {
    usageRows.push(`<div class="ctxrow">${esc(line.replace(/\*\*/g, ""))}</div>`);
  }
  if (identityLines.length) usageRows.push(`<div class="sep"></div>`);
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
