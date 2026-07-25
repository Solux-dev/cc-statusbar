// Pure, dependency-free logic — unit-tested without the VS Code API.
// The `effective` formula MUST stay in sync with the project's
// tools/session-cost.py (CACHE_READ_WEIGHT / CACHE_WRITE_WEIGHT) and
// docs/cost-metrics.md.

export interface Totals {
  input: number;
  output: number;
  work: number; // input + output
  cacheRead: number;
  cacheWrite: number;
}

export interface Weights {
  cacheRead: number; // default 0.1
  cacheWrite: number; // default 1.25
}

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
  return { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Cache-write tokens for one usage block, robust across Claude Code versions.
 *  Prefer the top-level `cache_creation_input_tokens`, but fall back to the
 *  nested per-TTL breakdown: on Claude Code < v2.1.152 the top-level field could
 *  report 0 while only `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`
 *  carried the real value (fixed in the v2.1.152 changelog, 2026-05-27).
 *  Current transcripts populate the top-level field, so this only matters for
 *  older sessions — verified against real data 2026-05-31. */
export function cacheWriteTokens(u: any): number {
  const top = u?.cache_creation_input_tokens || 0;
  if (top) return top;
  const c = u?.cache_creation;
  if (c) return (c.ephemeral_5m_input_tokens || 0) + (c.ephemeral_1h_input_tokens || 0);
  return 0;
}

/** Effective (cache-weighted) tokens — comparable consumption number. */
export function effectiveTokens(t: Totals, w: Weights): number {
  return Math.round(t.work + w.cacheRead * t.cacheRead + w.cacheWrite * t.cacheWrite);
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
    const id = obj.message.id || obj.requestId;
    if (id) {
      if (seen.has(id)) continue; // same response, another content-block line — already counted
      seen.add(id);
    }
    const u = obj.message.usage || {};
    t.input += u.input_tokens || 0;
    t.output += u.output_tokens || 0;
    t.cacheWrite += cacheWriteTokens(u);
    t.cacheRead += u.cache_read_input_tokens || 0;
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
    tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + cacheWriteTokens(u);
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
  return { model, effort, totals: sumTranscript(raw, true), lastTurnMs };
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

/** The MAIN session's current cache tier, decided by the most recent
 *  main-conversation assistant turn that WROTE to cache: "1h" / "5m" from the
 *  nested `cache_creation.ephemeral_{1h,5m}_input_tokens`. Null when no write
 *  turn is observable (or only old transcripts lacking the nested breakdown).
 *  Subagents (`isSidechain`) are always 5m and are excluded so they can't
 *  confound the main tier. */
export function lastCacheTier(raw: string): CacheTier {
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
    if (obj.isSidechain) continue;
    const c = obj.message.usage?.cache_creation;
    if (!c) continue;
    if ((c.ephemeral_1h_input_tokens || 0) > 0) tier = "1h";
    else if ((c.ephemeral_5m_input_tokens || 0) > 0) tier = "5m";
    // a write-less or breakdown-less turn leaves the previous tier unchanged
  }
  return tier;
}

export function addTotals(a: Totals, b: Totals): Totals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    work: a.work + b.work,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

export function fmtTokens(n: number): string {
  // one decimal, but drop a trailing ".0" → "1M" not "1.0M", "468k" not "468.0k".
  const f = (v: number, suf: string): string => {
    const s = v.toFixed(1);
    return (s.endsWith(".0") ? s.slice(0, -2) : s) + suf;
  };
  if (n >= 1_000_000) return f(n / 1_000_000, "M");
  if (n >= 1_000) return f(n / 1_000, "k");
  return String(Math.round(n));
}

/** Savings multiplier (noCache / effective) → "6.8", "7" (drops trailing ".0"). */
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
