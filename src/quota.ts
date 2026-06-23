// ISOLATED fragile module: fetch REAL 5h/7d subscription quota.
// Everything Anthropic-auth-dependent lives HERE. If Claude changes auth,
// only this file needs a patch — the rest of the extension keeps working
// (graceful degradation: callers show local token/effective metrics and
// just hide the tariff line).
//
// Mechanism (verified from the open-source long-kudo extension, MIT):
//   token  : ~/.claude/.credentials.json → claudeAiOauth.accessToken
//   request: POST https://api.anthropic.com/v1/messages
//            headers: Authorization: Bearer <token>, anthropic-version,
//                     anthropic-beta: oauth-2025-04-20, content-type
//            body   : tiny 1-token message (rate-limit headers ride on it)
//   read   : anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}
// Cost ~ a few tokens per poll; throttled + activity-gated by the caller.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { QuotaWindow, parseRateLimitHeaders } from "./metrics";

export interface QuotaResult {
  fiveH: QuotaWindow | null;
  sevenD: QuotaWindow | null;
  fetchedAtSec: number;
  state: "ok" | "no-credentials" | "error" | "rate-limited";
  detail?: string;
}

const CRED_BETA = "oauth-2025-04-20";
const API_URL = "https://api.anthropic.com/v1/messages";
const MODELS_URL = "https://api.anthropic.com/v1/models";
const QUOTA_MODEL = "claude-haiku-4-5-20251001";

export interface ModelWindowResult {
  id: string;
  /** max_input_tokens = the context-window limit; null on any failure (fail-visibly). */
  maxInputTokens: number | null;
  fetchedAtSec: number;
  state: "ok" | "no-credentials" | "error";
  detail?: string;
}

function credentialsPath(override: string): string {
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

/** Read the OAuth access token from the local credentials file. */
export function readAccessToken(override = ""): string | null {
  try {
    const raw = fs.readFileSync(credentialsPath(override), "utf-8");
    const obj = JSON.parse(raw);
    const tok = obj?.claudeAiOauth?.accessToken;
    return typeof tok === "string" && tok.length > 0 ? tok : null;
  } catch {
    return null;
  }
}

// ── Resilient transport ──────────────────────────────────────────────────────
// A single fetch with undici's ~10s connect timeout is too fragile for the
// diverse conditions this extension runs in: VPN tunnels, remote/cloud-hosted
// Claude Code, users on the move. The route to api.anthropic.com may answer in
// 1s, 8s, or 15s. So instead of one impatient attempt we make a FEW sequential
// attempts with ESCALATING per-attempt timeouts — a healthy link wins fast on
// attempt 1, a slow link still succeeds on a later, more patient attempt — and
// we ADAPT: remember the last successful round-trip so a consistently slow link
// stops wasting its early attempts on a too-short budget. Only transient
// failures are retried (never auth/429).

/** Last successful round-trip to the API (ms), module-scoped. Lets the next
 *  poll pre-size its timeouts to the user's real link speed. 0 = unknown yet. */
let lastRttMs = 0;

/** Small pause between attempts so a flapping link isn't hammered. */
const RETRY_GAP_MS = 400;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Per-attempt timeout schedule in ms. Escalates so the common (fast) case
 *  returns quickly while a slow link still gets a patient retry. Floors every
 *  attempt at ~2× the last good round-trip (capped) so a known-slow link does
 *  not fail its early attempts. Pure → unit-testable. */
export function attemptTimeoutsMs(lastGoodRttMs = 0): number[] {
  const base = [6000, 14000, 22000]; // ~42s worst case, bounded
  if (lastGoodRttMs <= 0) return base;
  const floor = Math.min(30000, Math.ceil(lastGoodRttMs * 2));
  return base.map((t) => Math.max(t, floor));
}

/** Whether an HTTP status is worth retrying (transient server-side). 429 is
 *  handled separately (the caller backs off); auth/other 4xx are not retried
 *  because a retry would not change the outcome. Pure → unit-testable. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status >= 500;
}

/** Fetch with escalating per-attempt timeouts + retries on transient failures.
 *  Returns the final Response (even a non-ok one — the caller inspects it), or
 *  null when every attempt threw (connect timeout / network down). Records the
 *  round-trip on a completed request so the next call can adapt. Never throws. */
async function resilientFetch(url: string, init: RequestInit): Promise<Response | null> {
  const schedule = attemptTimeoutsMs(lastRttMs);
  for (let i = 0; i < schedule.length; i++) {
    const isLast = i === schedule.length - 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), schedule[i]);
    const startedMs = Date.now();
    try {
      const resp = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      // Transient server error → drain and try a later, more patient attempt.
      if (!isLast && resp.status !== 429 && isRetryableStatus(resp.status)) {
        try {
          await resp.text();
        } catch {
          /* ignore */
        }
        await delay(RETRY_GAP_MS);
        continue;
      }
      lastRttMs = Date.now() - startedMs; // the link answered — remember how slow
      return resp;
    } catch {
      clearTimeout(timer); // timeout/abort/network — retry unless this was the last
      if (!isLast) await delay(RETRY_GAP_MS);
    }
  }
  return null;
}

/** Fetch quota. Never throws — returns a state-tagged result for graceful UI. */
export async function fetchQuota(override: string, nowSec: number): Promise<QuotaResult> {
  const token = readAccessToken(override);
  if (!token) {
    return { fiveH: null, sevenD: null, fetchedAtSec: nowSec, state: "no-credentials" };
  }
  const resp = await resilientFetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": CRED_BETA,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: QUOTA_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "." }],
    }),
  });

  // null = every attempt timed out / network unreachable (no proxy, slow tunnel,
  // server offline). Surface it as a connectivity error, not a quota state.
  if (!resp) {
    return { fiveH: null, sevenD: null, fetchedAtSec: nowSec, state: "error", detail: "no response (connect timeout / network)" };
  }

  if (resp.status === 429) {
    return {
      fiveH: null,
      sevenD: null,
      fetchedAtSec: nowSec,
      state: "rate-limited",
      detail: resp.headers.get("retry-after") || "",
    };
  }

  const { fiveH, sevenD } = parseRateLimitHeaders((n) => resp.headers.get(n));
  // Drain body to free the socket; we only need headers.
  try {
    await resp.text();
  } catch {
    /* ignore */
  }
  if (!fiveH && !sevenD) {
    return { fiveH, sevenD, fetchedAtSec: nowSec, state: "error", detail: `http ${resp.status}, no ratelimit headers` };
  }
  return { fiveH, sevenD, fetchedAtSec: nowSec, state: "ok" };
}

/** Fetch a model's context-window limit (max_input_tokens) via GET /v1/models/{id}
 *  using the SAME local OAuth token as the quota feature. Verified 2026-05-31:
 *  the subscription OAuth token returns 200 with max_input_tokens on this route.
 *  Never throws — returns a state-tagged result. On ANY failure maxInputTokens
 *  stays null → callers fail visibly (hide the %), never guess. Model window
 *  limits don't change, so the caller caches the result for a long time (24h). */
export async function fetchModelWindow(
  id: string,
  override: string,
  nowSec: number
): Promise<ModelWindowResult> {
  const token = readAccessToken(override);
  if (!token) {
    return { id, maxInputTokens: null, fetchedAtSec: nowSec, state: "no-credentials" };
  }
  const resp = await resilientFetch(`${MODELS_URL}/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": CRED_BETA,
    },
  });
  if (!resp) {
    return { id, maxInputTokens: null, fetchedAtSec: nowSec, state: "error", detail: "no response (connect timeout / network)" };
  }
  let text: string;
  try {
    text = await resp.text();
  } catch (e: any) {
    return { id, maxInputTokens: null, fetchedAtSec: nowSec, state: "error", detail: String(e?.message || e) };
  }
  if (!resp.ok) {
    return { id, maxInputTokens: null, fetchedAtSec: nowSec, state: "error", detail: `http ${resp.status}` };
  }
  let obj: any;
  try {
    obj = JSON.parse(text);
  } catch {
    return { id, maxInputTokens: null, fetchedAtSec: nowSec, state: "error", detail: "bad json" };
  }
  const lim = obj?.max_input_tokens;
  if (typeof lim !== "number" || !Number.isFinite(lim) || lim <= 0) {
    return { id, maxInputTokens: null, fetchedAtSec: nowSec, state: "error", detail: "no max_input_tokens" };
  }
  return { id, maxInputTokens: lim, fetchedAtSec: nowSec, state: "ok" };
}

/** Throttle gate: poll only if enough time passed AND the session was active
 *  recently (avoids the documented 429 bug + wasted tokens while idle).
 *
 *  `throttleSec` is the minimum gap between polls — the caller shortens it after
 *  a FAILED poll so a flaky link (where the request times out but recovers
 *  seconds later) is retried in ~a minute instead of staying stale for the full
 *  poll interval. `activityWindowSec` (defaults to throttleSec for backward
 *  compatibility) is kept at the NORMAL interval so shortening the retry gap
 *  does not also shrink the "is the user active?" window. */
export function shouldPoll(
  lastFetchSec: number,
  nowSec: number,
  throttleSec: number,
  lastActivityMs: number,
  rateLimitedUntilSec: number,
  activityWindowSec: number = throttleSec
): boolean {
  if (nowSec < rateLimitedUntilSec) return false; // backing off after a 429
  if (nowSec - lastFetchSec < throttleSec) return false;
  const activeRecently = lastActivityMs > 0 && Date.now() - lastActivityMs < activityWindowSec * 1000;
  return activeRecently;
}

/** Seconds to wait before retrying after a FAILED poll (timeout / network). Much
 *  shorter than the normal interval so an intermittent link is caught quickly,
 *  but long enough not to hammer a down link. */
export const FAIL_RETRY_SEC = 45;
