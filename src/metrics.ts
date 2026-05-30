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

export type PaceLevel = "normal" | "tight" | "over";

export function emptyTotals(): Totals {
  return { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Effective (cache-weighted) tokens — comparable consumption number. */
export function effectiveTokens(t: Totals, w: Weights): number {
  return Math.round(t.work + w.cacheRead * t.cacheRead + w.cacheWrite * t.cacheWrite);
}

/** Sum usage from one transcript's lines (raw jsonl text). Mirrors
 *  session-cost.py parse_session: only assistant messages with a usage block. */
export function sumTranscript(raw: string): Totals {
  const t = emptyTotals();
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
    const u = obj.message.usage || {};
    t.input += u.input_tokens || 0;
    t.output += u.output_tokens || 0;
    t.cacheWrite += u.cache_creation_input_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
  }
  t.work = t.input + t.output;
  return t;
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
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
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
