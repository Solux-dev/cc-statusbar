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

/** Fetch quota. Never throws — returns a state-tagged result for graceful UI. */
export async function fetchQuota(override: string, nowSec: number): Promise<QuotaResult> {
  const token = readAccessToken(override);
  if (!token) {
    return { fiveH: null, sevenD: null, fetchedAtSec: nowSec, state: "no-credentials" };
  }
  try {
    const resp = await fetch(API_URL, {
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
  } catch (e: any) {
    return { fiveH: null, sevenD: null, fetchedAtSec: nowSec, state: "error", detail: String(e?.message || e) };
  }
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
  try {
    const resp = await fetch(`${MODELS_URL}/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": CRED_BETA,
      },
    });
    const text = await resp.text();
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
  } catch (e: any) {
    return { id, maxInputTokens: null, fetchedAtSec: nowSec, state: "error", detail: String(e?.message || e) };
  }
}

/** Throttle gate: poll only if enough time passed AND the session was active
 *  recently (avoids the documented 429 bug + wasted tokens while idle). */
export function shouldPoll(
  lastFetchSec: number,
  nowSec: number,
  minPollSeconds: number,
  lastActivityMs: number,
  rateLimitedUntilSec: number
): boolean {
  if (nowSec < rateLimitedUntilSec) return false; // backing off after a 429
  if (nowSec - lastFetchSec < minPollSeconds) return false;
  const activeRecently = lastActivityMs > 0 && Date.now() - lastActivityMs < minPollSeconds * 1000;
  return activeRecently;
}
