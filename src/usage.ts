// Claude Code's USAGE PAYLOAD — the one place that knows its shape.
//
// The payload is the body of `GET /api/oauth/usage`: every quota window of the
// account in a single JSON — `five_hour`, `seven_day`, the model-scoped weekly
// windows (today: Fable), credits. We reach it two ways, and BOTH land here:
//
//   1. live   — our own request (src/quota.ts fetchUsage) → always current;
//   2. cached — Claude Code persists the very same body in ~/.claude.json under
//      `cachedUsageUtilization`, so the last-known numbers are readable with
//      zero network. Refilled when the CLI fetches usage (its /usage view,
//      credit flows), NOT on a timer → can be hours old, hence `fetchedAtSec`.
//
// Why the scoped windows matter enough for their own path: a model capped at a
// SHARE of the weekly allowance (Fable) runs out at its own pace, and nothing
// else exposes it — the `anthropic-ratelimit-unified-*` headers carry only the
// unified 5h/7d claims, and the statusLine payload carries exactly `five_hour`
// + `seven_day` (verified in the CLI 2.1.218 binary). Before this, the number
// existed only on claude.ai.
//
// Undocumented shapes → every field is validated, and anything unexpected
// degrades to "no windows", never to a guessed number.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { QuotaWindow, ScopedQuotaWindow } from "./metrics";

/** Everything one usage payload can tell us. Windows are null / empty when the
 *  payload didn't carry them (e.g. a plan without that window). */
export interface UsageWindows {
  fiveH: QuotaWindow | null;
  sevenD: QuotaWindow | null;
  /** Per-model weekly windows, server-labelled ("Fable"). Never invented: an
   *  account without one simply gets an empty array. */
  scoped: ScopedQuotaWindow[];
}

export interface CachedUsageResult extends UsageWindows {
  /** Unix seconds the CLI obtained this reading — NOT the file's mtime (other
   *  keys in ~/.claude.json change constantly). 0 when unknown. */
  fetchedAtSec: number;
  /** True only when the file parsed and carried at least one window. */
  ok: boolean;
}

const EMPTY: CachedUsageResult = { fiveH: null, sevenD: null, scoped: [], fetchedAtSec: 0, ok: false };

function cachePath(override = ""): string {
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), ".claude.json");
}

/** ISO-8601 timestamp (what this payload uses) or unix seconds (what the
 *  rate-limit headers use) → unix seconds. Null when unusable — callers then
 *  omit the reset hint rather than invent one. Pure. */
export function toUnixSec(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : null;
  if (typeof v === "string" && v.trim()) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return Math.round(ms / 1000);
  }
  return null;
}

/** Map one named window ({utilization, resets_at}) into our QuotaWindow. Null
 *  when the percentage is missing/invalid — a window we cannot read is hidden,
 *  never shown as 0%. Pure. */
export function windowFromUsage(w: any): QuotaWindow | null {
  if (!w || typeof w !== "object") return null;
  const pct = w.utilization;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  return { pct, resetAt: toUnixSec(w.resets_at) };
}

/** Map one `limits[]` entry into a per-model weekly window. Null unless it
 *  really is one, with a name and a usable percentage. Pure. */
export function scopedWindowFromLimit(entry: any): ScopedQuotaWindow | null {
  if (!entry || typeof entry !== "object") return null;
  if (entry.kind !== "weekly_scoped") return null;
  const label = entry.scope?.model?.display_name;
  if (typeof label !== "string" || !label.trim()) return null;
  const pct = entry.percent;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  return { label: label.trim(), pct, resetAt: toUnixSec(entry.resets_at) };
}

/** Read every window we care about out of one usage payload — the SAME function
 *  for the live response body and for the on-disk copy, so the two can never
 *  drift apart. Never throws. Pure. */
export function parseUsageBody(body: any): UsageWindows {
  if (!body || typeof body !== "object") return { fiveH: null, sevenD: null, scoped: [] };
  const limits = Array.isArray(body.limits) ? body.limits : [];
  return {
    fiveH: windowFromUsage(body.five_hour),
    sevenD: windowFromUsage(body.seven_day),
    scoped: limits.map(scopedWindowFromLimit).filter(Boolean) as ScopedQuotaWindow[],
  };
}

/** True when a payload gave us anything worth showing. Pure. */
export function hasUsageWindows(u: UsageWindows): boolean {
  return Boolean(u.fiveH || u.sevenD || u.scoped.length);
}

/** Parse ~/.claude.json's raw text into the usage payload it caches. Separated
 *  from disk I/O so it is pure → unit-testable. Never throws. */
export function parseCachedUsage(raw: string): CachedUsageResult {
  try {
    const cached = JSON.parse(raw)?.cachedUsageUtilization;
    const windows = parseUsageBody(cached?.utilization);
    if (!hasUsageWindows(windows)) return EMPTY;
    const ms = cached?.fetchedAtMs;
    return {
      ...windows,
      fetchedAtSec: typeof ms === "number" && Number.isFinite(ms) ? Math.round(ms / 1000) : 0,
      ok: true,
    };
  } catch {
    return EMPTY;
  }
}

// The file is ~40 KB and consulted on every tick, while the quota block inside
// it changes at most every few minutes. Re-parse ONLY when the file actually
// changed (mtime+size), so the steady state costs one stat() per tick.
let memoKey = "";
let memoValue: CachedUsageResult = EMPTY;

/** Read the usage payload Claude Code cached on disk. NO network. Never throws —
 *  returns ok=false when the file is absent/unreadable/unexpected (e.g. a CLI
 *  version that stopped writing it). */
export function readCachedUsage(override = ""): CachedUsageResult {
  const file = cachePath(override);
  try {
    const st = fs.statSync(file);
    const key = `${file}|${st.mtimeMs}|${st.size}`;
    if (key === memoKey) return memoValue;
    const parsed = parseCachedUsage(fs.readFileSync(file, "utf-8"));
    memoKey = key;
    memoValue = parsed;
    return parsed;
  } catch {
    memoKey = "";
    memoValue = EMPTY;
    return EMPTY;
  }
}
