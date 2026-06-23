// LOCAL (zero-network) quota source: read the 5h/7d rate limits that Claude
// Code already hands to the statusLine hook on stdin and that our companion
// statusline.py mirrors to ~/.claude/.cc-statusbar-quota.json (see its
// dump_quota_bridge()). This is the SAME real server data Claude Code shows in
// its own usage view — but reached without our own fragile network poll, so it
// works on any link Claude Code itself works on (e.g. weak phone tethering).
//
// This NEVER replaces the network poll — the caller merges both and shows the
// freshest reading (see extension.ts). It only ADDS coverage.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { QuotaWindow } from "./metrics";

export interface LocalQuotaResult {
  fiveH: QuotaWindow | null;
  sevenD: QuotaWindow | null;
  /** Unix seconds the statusline wrote this reading (its freshness). 0 if unknown. */
  writtenAtSec: number;
  /** True only when the file existed, parsed, and carried at least one window. */
  ok: boolean;
}

function bridgePath(override = ""): string {
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), ".claude", ".cc-statusbar-quota.json");
}

/** Map one statusLine rate_limits window ({used_percentage, resets_at}) into our
 *  QuotaWindow ({pct, resetAt}). Null when the shape is missing/invalid. Pure. */
export function windowFromBridge(w: any): QuotaWindow | null {
  if (!w || typeof w !== "object") return null;
  const pct = w.used_percentage;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  const reset = typeof w.resets_at === "number" && Number.isFinite(w.resets_at) ? w.resets_at : null;
  const status = typeof w.status === "string" ? w.status : undefined;
  return { pct, resetAt: reset, status };
}

/** Parse the bridge file's raw JSON text into a LocalQuotaResult. Separated from
 *  disk I/O so it is pure → unit-testable. Never throws. */
export function parseLocalQuota(raw: string): LocalQuotaResult {
  try {
    const obj = JSON.parse(raw);
    const rl = obj?.rate_limits || {};
    const fiveH = windowFromBridge(rl.five_hour);
    const sevenD = windowFromBridge(rl.seven_day);
    const writtenAtSec = typeof obj?.writtenAtSec === "number" ? obj.writtenAtSec : 0;
    return { fiveH, sevenD, writtenAtSec, ok: Boolean(fiveH || sevenD) };
  } catch {
    return { fiveH: null, sevenD: null, writtenAtSec: 0, ok: false };
  }
}

/** Read the statusline-written quota bridge file. NO network. Never throws —
 *  returns ok=false when the file is absent/unreadable/invalid. */
export function readLocalQuota(override = ""): LocalQuotaResult {
  try {
    return parseLocalQuota(fs.readFileSync(bridgePath(override), "utf-8"));
  } catch {
    return { fiveH: null, sevenD: null, writtenAtSec: 0, ok: false };
  }
}
