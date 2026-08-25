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
  CacheTier,
  CostDirection,
  CACHE_WRITE_WEIGHT_1H,
  CACHE_WRITE_WEIGHT_5M,
  effectiveTokens,
  costDirection,
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
  // to "(limit n/a)" for diagnosability. A raw transport detail stays in English
  // on purpose: it is a machine string a user reports verbatim.
  limitDetail?: string;
  // …but a NORMAL state is not a transport detail. Codex simply does not carry a
  // context window for some models, and that sentence is UI text: it is named by
  // key here and localised at render time, or a Russian panel would print an
  // English clause. */
  limitDetailKey?: "codexNoWindow";
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
  /** What THIS agent's own idle gaps cost, so the list can say which agent paid
   *  for waiting instead of only naming a total for all of them. Carries its own
   *  `unjudged` count, which is what decides whether a zero may be shown. */
  rebuild?: IdleRebuild;
}

/** What waiting cost ONE agent, ready for its row: the token-equivalent and the
 *  share of that agent's own spend it ate. Self-normalising on purpose — a short
 *  agent that never waited reads 0%, which is the truth, whereas a cache-hit
 *  rate would score it low for having nothing to reuse yet.
 *
 *  What decides whether a figure may be shown is `rebuild.unjudged`, NOT whether
 *  a cache lifetime was read: a lifetime is needed to judge a GAP, and a stream
 *  with no gaps has nothing to judge (a one-turn agent is a truthful 0%). When
 *  gaps went unjudged, a zero is not "it never waited" but "we cannot tell", and
 *  a non-zero figure is a lower bound — `atLeast` says so. Pure. */
export function agentIdle(
  a: SubagentView,
  weights: Weights
): { known: boolean; cost: number; pctText: string | null; atLeast: boolean } {
  // An agent that spent nothing has no share to state: 0/0 is not a zero, it is
  // the absence of a measurement (an empty log, a log of placeholders, a read
  // that failed). Checked FIRST, or the zero below would answer for it.
  if (!a.rebuild || a.effective <= 0) return { known: false, cost: 0, pctText: null, atLeast: false };
  const cost = rebuildCost(a.rebuild, weights);
  const unjudged = a.rebuild.unjudged > 0;
  if (cost <= 0) {
    return unjudged
      ? { known: false, cost: 0, pctText: null, atLeast: false }
      : { known: true, cost: 0, pctText: "0", atLeast: false };
  }
  // A floor is FLOORED, never rounded: "≥ 2%" on a measured 1.6% claims more
  // than was measured, which is the one thing the marker exists to prevent.
  const pct = unjudged ? Math.floor((cost / a.effective) * 100) : Math.round((cost / a.effective) * 100);
  // "<1" is an UPPER bound on what was measured, so it cannot also carry a floor
  // from what was not: with unjudged gaps under 1%, the tokens are stated as a
  // floor and the share is left out rather than stated two ways at once.
  if (unjudged && pct === 0) return { known: true, cost, pctText: null, atLeast: true };
  // A real loss must never print as "0%" — in a cell about what waiting cost,
  // that reads as "it cost nothing". Same rule as the section's own share.
  return { known: true, cost, pctText: pct === 0 ? "<1" : String(pct), atLeast: unjudged };
}

/** Below this, a difference is not a difference: token counters are integers,
 *  and the weights that turn them into a token-equivalent are decimals whose
 *  cancellation lands near, not on, zero. */
const ZERO_TOLERANCE = 1e-6;

/** Why the with-cache figure is NOT the smaller one. Each side is priced
 *  against reading the same input fresh, so its contribution is what it adds
 *  over that: reads add `cacheRead × (weight − 1)`, writes add the tiered price
 *  minus the tokens themselves. The bigger positive contribution is the cause —
 *  unless BOTH are positive, which is a state of its own rather than a contest
 *  between them; zero contribution on both sides means the cache is simply not
 *  moving this number, which is a different sentence again. Pure. */
export function costCauseHint(
  totals: Totals,
  weights: Weights,
  m: Messages,
  /** True when the difference is invisible EVERYWHERE the page states it: both
   *  figures print as the same text AND the multiplier rounds to 1×. Naming one
   *  figure the larger then contradicts a page that shows no difference — and
   *  the reader believes their eyes, not the footnote. Both halves are needed:
   *  two figures printing "1.2M" can still carry a visible "~1.1× less", and
   *  a ratio rounding to 1× can still sit above a visible 1.3k vs 1.2k. */
  invisible = false
): string {
  if (totals.cacheRead === 0 && totals.cacheWrite === 0) return m.panelCostNoCacheHint;
  const readDelta = totals.cacheRead * (weights.cacheRead - 1);
  const writeDelta =
    CACHE_WRITE_WEIGHT_1H * totals.cacheWrite1h +
    CACHE_WRITE_WEIGHT_5M * totals.cacheWrite5m +
    weights.cacheWrite * totals.cacheWriteUnknown -
    totals.cacheWrite;
  // The NET is what the footnote explains. Two components that cancel out leave
  // a cache that has earned back exactly what it cost — calling that a warm-up
  // because one half of the arithmetic is positive explains a number nobody is
  // looking at. (A net below zero can only arrive here through display
  // rounding — a saving too small to change either figure — and "it does not
  // move this figure" is exactly the truth in that case.)
  //
  // ZERO_TOLERANCE, not 0: the weights are decimals, so an arithmetic zero
  // (−10k from reads at 0.9, +10k from writes at 1.1) evaluates to 1.5e-11 in
  // floating point. A millionth of a token is not a premium — no counter can
  // express one — and without this the page would report a cache that "cost
  // slightly more" when it cost exactly the same.
  if (readDelta + writeDelta <= ZERO_TOLERANCE) return m.panelCostEvenHint;
  // A net ABOVE zero that the page cannot show anywhere comes next, ahead of
  // every cause: "it is not moving this figure" would deny arithmetic that is
  // real (rounding can hide tens of thousands of tokens at 1M scale), while
  // naming ANY cause explains a difference the reader cannot find on the page.
  // So it says exactly that — there is one, and it is smaller than what is
  // printed. Ordering matters: a cause named over an invisible difference is
  // the same defect whether the cause is one side or both.
  if (invisible) return m.panelCostTooSmallHint;
  // Both sides adding is its OWN state, not a contest between them: "the write
  // premium is bigger than what the reads save" is false when the reads save
  // nothing, and it stays false whichever side happens to be larger.
  if (readDelta > 0 && writeDelta > 0) return m.panelCostBothHint;
  return writeDelta >= readDelta ? m.panelCostWarmupHint : m.panelCostWeightHint;
}

/** The one command a panel link may run: it flips the agent list open/closed.
 *  Exported so the registration, the package.json contribution and the link
 *  cannot drift apart (a test pins all three). */
export const DELEGATED_TOGGLE_COMMAND = "ccStatusbar.toggleDelegated";

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
    /** Codex's own cache-write counter, `null` when the payload did not state
     *  one. Reported as 0 in every turn measured on this machine. */
    cacheWriteInputTokens?: number | null;
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

/** Codex's three input buckets, priced once each.
 *
 *  OpenAI documents `input_tokens_details` as a BREAKDOWN of `input_tokens`,
 *  with `cached_tokens` and `cache_write_tokens` as disjoint parts of it:
 *  "ordinaryInputTokens = inputTokens - cachedTokens - cacheWriteTokens"
 *  (developers.openai.com/api/docs/guides/prompt-caching, which also states
 *  0.1× for reads and 1.25× for writes on GPT-5.6+). Codex maps the field
 *  straight through from there. So a write is neither an extra beside the input
 *  count nor an ordinary fresh token: pricing it at 1× inside `freshInput`
 *  understated the figure, and adding it on top would count it twice.
 *
 *  `writeInput` is clamped to what is left after the reads so the three parts
 *  can never sum past `input_tokens`. Some payloads have been reported where
 *  the two counts overlap; whatever the cause, a breakdown bigger than the
 *  whole must not turn into a negative bucket. */
function codexEconomy(
  details: CodexQuotaDetails
): {
  effective: number;
  noCache: number;
  saved: number;
  mult: string | null;
  dir: CostDirection;
  work: number;
  cachedInput: number;
  /** Input priced at 1×: what is left after the cached reads and the writes. */
  ordinaryInput: number;
  writeInput: number;
  /** What the payload SAID, or null when it said nothing. Kept apart from
   *  `writeInput` (what could be priced) because the ⓘ must not claim to have
   *  priced a number the clamp cut down, and must not print a claim at all when
   *  the provider stated none. */
  writeStated: number | null;
} | null {
  if (!details.usage) return null;
  const cacheReadWeight = details.weights?.cacheRead ?? 0.1;
  // No cache TIER is ever stated by Codex, so a write can only be priced at the
  // setting for writes of unknown lifetime — the same rule the Claude path uses
  // for a write whose tier its transcript did not state.
  const cacheWriteWeight = details.weights?.cacheWrite ?? 1.25;
  const cachedInput = Math.max(0, details.usage.cachedInputTokens);
  const afterCached = Math.max(0, details.usage.inputTokens - cachedInput);
  // `null` stays null all the way to the ⓘ: "the payload stated nothing" and
  // "the payload stated zero" are different facts, and only the first of them
  // makes the figure below a floor rather than a measurement.
  const writeStated = details.usage.cacheWriteInputTokens == null
    ? null
    : Math.max(0, details.usage.cacheWriteInputTokens);
  const writeInput = Math.min(writeStated ?? 0, afterCached);
  const freshInput = afterCached - writeInput;
  // Codex total_tokens = input_tokens + output_tokens; reasoning is a detail of output.
  const output = Math.max(0, details.usage.outputTokens);
  const work = freshInput + output;
  const effective = work + cachedInput * cacheReadWeight + writeInput * cacheWriteWeight;
  const noCache = details.usage.inputTokens + output;
  const saved = Math.max(0, noCache - effective);
  return {
    effective,
    noCache,
    saved,
    ...costDirection(effective, noCache),
    work,
    cachedInput,
    ordinaryInput: freshInput,
    writeInput,
    writeStated,
  };
}

/** Can a later turn still narrow or close the gap between the two figures?
 *  Only a bucket priced BELOW a fresh token can: the gap is
 *  `Σ bucket × (weight − 1)`, so every weight at or above 1 can only widen it.
 *  This is what the "so far" in `panelCostCompare` promises, and promising it
 *  where no weight is below 1 states a turn the arithmetic forbids. */
function cacheCanReverse(weights: Weights, writeWeights: number[]): boolean {
  return weights.cacheRead < 1 || writeWeights.some((w) => w < 1);
}

/** The Codex twin. Codex states no cache tier, so a write here can only ever be
 *  priced at the unknown-lifetime setting — one weight, not three. */
function codexCanReverse(details: CodexQuotaDetails): boolean {
  const cacheRead = details.weights?.cacheRead ?? 0.1;
  const cacheWrite = details.weights?.cacheWrite ?? 1.25;
  return cacheCanReverse({ cacheRead, cacheWrite }, [cacheWrite]);
}

function codexUsageCompact(details: CodexQuotaDetails, m: Messages): string {
  const economy = codexEconomy(details);
  if (!economy) return m.codexUsageWaitingCompact;
  return m.codexCostCompact(
    fmtTokens(economy.effective),
    fmtTokens(economy.noCache),
    economy.mult,
    economy.dir,
    codexCanReverse(details)
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

/** Codex's stated cache-write count, or null when it stated none. Never
 *  rewritten into a zero: "the payload said 0" and "the payload said nothing"
 *  are different answers, and the panel prints different text for each. */
function codexCacheWrite(details: CodexQuotaDetails): number | null {
  const n = details.usage?.cacheWriteInputTokens;
  return n == null ? null : Math.max(0, n);
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
  t.push(m.costCompact(fmtTokens(eff), fmtTokens(noCache), mult, costDir));
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

/** Styling for `hintSpan`, identical in both panels. */
const HINT_CSS = `
  .hint { position:relative; opacity:.9; border-bottom:1px dotted currentColor; cursor:help; outline:none; }
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
    // The idle cell is offered only when at least one row can actually carry a
    // number: a column of "—" teaches nothing and costs every row its width.
    const idles = shown.map((a) => agentIdle(a, weights));
    const anyIdle = idles.some((i) => i.known);
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
          : `<span class="idle">${esc(
              idle.known
                ? m.panelAgentIdle(
                    idle.pctText,
                    idle.cost > 0 ? fmtTokens(idle.cost, idle.atLeast) : null,
                    idle.atLeast
                  )
                : m.panelAgentIdleUnknown
            )}</span>`;
        return `<div class="arow"><b>≈ ${fmtTokens(a.effective)}</b><span>${esc(who)}${esc(what)}</span>${idleCell}</div>`;
      })
      .join("");
    const more = subagents.length > LIST_CAP ? `<div class="sub">${esc(m.subagentsMore(subagents.length - LIST_CAP))}</div>` : "";
    // The ≥ is explained only where one is actually shown — an explanation of a
    // marker nobody can see is just more text to read.
    const idleLegend = anyIdle
      ? `<div class="sub">${esc(
          idles.some((i) => i.atLeast) ? `${m.panelAgentIdleLegend} ${m.panelAtLeastNote}` : m.panelAgentIdleLegend
        )}</div>`
      : "";

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
    const rebShareText = rebShare === 0 && reb.cost > 0 ? "<1" : String(rebShare);
    // The marker follows the MEASUREMENT, not the printed percentage. A share
    // that floors to "<1" is still a floor, and the token figure beside it is
    // one too — dropping the ≥ there would present a bound as a measurement.
    // "≥ <1%" reads as nonsense, so the share alone loses the marker while the
    // tokens keep it, the same split the per-agent rows already make.
    const rebAtLeast = rebUnjudged && reb.cost > 0;
    const rebShareAtLeast = rebAtLeast && rebShare > 0;
    const rebuildRow = reb.show
      ? `<div class="sub">${hintSpan(
          m.panelSubagentsRebuild(
            `${rebAtLeast ? "≥" : "≈"} ${fmtTokens(reb.cost, rebAtLeast)}`,
            `${rebShareAtLeast ? "≥" : ""}${rebShareText}%`
          ),
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
        ? listRows + more + idleLegend + `<div class="sub">${esc(m.panelSubagentsNote)}</div>`
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
      ? `${m.panelSavedLabel}: ≈ ${fmtTokens(saved)} ${m.tok}` +
        // no multiplier when the line above has just called the two the same
        `${mult && costDir === "more" ? ` ${m.lowerMult(mult)}` : ""}. ${m.panelTokenCostNote}`
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
  .arow .idle { margin-left:auto; white-space:nowrap; opacity:.7; font-variant-numeric: tabular-nums; }
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
  .muted { opacity:.65; font-size:12px; }${HINT_CSS}${FOOT_CSS}
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
    const writeNote =
      economy.writeStated == null
        ? // Only worth saying where it could have changed the figure: with no
          // ordinary input left, an unstated write count could not have moved it.
          economy.ordinaryInput > 0
          ? ` ${m.codexPanelWriteUnstatedHint}`
          : ""
        : economy.writeStated > economy.writeInput
        ? ` ${m.codexPanelWriteClampedHint(fmtTokens(economy.writeStated), fmtTokens(economy.writeInput))}`
        : economy.writeInput > 0
        ? ` ${m.codexPanelWritePricedHint(fmtTokens(economy.writeInput))}`
        : "";
    // Same ordering as `costCauseHint`, invisible-difference branch included.
    // `panelCostEvenHint` is NOT a substitute for it: that one fires on an exact
    // arithmetic zero, while this guards a REAL premium the display rounds away.
    // Pricing the write is what made that state reachable here for the first
    // time — 1.2M input with a 40k write leaves a 10k premium that both figures
    // print as `1.2M`, and naming a cause over a difference the page does not
    // show is the defect rounds 10 and 12 closed on the Claude panel.
    const readW = details.weights?.cacheRead ?? 0.1;
    const writeW = details.weights?.cacheWrite ?? 1.25;
    const readDelta = economy.cachedInput * (readW - 1);
    const writeDelta = economy.writeInput * (writeW - 1);
    const costHint =
      economy.noCache > economy.effective
        ? `${m.codexPanelSavedLabel}: ≈ ${fmtTokens(economy.saved)} ${m.tok}` +
          `${economy.mult && economy.dir === "more" ? ` ${m.codexLowerMult(economy.mult)}` : ""}.${writeNote} ` +
          m.codexPanelTokenCostNote
        : `${
            // Codex's own sentence, not Claude's: it states that nothing was
            // READ, and says so only when nothing was written either — with a
            // write priced in, the two figures are no longer the same number
            // and the sentence would contradict the line under it.
            economy.cachedInput <= 0 && economy.writeInput <= 0
              ? m.codexPanelNoCacheReadHint
              : readDelta + writeDelta <= ZERO_TOLERANCE
              ? m.panelCostEvenHint
              : fmtTokens(economy.effective) === fmtTokens(economy.noCache) && economy.dir === "same"
              ? m.panelCostTooSmallHint
              : readDelta > 0 && writeDelta > 0
              ? m.codexPanelBothHint
              : writeDelta >= readDelta
              ? m.codexPanelWarmupHint
              : m.panelCostWeightHint
          }${writeNote} ${m.codexPanelTokenCostNote}`;
    costRows.push(
      `<div class="row">${hintSpan(m.codexPanelCostLabel, costHint)}` +
        `<b>≈ ${fmtTokens(economy.effective)} ${esc(m.tok)}</b></div>`
    );
    // Same visible comparison as the Claude panel — switching provider must not
    // move a number the reader has learned to look for.
    costRows.push(
      // See the note on `panelCostCompare`: the hedge is dropped where no weight
      // is below 1, because then no later turn can narrow the gap.
      `<div class="sub">${esc(
        m.panelCostCompare(fmtTokens(economy.noCache), economy.mult, economy.dir, codexCanReverse(details))
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
