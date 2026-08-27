// The panel's DATA layer: the shapes the UI is handed, and every decision that
// can be made without knowing a single word of the interface. Nothing here
// imports `i18n` or writes markup — that is `render.ts`'s job, and the import
// list is what keeps the two apart. A function that needs `Messages` to decide
// (rather than to phrase) has logic in the wrong file.
//
// The split is the one `docs/codex-development-roadmap.md` asked for from the
// start: `metrics.ts` = arithmetic over raw counters, `panelModel.ts` = what
// those numbers MEAN for a panel row, `render.ts` = the words and the HTML.

import {
  Totals,
  Weights,
  QuotaWindow,
  ScopedQuotaWindow,
  IdleRebuild,
  CostDirection,
  BoundDirection,
  CACHE_WRITE_WEIGHT_1H,
  CACHE_WRITE_WEIGHT_5M,
  costDirection,
  writeBound,
  invertBound,
  rebuildCost,
  fmtTokens,
} from "./metrics";

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

/** What waiting cost, as the UI receives it: the lead's own idle gaps and the
 *  sum over the subagent streams. */
export interface RebuildView {
  lead?: IdleRebuild;
  subagents?: IdleRebuild;
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

/** Below this, a difference is not a difference: token counters are integers,
 *  and the weights that turn them into a token-equivalent are decimals whose
 *  cancellation lands near, not on, zero. */
export const ZERO_TOLERANCE = 1e-6;

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
  //
  // …and the mirror at the top end, which was missing: a real remainder must not
  // print as "100%" either, because that reads as "this agent did nothing but
  // reload". 99.6% of a spend that also did real work is ">99%", not all of it.
  const remainder = a.effective - cost;
  return {
    known: true,
    cost,
    pctText: pct === 0 ? "<1" : pct === 100 && remainder > ZERO_TOLERANCE ? ">99" : String(pct),
    atLeast: unjudged,
  };
}

/** Which sentence the footnote under the token-equivalent has to be. Named by
 *  MEANING, never by wording: the Claude panel and the Codex panel pick from the
 *  same set of causes and phrase two of them differently, and a shared key is
 *  what stops the two chains drifting apart again. */
export type CostCauseKind = "noCache" | "even" | "tooSmall" | "both" | "warmup" | "weight";

/** The Codex set: it can say that nothing was READ, and it can never reach the
 *  "no cache at all" state, because a payload with neither bucket lands in the
 *  read sentence first. Spelled out so the panel's mapping has no unreachable
 *  case to phrase. */
export type CodexCostCauseKind = Exclude<CostCauseKind, "noCache"> | "noCacheRead";

/** Why the with-cache figure is NOT the smaller one. Each side is priced
 *  against reading the same input fresh, so its contribution is what it adds
 *  over that: reads add `cacheRead × (weight − 1)`, writes add the tiered price
 *  minus the tokens themselves. The bigger positive contribution is the cause —
 *  unless BOTH are positive, which is a state of its own rather than a contest
 *  between them; zero contribution on both sides means the cache is simply not
 *  moving this number, which is a different sentence again. Pure.
 *
 *  `canReverse` rides along because the two hints that hedge ("so far", "yet")
 *  hedge on exactly this, and a caller that had to compute it separately is a
 *  caller that can compute it differently. */
export function costCause(
  totals: Totals,
  weights: Weights,
  /** True when the difference is invisible EVERYWHERE the page states it: both
   *  figures print as the same text AND the multiplier rounds to 1×. Naming one
   *  figure the larger then contradicts a page that shows no difference — and
   *  the reader believes their eyes, not the footnote. Both halves are needed:
   *  two figures printing "1.2M" can still carry a visible "~1.1× less", and
   *  a ratio rounding to 1× can still sit above a visible 1.3k vs 1.2k. */
  invisible = false
): { kind: CostCauseKind; canReverse: boolean } {
  const canReverse = cacheCanReverse(weights, [
    CACHE_WRITE_WEIGHT_1H,
    CACHE_WRITE_WEIGHT_5M,
    weights.cacheWrite,
  ]);
  if (totals.cacheRead === 0 && totals.cacheWrite === 0) return { kind: "noCache", canReverse };
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
  if (readDelta + writeDelta <= ZERO_TOLERANCE) return { kind: "even", canReverse };
  // A net ABOVE zero that the page cannot show anywhere comes next, ahead of
  // every cause: "it is not moving this figure" would deny arithmetic that is
  // real (rounding can hide tens of thousands of tokens at 1M scale), while
  // naming ANY cause explains a difference the reader cannot find on the page.
  // So it says exactly that — there is one, and it is smaller than what is
  // printed. Ordering matters: a cause named over an invisible difference is
  // the same defect whether the cause is one side or both.
  // Two of these five carry a hedge of their own — "so far", "yet" — and they
  // hang on exactly what the visible compare line hangs on. A footnote is a
  // statement too, and round 18 fixed the same promise one line up.
  if (invisible) return { kind: "tooSmall", canReverse };
  // Both sides adding is its OWN state, not a contest between them: "the write
  // premium is bigger than what the reads save" is false when the reads save
  // nothing, and it stays false whichever side happens to be larger.
  if (readDelta > 0 && writeDelta > 0) return { kind: "both", canReverse };
  return { kind: writeDelta >= readDelta ? "warmup" : "weight", canReverse };
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

/** Context % when both numbers are known, else null (fail-visibly). */
export function contextPct(ctx?: ContextView): number | null {
  if (!ctx || ctx.usedTokens == null || ctx.limitTokens == null || ctx.limitTokens <= 0) return null;
  return Math.round((ctx.usedTokens / ctx.limitTokens) * 100);
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
export function codexEconomy(
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
  /** False when an UNSTATED write count leaves the comparison unsettled. With
   *  no count, the true figure lies somewhere between "none of the remaining
   *  input was written" and "all of it was"; where the without-cache figure
   *  falls strictly inside that interval, whether the cache saved or cost is
   *  not knowable, and no direction, multiplier or saving may be published. */
  directionCertain: boolean;
  /** The two ends of that interval, named by MEANING rather than by size:
   *  `effectiveNone` is what the figure is if nothing outside the cached reads
   *  was written, `effectiveAll` if all of it was. Which of the two is the
   *  larger flips with the write weight, so a min/max pair cannot be handed to a
   *  sentence that says "if none … if all". Equal when the count IS stated. */
  effectiveNone: number;
  effectiveAll: number;
  /** The bound on the SAVING, which is the opposite of the token-equivalent's:
   *  `saved = noCache − effective` and `noCache` is exact, so a figure that can
   *  only be higher leaves a saving that can only be smaller. "exact" whenever
   *  the interval cannot change what the saving prints. */
  savedBound: BoundDirection;
  /** The bound on the token-equivalent ITSELF — `writeBound` where an unstated
   *  count would change what the figure prints, "exact" where it would not. The
   *  headline and the hover carry its sign, not just the ⓘ: a figure printed
   *  bare is read as a measurement, and this page marks its bounds everywhere
   *  else it has one. */
  effectiveBound: BoundDirection;
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
  // leaves the figure below bounded rather than measured. A NEGATIVE count is
  // not a third fact — it is not a count, so it joins "stated nothing"; folding
  // it to 0 instead would put a corrupt field in the one bucket that silences
  // the ⓘ. Same rule as `clampWrite` at the parse boundary; repeated here
  // because this function is exported and callable without it.
  const statedRaw = details.usage.cacheWriteInputTokens;
  const writeStated = statedRaw == null || statedRaw < 0 ? null : statedRaw;
  const writeInput = Math.min(writeStated ?? 0, afterCached);
  const freshInput = afterCached - writeInput;
  // Codex total_tokens = input_tokens + output_tokens; reasoning is a detail of output.
  const output = Math.max(0, details.usage.outputTokens);
  const work = freshInput + output;
  const effective = work + cachedInput * cacheReadWeight + writeInput * cacheWriteWeight;
  const noCache = details.usage.inputTokens + output;
  const saved = Math.max(0, noCache - effective);
  // How far the figure could move if the unstated count turns out to be real.
  // Only the write bucket is unknown, and it can hold anything from nothing to
  // the whole of what the reads left: `effective(w) = base + w × (weight − 1)`,
  // monotonic in `w`, so the two ends of the interval ARE the two extremes.
  // With a stated count there is no interval and both ends are the figure.
  // `effective` IS the "none of it was written" end whenever the count is
  // unstated, because `writeInput` falls back to 0 there.
  const effectiveNone = effective;
  const effectiveAll =
    writeStated == null ? effective + afterCached * (cacheWriteWeight - 1) : effective;
  const here = costDirection(effective, noCache);
  const canMove = writeStated == null && afterCached > 0;
  const atOtherEnd = canMove ? costDirection(effectiveAll, noCache) : here;
  const effectiveStable = !canMove || fmtTokens(effectiveAll) === fmtTokens(effectiveNone);
  // The direction is announced as unknown only where the without-cache figure
  // falls STRICTLY between the two ends — one end saying the cache saved and the
  // other saying it cost. A figure sitting exactly ON an end is not that case:
  // there the page prints two equal numbers and the ⓘ marks the bound, which is
  // the whole truth about what is visible.
  //
  // …and never where the two ends print the SAME text, because then the page
  // shows one number, and announcing an unknowable ordering between two figures
  // the reader sees as identical explains a difference that is not on the page.
  // That is the rule rounds 10 and 12 settled for the cause chain, whose own
  // invisible-difference branch takes it from here.
  const lo = Math.min(effectiveNone, effectiveAll);
  const hi = Math.max(effectiveNone, effectiveAll);
  const directionCertain =
    !(noCache > lo + ZERO_TOLERANCE && noCache < hi - ZERO_TOLERANCE) || effectiveStable;
  // A derived figure is publishable while the unstated count cannot change what
  // it PRINTS — the same test the panel already applies to two token figures
  // that round to the same text. Where the ends print differently, the saving
  // carries the bound it actually has (the opposite of the token-equivalent's,
  // because `noCache` is exact) and the multiplier is dropped: a ratio has no
  // room for a marker, and an unmarked one is the overstatement itself.
  const multStable = !canMove || (atOtherEnd.dir === here.dir && atOtherEnd.mult === here.mult);
  const savedStable =
    !canMove || fmtTokens(Math.max(0, noCache - effectiveAll)) === fmtTokens(saved);
  return {
    effective,
    noCache,
    saved,
    directionCertain,
    effectiveNone,
    effectiveAll,
    savedBound: savedStable ? ("exact" as BoundDirection) : invertBound(writeBound(cacheWriteWeight)),
    effectiveBound: effectiveStable ? ("exact" as BoundDirection) : writeBound(cacheWriteWeight),
    ...here,
    mult: multStable ? here.mult : null,
    work,
    cachedInput,
    ordinaryInput: freshInput,
    writeInput,
    writeStated,
  };
}

/** The Codex economy, once it exists — the argument shape of every decision
 *  below, spelled out so they cannot be handed a half-built object. */
export type CodexEconomy = NonNullable<ReturnType<typeof codexEconomy>>;

/** Can a later turn still narrow or close the gap between the two figures?
 *  Only a bucket priced BELOW a fresh token can: the gap is
 *  `Σ bucket × (weight − 1)`, so every weight at or above 1 can only widen it.
 *  This is what the "so far" in `panelCostCompare` promises, and promising it
 *  where no weight is below 1 states a turn the arithmetic forbids. */
export function cacheCanReverse(weights: Weights, writeWeights: number[]): boolean {
  return weights.cacheRead < 1 || writeWeights.some((w) => w < 1);
}

/** The Codex twin. Codex states no cache tier, so a write here can only ever be
 *  priced at the unknown-lifetime setting — one weight, not three. */
export function codexCanReverse(details: CodexQuotaDetails): boolean {
  const cacheRead = details.weights?.cacheRead ?? 0.1;
  const cacheWrite = details.weights?.cacheWrite ?? 1.25;
  return cacheCanReverse({ cacheRead, cacheWrite }, [cacheWrite]);
}

/** Codex's stated cache-write count, or null when it stated none. Never
 *  rewritten into a zero: "the payload said 0" and "the payload said nothing"
 *  are different answers, and the panel prints different text for each — and a
 *  negative is neither a count nor a zero, so it reads as "said nothing". */
export function codexCacheWrite(details: CodexQuotaDetails): number | null {
  const n = details.usage?.cacheWriteInputTokens;
  return n == null || n < 0 ? null : n;
}

/** The Codex cause chain. Same ordering as `costCause`, invisible-difference
 *  branch included, with one extra state at the head: Codex can say that
 *  nothing was READ, which Claude's chain has no equivalent for.
 *  `panelCostEvenHint` is NOT a substitute for "tooSmall": that one fires on an
 *  exact arithmetic zero, while this guards a REAL premium the display rounds
 *  away. Pricing the write is what made that state reachable here for the first
 *  time — 1.2M input with a 40k write leaves a 10k premium that both figures
 *  print as `1.2M`, and naming a cause over a difference the page does not show
 *  is the defect rounds 10 and 12 closed on the Claude panel. */
export function codexCostCause(
  economy: CodexEconomy,
  details: CodexQuotaDetails
): { kind: CodexCostCauseKind; canReverse: boolean } {
  const readW = details.weights?.cacheRead ?? 0.1;
  const writeW = details.weights?.cacheWrite ?? 1.25;
  const readDelta = economy.cachedInput * (readW - 1);
  const writeDelta = economy.writeInput * (writeW - 1);
  const canReverse = codexCanReverse(details);
  // Codex's own sentence, not Claude's: it states that nothing was READ, and
  // says so only when nothing was written either — with a write priced in, the
  // two figures are no longer the same number and the sentence would contradict
  // the line under it.
  if (economy.cachedInput <= 0 && economy.writeInput <= 0) return { kind: "noCacheRead", canReverse };
  if (readDelta + writeDelta <= ZERO_TOLERANCE) return { kind: "even", canReverse };
  if (fmtTokens(economy.effective) === fmtTokens(economy.noCache) && economy.dir === "same")
    return { kind: "tooSmall", canReverse };
  if (readDelta > 0 && writeDelta > 0) return { kind: "both", canReverse };
  return { kind: writeDelta >= readDelta ? "warmup" : "weight", canReverse };
}
