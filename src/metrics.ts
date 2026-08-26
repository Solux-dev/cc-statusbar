// Pure, dependency-free logic — unit-tested without the VS Code API.
// The `effective` formula MUST stay in sync with the project's
// tools/session-cost.py (CACHE_READ_WEIGHT / CACHE_WRITE_WEIGHT) and
// docs/cost-metrics.md.

export interface Totals {
  input: number;
  output: number;
  work: number; // input + output
  cacheRead: number;
  cacheWrite: number; // total, = cacheWrite1h + cacheWrite5m + cacheWriteUnknown
  /** Cache writes the transcript attributes to the 1-hour tier (weighted ×2.0). */
  cacheWrite1h: number;
  /** Cache writes attributed to the 5-minute tier (weighted ×1.25). */
  cacheWrite5m: number;
  /** Writes whose tier the transcript does not state — weighted with the
   *  `cacheWriteWeight` SETTING, so an unknown tier never silently changes
   *  meaning for anyone who tuned that number. */
  cacheWriteUnknown: number;
}

export interface Weights {
  cacheRead: number; // default 0.1
  /** Weight for a cache write of UNKNOWN tier only. Tiered writes use the
   *  constants below — a 1-hour write really does cost 2× a fresh input token
   *  and a 5-minute write 1.25×, so one blended number understated any session
   *  that ran on the 1-hour tier (measured: ~10% of the lead's own spend). */
  cacheWrite: number; // default 1.25
}

/** Anthropic prompt-cache write prices, relative to a fresh input token.
 *  Not settings: they are the published tariff, not a preference. */
export const CACHE_WRITE_WEIGHT_1H = 2.0;
export const CACHE_WRITE_WEIGHT_5M = 1.25;

/** How long a cache entry survives idle, per tier, in seconds. */
export const CACHE_TTL_SECONDS: Record<"1h" | "5m", number> = { "1h": 3600, "5m": 300 };

export interface QuotaWindow {
  pct: number; // 0..100
  resetAt: number | null; // unix seconds
  status?: string; // "allowed" | "denied"
}

/** A weekly window scoped to ONE model (today: Fable, which is capped at a share
 *  of the plan's weekly allowance and therefore runs out at its own pace). The
 *  label is the SERVER's own display name — we never hardcode a model list, so
 *  a future scoped bucket appears by itself. */
export interface ScopedQuotaWindow extends QuotaWindow {
  label: string; // e.g. "Fable"
}

export type PaceLevel = "normal" | "tight" | "over";

/** Current fill of the model's context window — read from the MAIN transcript's
 *  last assistant turn. `tokens` is the real input the model received
 *  (input + cache_read + cache_creation); `modelId` drives the window-limit
 *  lookup. Both null when no assistant turn with usage is present yet. */
export interface ContextInfo {
  tokens: number | null;
  modelId: string | null;
  /** Reasoning-effort level of that same turn ("low"|"medium"|"high"|"xhigh").
   *  Null on older transcripts that predate the field. */
  effort: string | null;
  /** Id of that turn (response id / requestId). Identifies "the same turn"
   *  across ticks, which is what lets a change notice persist until the NEXT
   *  turn instead of expiring on a wall clock while the user is away. */
  turnId: string | null;
}

export function emptyTotals(): Totals {
  return {
    input: 0,
    output: 0,
    work: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    cacheWriteUnknown: 0,
  };
}

/** Cache-write tokens for one usage block, robust across Claude Code versions.
 *  Prefer the top-level `cache_creation_input_tokens`, but fall back to the
 *  nested per-TTL breakdown: on Claude Code < v2.1.152 the top-level field could
 *  report 0 while only `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`
 *  carried the real value (fixed in the v2.1.152 changelog, 2026-05-27).
 *  Current transcripts populate the top-level field, so this only matters for
 *  older sessions — verified against real data 2026-05-31. */
/** One token counter out of a transcript, sanitized. A value that is negative,
 *  non-numeric, or not finite is not a smaller count — it is a broken field.
 *  Letting it through would SUBTRACT from the session total, or print `NaN` /
 *  `Infinity` where a number belongs. Every counter we read goes through here. */
export function tokenCount(v: any): number {
  // The upper bound is not paranoia about big sessions — the largest window in
  // existence is 1e6 tokens. It stops a fabricated counter (say 1e308) from
  // summing to Infinity two additions later, where the difference of two
  // infinities becomes NaN and every figure on screen turns to nonsense.
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= Number.MAX_SAFE_INTEGER ? v : 0;
}

export function cacheWriteTokens(u: any): number {
  const top = tokenCount(u?.cache_creation_input_tokens);
  if (top) return top;
  // A broken or absent top-level field falls through to the nested breakdown,
  // which on Claude Code < v2.1.152 is where the real value lived.
  const c = u?.cache_creation;
  if (c) return tokenCount(c.ephemeral_5m_input_tokens) + tokenCount(c.ephemeral_1h_input_tokens);
  return 0;
}

/** Split one usage block's cache write across TTL tiers. The nested
 *  `cache_creation.ephemeral_{1h,5m}_input_tokens` breakdown is the only place
 *  the tier is STATED, so it is authoritative; whatever the top-level total
 *  counts beyond it has no stated tier and stays `unknown`. We never move
 *  tokens into a tiered bucket on a guess — that would inflate the headline. */
export function cacheWriteSplit(u: any): { h1: number; m5: number; unknown: number } {
  const total = cacheWriteTokens(u);
  const c = u?.cache_creation;
  const h1 = c?.ephemeral_1h_input_tokens || 0;
  const m5 = c?.ephemeral_5m_input_tokens || 0;
  const stated = h1 + m5;
  // Any breakdown we cannot trust makes the whole write untiered. That covers
  // an impossible value (negative or non-finite) and the case where the nested
  // fields claim MORE than the top-level total — either way the shape is
  // corrupt, and the conservative reading is "tier unknown". The split must
  // never change what the transcript says was written, only label it.
  const sane = h1 === tokenCount(h1) && m5 === tokenCount(m5);
  if (!sane || stated <= 0 || stated > total) return { h1: 0, m5: 0, unknown: total };
  return { h1, m5, unknown: total - stated };
}

/** The tier one usage block's write landed on, or null when it states none.
 *  A turn that wrote to BOTH tiers is reported by its larger share — the point
 *  is which cache the NEXT turn will be relying on. */
export function tierOfWrite(u: any): CacheTier {
  const s = cacheWriteSplit(u);
  if (s.h1 <= 0 && s.m5 <= 0) return null;
  return s.h1 >= s.m5 ? "1h" : "5m";
}

/** Effective (cache-weighted) tokens — comparable consumption number.
 *  Cache writes are priced per TTL tier: a 1-hour write costs 2× a fresh input
 *  token, a 5-minute write 1.25×. Only writes with NO stated tier fall back to
 *  the `cacheWriteWeight` setting. */
export function effectiveTokens(t: Totals, w: Weights): number {
  return Math.round(
    t.work +
      w.cacheRead * t.cacheRead +
      CACHE_WRITE_WEIGHT_1H * t.cacheWrite1h +
      CACHE_WRITE_WEIGHT_5M * t.cacheWrite5m +
      w.cacheWrite * t.cacheWriteUnknown
  );
}


/** Sum usage from one transcript's lines (raw jsonl text). Mirrors
 *  session-cost.py parse_session: only assistant messages with a usage block.
 *
 *  One API response (one `message.id` / `requestId`) is serialized across
 *  MULTIPLE jsonl lines — one per content block (thinking / text / each
 *  tool_use) — and EACH line repeats the SAME `usage` block verbatim. Summing
 *  per line counts a single response 2–4× and inflates every absolute token
 *  number ~2.3–3.3×. Dedup by response id so each response is counted once.
 *  (Lines with neither id — very old/odd transcripts — fall through and are
 *  counted, as before, to avoid silently dropping data.)
 *
 *  `includeSidechain` picks WHICH file this is:
 *   - false (default) — a MAIN transcript: sidechain turns are skipped, because
 *     a subagent's tokens belong to its own agent-*.jsonl and counting them here
 *     too would double-count them.
 *   - true — an AGENT transcript: EVERY assistant turn in such a file is a
 *     sidechain by definition, so skipping them summed the file to zero and made
 *     all subagent consumption invisible (measured on a real session: 2.3M of
 *     2.75M effective tokens — 84% — silently missing from the total). */
export function sumTranscript(raw: string, includeSidechain = false): Totals {
  const t = emptyTotals();
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let obj: any;
    try {
      obj = JSON.parse(s);
    } catch {
      continue; // tolerate a partial last line mid-write
    }
    if (obj?.type !== "assistant" || !obj.message) continue;
    if (obj.isSidechain && !includeSidechain) continue; // counted via its own agent-*.jsonl
    // A turn is an assistant entry WITH a usage block. Checking this before the
    // dedup matters: a placeholder that shares an id with the real turn would
    // otherwise consume that id and drop the real turn's tokens entirely.
    const u = obj.message.usage;
    if (!u) continue;
    const id = obj.message.id || obj.requestId;
    if (id) {
      if (seen.has(id)) continue; // same response, another content-block line — already counted
      seen.add(id);
    }
    t.input += tokenCount(u.input_tokens);
    t.output += tokenCount(u.output_tokens);
    const split = cacheWriteSplit(u);
    t.cacheWrite += split.h1 + split.m5 + split.unknown;
    t.cacheWrite1h += split.h1;
    t.cacheWrite5m += split.m5;
    t.cacheWriteUnknown += split.unknown;
    t.cacheRead += tokenCount(u.cache_read_input_tokens);
  }
  t.work = t.input + t.output;
  return t;
}

/** Context-window fill from ONE transcript (the MAIN one). The LAST assistant
 *  message that carries a usage block wins — that is the most recent real prompt
 *  the model received. Subagents have their OWN windows and must NOT be summed
 *  here (unlike the cost metric). Returns the model id from that same turn so
 *  the caller can look up the window limit. */
export function lastAssistantContext(raw: string): ContextInfo {
  let tokens: number | null = null;
  let modelId: string | null = null;
  let effort: string | null = null;
  let turnId: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let obj: any;
    try {
      obj = JSON.parse(s);
    } catch {
      continue; // tolerate a partial last line mid-write
    }
    if (obj?.type !== "assistant" || !obj.message) continue;
    if (obj.isSidechain) continue; // subagent has its OWN window — must never set main context
    // Claude Code writes placeholder turns with model "<synthetic>" (interrupts,
    // errors). They are not a real prompt: they must neither move the context
    // fill nor become the displayed model / window-limit lookup key.
    if (typeof obj.message.model === "string" && obj.message.model.startsWith("<")) continue;
    const u = obj.message.usage;
    if (!u) continue;
    // latest assistant turn with usage overwrites → ends as the last one.
    tokens = tokenCount(u.input_tokens) + tokenCount(u.cache_read_input_tokens) + cacheWriteTokens(u);
    // Assigned unconditionally: a newer turn that carries no model must RESET
    // this, not inherit the previous turn's one. Presenting an older model
    // beside newer token counts would be a confident (and wrong) reading.
    modelId = typeof obj.message.model === "string" && obj.message.model ? obj.message.model : null;
    // `effort` is a TOP-LEVEL field of the transcript entry (not inside
    // message) — the reasoning level that turn actually ran at.
    effort = typeof obj.effort === "string" && obj.effort ? obj.effort : null;
    turnId = obj.message.id || obj.requestId || obj.uuid || null;
  }
  return { tokens, modelId, effort, turnId };
}

/** One subagent's transcript boiled down to what the owner needs to see: which
 *  model the Lead handed the task to, at which effort, and what it cost. Every
 *  turn in an agent file is a sidechain, so the sum must include them. */
export interface AgentDigest {
  model: string | null;
  effort: string | null;
  totals: Totals;
  /** ms timestamp of the last turn — used to order the list newest-first. */
  lastTurnMs: number;
  /** What this agent's own idle gaps cost. Computed here so the transcript
   *  cache (mtime+size keyed) covers it too — an agent log is append-only and
   *  most are finished, so re-scanning every one on every tick is pure waste. */
  rebuild: IdleRebuild;
}

/** Digest ONE agent-*.jsonl. Pure (text in, data out) → unit-testable. */
export function agentDigest(raw: string): AgentDigest {
  let model: string | null = null;
  let effort: string | null = null;
  let lastTurnMs = 0;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let obj: any;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (obj?.type !== "assistant" || !obj.message) continue;
    const m = obj.message.model;
    // A subagent runs one model for its whole life; the last real one wins.
    if (typeof m === "string" && m && !m.startsWith("<")) model = m;
    if (typeof obj.effort === "string" && obj.effort) effort = obj.effort;
    const ts = Date.parse(obj.timestamp || "");
    if (!Number.isNaN(ts) && ts > lastTurnMs) lastTurnMs = ts;
  }
  return {
    model,
    effort,
    totals: sumTranscript(raw, true),
    lastTurnMs,
    // No tier here: what the UI needs is `rebuild` (which reads the tier per gap
    // itself), and scanning the whole log a second time for a value nobody reads
    // costs a full pass over every agent file whenever one of them changes.
    rebuild: idleRebuildOf(raw, true),
  };
}

/** Context-fill colour dot. Purely INFORMATIONAL: context has no reset and no
 *  consequence like a quota limit, so this dot NEVER drives the status-bar
 *  background (see buildView) — it only colours its own segment.
 *
 *  Thresholds (owner, revised 2026-07-25): <40% 🟢 · 40–60% 🟡 · ≥60% 🔴.
 *  Deliberately EARLIER than "nearly full". With a 1M window, filling the bar is
 *  never the goal: answer quality degrades progressively well before the limit,
 *  and a fatter context also burns more quota per turn. So 🟡 means "start
 *  looking for a good place to finish — ideally before auto-compaction decides
 *  for you", and 🔴 means "wrap up and carry the rest into a fresh session".
 *  A dot that only turned red at 80% would be warning after the damage. */
export function contextLevel(pct: number): PaceLevel {
  if (pct >= 60) return "over";
  if (pct >= 40) return "tight";
  return "normal";
}

/** Which prompt-cache TTL tier the session is on. Read from the data, never
 *  assumed — Anthropic's behaviour shifts silently (see research addendum). */
export type CacheTier = "1h" | "5m" | null;

/** Descriptive cache-hit rate: share of input tokens served from cache (cheap,
 *  ×0.1) vs freshly processed. `cacheRead / (cacheRead + cacheWrite + input)`,
 *  0..100. Null when no input yet. DESCRIPTIVE, not a score — it is normal to
 *  start low and climb as a session warms up. */
export function cacheHitRatePct(t: Totals): number | null {
  const denom = t.cacheRead + t.cacheWrite + t.input;
  if (denom <= 0) return null;
  return Math.round((t.cacheRead / denom) * 100);
}

/** The stream's current cache tier, decided by the most recent assistant turn
 *  that WROTE to cache: "1h" / "5m" from the nested
 *  `cache_creation.ephemeral_{1h,5m}_input_tokens`. Null when no write turn is
 *  observable (or only old transcripts lacking the nested breakdown) — and a
 *  null tier must never be replaced by an assumed one.
 *
 *  `includeSidechain` picks WHICH file this is, exactly like sumTranscript:
 *  false for a MAIN transcript (subagent turns are excluded so their 5m tier
 *  cannot confound the main one), true for an agent-*.jsonl, where every turn
 *  is a sidechain and excluding them would always return null. */
export function lastCacheTier(raw: string, includeSidechain = false): CacheTier {
  let tier: CacheTier = null;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let obj: any;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (obj?.type !== "assistant" || !obj.message) continue;
    if (obj.isSidechain && !includeSidechain) continue;
    // Same validation the pricing path uses: a breakdown it rejects as corrupt
    // must not be shown to the user as a confident tier either.
    const t = tierOfWrite(obj.message.usage);
    if (t) tier = t;
    // a write-less or breakdown-less turn leaves the previous tier unchanged
  }
  return tier;
}

/** What waiting cost this stream: cache writes spent reloading a context whose
 *  cache had gone cold during a pause. */
export interface IdleRebuild {
  /** Raw cache-write tokens that landed on a turn following a pause > TTL. */
  tokens: number;
  /** The same tokens, split by the tier each reload write actually landed on,
   *  so the cost is priced exactly like any other write (see rebuildCost). */
  tokens1h: number;
  tokens5m: number;
  tokensUnknown: number;
  /** ALL cache-write tokens of the counted stream(s). Denominator of the
   *  "reloads are N% of what the agents wrote" threshold. */
  cacheWrite: number;
  /** How many streams contained at least one reload (0 or 1 for the lead). */
  streams: number;
  /** Gaps we could NOT judge: a turn we cannot place in time (missing or
   *  backwards timestamp), or one reached before any write stated a cache
   *  lifetime, so there is no TTL to measure the pause against.
   *
   *  Why it has to be carried: a zero above is otherwise ambiguous. "No reload
   *  was counted" means "it never waited" ONLY when every gap was judgeable —
   *  with an unjudged gap it means "we cannot tell", and a UI that prints 0%
   *  for the second case invents a fact. Absence of evidence, not evidence of
   *  absence. */
  unjudged: number;
}

export function emptyRebuild(): IdleRebuild {
  return { tokens: 0, tokens1h: 0, tokens5m: 0, tokensUnknown: 0, cacheWrite: 0, streams: 0, unjudged: 0 };
}

export function addRebuild(a: IdleRebuild, b: IdleRebuild): IdleRebuild {
  return {
    tokens: a.tokens + b.tokens,
    tokens1h: a.tokens1h + b.tokens1h,
    tokens5m: a.tokens5m + b.tokens5m,
    tokensUnknown: a.tokensUnknown + b.tokensUnknown,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    streams: a.streams + b.streams,
    unjudged: a.unjudged + b.unjudged,
  };
}

/** Reload tokens as a token-equivalent, using exactly the weights the session
 *  headline uses — so the figure is a true subset of the number beside it. */
export function rebuildCost(r: IdleRebuild, w: Weights): number {
  return Math.round(
    CACHE_WRITE_WEIGHT_1H * r.tokens1h + CACHE_WRITE_WEIGHT_5M * r.tokens5m + w.cacheWrite * r.tokensUnknown
  );
}

/** Cache writes this stream spent rebuilding context after an idle gap longer
 *  than the cache that was live at the time.
 *
 *  Why this signal is clean where a bare `cache_creation` spike is not: we never
 *  look at a spike alone (it has at least eight non-idle causes — model switch,
 *  compaction, an MCP change…). We look at a PAIR: a gap longer than the TTL of
 *  the cache written just before it, immediately followed by a write.
 *
 *  Rules, all of them deliberate:
 *  - The TTL is taken PER GAP, from the last write whose tier the transcript
 *    states — not once for the whole file. A session can change tier mid-run
 *    (passing the plan limit switches 1h → 5m), and judging an old 10-minute
 *    gap by the tier the session ended on invents rebuilds in one direction and
 *    loses them in the other.
 *  - No stated tier yet → nothing is counted. A TTL is never assumed.
 *  - Dedup by `message.id` first: one API response spans several jsonl lines and
 *    repeats its usage block verbatim, which would inflate the figure ~2.5×.
 *  - Turns are read in TRANSCRIPT ORDER, never re-sorted. A turn with no usable
 *    timestamp, or one whose clock went backwards, is a BARRIER: its tokens
 *    still count toward `cacheWrite`, but no gap is measured across it. Bridging
 *    over such a turn would invent a pause that the skipped turn disproves. */
export function idleRebuildOf(raw: string, includeSidechain = false): IdleRebuild {
  const out = emptyRebuild();
  /** Tier of the newest write we have seen — the cache a pause would kill. */
  let liveTier: CacheTier = null;
  /** Timestamp of the previous turn, or null when the chain is broken. */
  let prevTs: number | null = null;
  /** Counted turns so far. Every turn after the first sits at the end of a gap,
   *  which is what makes an unjudged one worth recording (see `unjudged`). */
  let turns = 0;
  const seen = new Set<string>();

  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let obj: any;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (obj?.type !== "assistant" || !obj.message) continue;
    if (obj.isSidechain && !includeSidechain) continue;
    // Only real turns count. A placeholder with no `usage` (an interrupt, an
    // error) is not a turn: letting it through would advance the clock and hide
    // a genuine pause behind it, or plant a barrier where nothing happened.
    const usage = obj.message.usage;
    if (!usage) continue;
    const id = obj.message.id || obj.requestId;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const split = cacheWriteSplit(usage);
    const write = split.h1 + split.m5 + split.unknown;
    out.cacheWrite += write;

    const ts = Date.parse(obj.timestamp || "");
    /** Could the gap ENDING at this turn be judged at all? Both ends have to be
     *  placeable in time, and a TTL has to be known to measure the pause
     *  against. Anything else is recorded as unjudged rather than as zero. */
    let judged = false;
    if (Number.isNaN(ts)) {
      prevTs = null; // barrier: this turn happened, we just cannot place it
    } else if (prevTs != null && ts <= prevTs) {
      // The clock went backwards. Measure nothing across it — and nothing from
      // it either: the NEXT gap would be measured against a timestamp we have
      // just been shown to be untrustworthy.
      prevTs = null;
    } else {
      const gapSec = prevTs == null ? 0 : (ts - prevTs) / 1000;
      if (liveTier && prevTs != null) {
        judged = true;
        if (gapSec > CACHE_TTL_SECONDS[liveTier]) {
          out.tokens += write;
          out.tokens1h += split.h1;
          out.tokens5m += split.m5;
          out.tokensUnknown += split.unknown;
        }
      }
      prevTs = ts;
    }
    if (turns > 0 && !judged) out.unjudged += 1;
    turns += 1;

    const tier = tierOfWrite(usage);
    if (tier) liveTier = tier;
  }

  if (out.tokens > 0) out.streams = 1;
  return out;
}

export function addTotals(a: Totals, b: Totals): Totals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    work: a.work + b.work,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWriteUnknown: a.cacheWriteUnknown + b.cacheWriteUnknown,
  };
}

export function fmtTokens(n: number, floor = false): string {
  // one decimal, but drop a trailing ".0" → "1M" not "1.0M", "468k" not "468.0k".
  //
  // `floor` truncates that decimal instead of rounding it. It is for figures
  // printed as "≥ X": rounding 3.75M up to "3.8M" turns a true lower bound into
  // a false one — the number claimed would be above the number measured.
  const f = (v: number, suf: string): string => {
    const s = (floor ? Math.floor(v * 10) / 10 : v).toFixed(1);
    return (s.endsWith(".0") ? s.slice(0, -2) : s) + suf;
  };
  if (n >= 1_000_000) return f(n / 1_000_000, "M");
  if (n >= 1_000) return f(n / 1_000, "k");
  // Below 1k the same rule applies: a floor rounds DOWN, or "≥ 1000" could be
  // printed for a measured 999.5.
  return String(floor ? Math.floor(n) : Math.round(n));
}

/** Savings multiplier (noCache / effective) → "6.8", "7" (drops trailing ".0"). */
/** Which way the with-cache/without-cache comparison actually points, and by how
 *  much. Never assume "the cache saved you something": early in a session it has
 *  not. A 1-hour cache WRITE is priced at 2× a fresh input token and nothing has
 *  been read back from it yet, so a first turn that only writes really is more
 *  expensive than doing the same work with no cache at all — the saving arrives
 *  with the reads that follow. Stating "N× more" there is simply false.
 *
 *  "same" covers the break-even case AND anything that rounds to 1×, so the UI
 *  never prints "~1× more" for two numbers it cannot tell apart. Pure. */
export type CostDirection = "more" | "same" | "less";

/** Which side of a printed figure the unknown lies on. A bound is only a floor
 *  while the unknown is priced ABOVE what we assumed in its place; price it
 *  below and the same figure is a ceiling, price it the same and there is no
 *  bound at all. Naming the wrong side is worse than naming none. */
export type BoundDirection = "floor" | "exact" | "ceiling";

/** The bound an unstated cache-write count puts on a token-equivalent that
 *  priced those tokens as ordinary input: the write weight decides it, and
 *  nothing else does. Pure. */
export function writeBound(cacheWriteWeight: number): BoundDirection {
  if (cacheWriteWeight > 1) return "floor";
  if (cacheWriteWeight < 1) return "ceiling";
  return "exact";
}
export function costDirection(
  effective: number,
  noCache: number
): { dir: CostDirection; mult: string | null } {
  // A ratio needs both sides. With one of them at zero the direction is still
  // knowable — "one is more than nothing" — but the multiplier is not, so it is
  // returned as null and every surface then simply omits it. Reporting "same"
  // here (as the first version did) would state the opposite of the arithmetic.
  if (effective <= 0 && noCache <= 0) return { dir: "same", mult: null };
  if (effective <= 0) return { dir: "more", mult: null };
  if (noCache <= 0) return { dir: "less", mult: null };
  const bigger = Math.max(effective, noCache);
  const smaller = Math.min(effective, noCache);
  const mult = fmtMult(bigger / smaller);
  // Anything that rounds to 1× is presented as "about the same": printing
  // "~1× more" for two numbers the display cannot tell apart is not a
  // statement. NOTE for callers: this is a PRESENTATION state, not the sign.
  // Anything that reasons about who is bigger (e.g. whether the cache has
  // earned back what it cost) must compare the numbers, not read this field.
  if (mult === "1") return { dir: "same", mult };
  return { dir: noCache > effective ? "more" : "less", mult };
}

export function fmtMult(x: number): string {
  const s = x.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** Time-until-reset with language-specific unit suffixes.
 *  e.g. en: "—" / "38m" / "2h41m" / "4d3h" · ru: "38м" / "2ч41м" / "4д3ч". */
export function fmtRemaining(seconds: number, units: { d: string; h: string; m: string }): string {
  const secs = Math.floor(seconds);
  if (secs <= 0) return "—";
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (days > 0) return `${days}${units.d}${hours}${units.h}`;
  if (hours > 0) return `${hours}${units.h}${String(mins).padStart(2, "0")}${units.m}`;
  return `${mins}${units.m}`;
}

/** Pace projection: will the current burn fit the window before reset?
 *  Mirrors statusline.py quota_segment logic. Returns the level only;
 *  the human-readable verdict label is localized at render time. */
export function paceLevel(
  pct: number,
  resetAt: number | null,
  nowSec: number,
  windowSeconds: number
): PaceLevel {
  let level: PaceLevel = "normal";
  if (resetAt) {
    const remaining = resetAt - nowSec;
    if (remaining > 0) {
      const frac = (windowSeconds - remaining) / windowSeconds;
      if (frac > 0.03 && frac <= 1) {
        const projected = pct / frac;
        if (projected > 102) level = "over";
        else if (projected >= 90) level = "tight";
      }
    }
  }
  return level;
}

/** The worse of two pace levels (for the whole status-bar item color). */
export function worstLevel(a: PaceLevel, b: PaceLevel): PaceLevel {
  const rank: Record<PaceLevel, number> = { normal: 0, tight: 1, over: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/** Parse Anthropic unified rate-limit response headers into quota windows.
 *  utilization headers are 0..1 floats → ×100. reset headers are unix seconds. */
export function parseRateLimitHeaders(
  get: (name: string) => string | null
): { fiveH: QuotaWindow | null; sevenD: QuotaWindow | null } {
  const num = (v: string | null): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const build = (prefix: string): QuotaWindow | null => {
    const util = num(get(`anthropic-ratelimit-unified-${prefix}-utilization`));
    if (util == null) return null;
    const reset = num(get(`anthropic-ratelimit-unified-${prefix}-reset`));
    const status = get(`anthropic-ratelimit-unified-${prefix}-status`) || undefined;
    return { pct: util * 100, resetAt: reset, status };
  };
  return { fiveH: build("5h"), sevenD: build("7d") };
}

export const WINDOW_5H_SECONDS = 5 * 3600;
export const WINDOW_7D_SECONDS = 7 * 86400;

/** Built-in, API-CONFIRMED context-window sizes (max_input_tokens) for current
 *  Claude models — an OFFLINE fallback so the context % shows instantly even on
 *  a link too weak to reach the Models API. The live API value always overrides
 *  this once fetched (it is the per-account source of truth and covers future
 *  models). Context is informational (no hard consequence), so a documented
 *  fallback is acceptable here. Confirmed against /v1/models on 2026-06-22.
 *  Prefix match so dated ids (e.g. …-20251001) resolve. */
const KNOWN_MODEL_WINDOWS: Array<[string, number]> = [
  ["claude-opus-4-8", 1_000_000],
  ["claude-sonnet-4-6", 1_000_000],
  ["claude-fable-5", 1_000_000],
  ["claude-haiku-4-5", 200_000],
];

/** Best-effort context window for a model id from the built-in table, or null
 *  when unknown (caller then relies on the live API / hides the %). Pure. */
export function knownModelWindow(modelId: string | null | undefined): number | null {
  if (!modelId) return null;
  for (const [prefix, win] of KNOWN_MODEL_WINDOWS) {
    if (modelId === prefix || modelId.startsWith(prefix)) return win;
  }
  return null;
}
