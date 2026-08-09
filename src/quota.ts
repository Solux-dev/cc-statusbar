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
import * as https from "https";
import * as os from "os";
import * as path from "path";
import { QuotaWindow, parseRateLimitHeaders } from "./metrics";
import { UsageWindows, hasUsageWindows, parseUsageBody } from "./usage";

export interface QuotaResult {
  fiveH: QuotaWindow | null;
  sevenD: QuotaWindow | null;
  fetchedAtSec: number;
  state: "ok" | "no-credentials" | "error" | "rate-limited";
  detail?: string;
}

/** Same states as QuotaResult, plus the per-model weekly windows only this
 *  route carries. */
export interface UsageResult extends UsageWindows {
  fetchedAtSec: number;
  state: "ok" | "no-credentials" | "error" | "rate-limited";
  detail?: string;
}

const CRED_BETA = "oauth-2025-04-20";
const API_URL = "https://api.anthropic.com/v1/messages";
const MODELS_URL = "https://api.anthropic.com/v1/models";
// The account's full utilization payload — the route Claude Code itself calls
// for its `/usage` view. A plain READ: no message is generated, so unlike the
// header route below it costs ZERO tokens, and it returns every window at once
// (5h, 7d, per-model weekly, credits). Verified live 2026-07-26: 200 with the
// same local OAuth token, `limits[]` carrying the `weekly_scoped` Fable row.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const QUOTA_MODEL = "claude-haiku-4-5-20251001";

export interface ModelWindowResult {
  id: string;
  /** max_input_tokens = the context-window limit; null on any failure (fail-visibly). */
  maxInputTokens: number | null;
  /** Anthropic's own display name ("Claude Opus 5"), when the API returned one.
   *  Optional: older persisted values predate this field. */
  displayName?: string | null;
  fetchedAtSec: number;
  state: "ok" | "no-credentials" | "error";
  detail?: string;
}

/** Which credentials file a given setting resolves to. Exported because the
 *  cross-window share keys on it: two windows pointed at DIFFERENT credential
 *  files are two different accounts, and must never read each other's numbers. */
export function resolveCredentialsPath(override: string): string {
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

function credentialsPath(override: string): string {
  return resolveCredentialsPath(override);
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

/** How long each ADDRESS FAMILY gets to complete a connection before Node's
 *  Happy Eyeballs abandons it and tries the next one.
 *
 *  Node's default is 250 ms, and that default is what silently broke this
 *  feature on a real machine: api.anthropic.com publishes both an A and an AAAA
 *  record; the user's IPv4 handshake took 350–550 ms while IPv6 had no route at
 *  all. Node started the WORKING IPv4 connection, gave up on it at 250 ms,
 *  moved to the dead IPv6 address, and the whole request died with a connect
 *  timeout — for a month, on a link where the same request from Python answered
 *  in 1.5 s. Two seconds is far above any real handshake yet still fails fast
 *  enough to be invisible when a family really is unreachable. */
const FAMILY_ATTEMPT_MS = 2000;

/** A response reduced to what this module needs. */
interface HttpResponse {
  status: number;
  header: (name: string) => string | null;
  body: string;
}

/** One HTTPS request with a hard overall budget.
 *
 *  Deliberately Node's own `https` rather than `fetch`: it is the only way to
 *  control the address-family attempt budget above (undici's global fetch
 *  exposes no per-request connect options), and as a bonus it goes through any
 *  proxy support the editor has patched into the http module — which `fetch`
 *  never honoured. Rejects on timeout/network error; never leaks the socket. */
function httpsRequest(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
  family?: 4 | 6
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: init.method,
        headers: init.headers,
        autoSelectFamilyAttemptTimeout: FAMILY_ATTEMPT_MS,
        ...(family ? { family, autoSelectFamily: false } : {}),
      } as https.RequestOptions,
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            header: (name) => {
              const v = res.headers[name.toLowerCase()];
              return Array.isArray(v) ? v[0] ?? null : v ?? null;
            },
            body,
          });
        });
        res.on("error", reject);
      }
    );
    // One hard budget for the whole exchange (connect + TLS + response), which
    // is what the caller's escalating schedule reasons about.
    const timer = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

/** Request with escalating per-attempt timeouts + retries on transient failures.
 *  Returns the final response (even a non-ok one — the caller inspects it), or
 *  null when every attempt failed (connect timeout / network down). Records the
 *  round-trip on a completed request so the next call can adapt. Never throws.
 *
 *  The LAST attempt pins IPv4. By then two ordinary attempts have already
 *  failed, so nothing is lost on an IPv6-only network — but on the common
 *  "AAAA published, no route" home setup it turns a dead poll into a working
 *  one. */
async function resilientFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
): Promise<HttpResponse | null> {
  const schedule = attemptTimeoutsMs(lastRttMs);
  for (let i = 0; i < schedule.length; i++) {
    const isLast = i === schedule.length - 1;
    const startedMs = Date.now();
    try {
      const resp = await httpsRequest(url, init, schedule[i], isLast ? 4 : undefined);
      // Transient server error → try a later, more patient attempt.
      if (!isLast && resp.status !== 429 && isRetryableStatus(resp.status)) {
        await delay(RETRY_GAP_MS);
        continue;
      }
      lastRttMs = Date.now() - startedMs; // the link answered — remember how slow
      return resp;
    } catch {
      // timeout/network — retry unless this was the last attempt
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
      // `https` does not decompress (fetch did) — never accept an encoded body.
      "accept-encoding": "identity",
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
      detail: resp.header("retry-after") || "",
    };
  }

  const { fiveH, sevenD } = parseRateLimitHeaders((n) => resp.header(n));
  if (!fiveH && !sevenD) {
    return { fiveH, sevenD, fetchedAtSec: nowSec, state: "error", detail: `http ${resp.status}, no ratelimit headers` };
  }
  return { fiveH, sevenD, fetchedAtSec: nowSec, state: "ok" };
}

/** Fetch the account's full utilization payload — 5h, 7d AND the per-model
 *  weekly windows (Fable), which no other channel exposes.
 *
 *  Preferred over fetchQuota above where it works: it is a plain GET, so it
 *  costs ZERO tokens (the header route has to generate a 1-token message to get
 *  headers to ride on) and it answers with every window in one round trip. Same
 *  local OAuth token, same resilient transport, same throttle from the caller.
 *
 *  Undocumented route → never throws, always state-tagged: on ANY failure the
 *  caller keeps the header poll and the on-disk cache, so nothing regresses. */
export async function fetchUsage(override: string, nowSec: number): Promise<UsageResult> {
  const empty = { fiveH: null, sevenD: null, scoped: [] };
  const token = readAccessToken(override);
  if (!token) return { ...empty, fetchedAtSec: nowSec, state: "no-credentials" };

  const resp = await resilientFetch(USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": CRED_BETA,
      "content-type": "application/json",
      "accept-encoding": "identity",
    },
  });
  if (!resp) {
    return { ...empty, fetchedAtSec: nowSec, state: "error", detail: "no response (connect timeout / network)" };
  }
  if (resp.status === 429) {
    return { ...empty, fetchedAtSec: nowSec, state: "rate-limited", detail: resp.header("retry-after") || "" };
  }
  if (resp.status < 200 || resp.status >= 300) {
    return { ...empty, fetchedAtSec: nowSec, state: "error", detail: `http ${resp.status}` };
  }
  let body: any;
  try {
    body = JSON.parse(resp.body);
  } catch {
    return { ...empty, fetchedAtSec: nowSec, state: "error", detail: "bad json" };
  }
  const windows = parseUsageBody(body);
  if (!hasUsageWindows(windows)) {
    // 200 but nothing we recognise (API-key session, plan without windows, or a
    // changed shape) → an honest failure, so the header poll stays in charge.
    return { ...empty, fetchedAtSec: nowSec, state: "error", detail: "no windows in payload" };
  }
  return { ...windows, fetchedAtSec: nowSec, state: "ok" };
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
      "accept-encoding": "identity",
    },
  });
  if (!resp) {
    return { id, maxInputTokens: null, fetchedAtSec: nowSec, state: "error", detail: "no response (connect timeout / network)" };
  }
  if (resp.status < 200 || resp.status >= 300) {
    return { id, maxInputTokens: null, fetchedAtSec: nowSec, state: "error", detail: `http ${resp.status}` };
  }
  let obj: any;
  try {
    obj = JSON.parse(resp.body);
  } catch {
    return { id, maxInputTokens: null, fetchedAtSec: nowSec, state: "error", detail: "bad json" };
  }
  const lim = obj?.max_input_tokens;
  if (typeof lim !== "number" || !Number.isFinite(lim) || lim <= 0) {
    return { id, maxInputTokens: null, fetchedAtSec: nowSec, state: "error", detail: "no max_input_tokens" };
  }
  // Same response also carries Anthropic's own display name ("Claude Opus 5") —
  // free, no extra request. Used for the status-bar model label; absence is
  // harmless (the label is then derived from the id, fully offline).
  const display = typeof obj?.display_name === "string" && obj.display_name.trim() ? obj.display_name.trim() : null;
  return { id, maxInputTokens: lim, displayName: display, fetchedAtSec: nowSec, state: "ok" };
}

/** Smallest gap between two FORCED polls. A forced poll is an explicit human
 *  action (clicking the status-bar item), so it overrides every automatic gate —
 *  but a double-click must not become a request burst, hence this floor. */
export const FORCE_MIN_GAP_SEC = 10;

/** Upper bound on a 429 backoff for the FREE usage route.
 *
 *  The documented header route honours `Retry-After` verbatim — it spends
 *  tokens, so being told to wait an hour is a fair instruction to obey. The
 *  usage route is an undocumented plain GET, and the only two 429s we have ever
 *  observed on it both arrived in the same second as a 401 on the header route,
 *  i.e. while the on-disk OAuth token was expired — an auth rejection, not a
 *  volume one. Obeying its `Retry-After: 3600` therefore blanked the whole
 *  feature for an hour over a token the CLI refreshed 47 seconds later. We still
 *  back off — just not past the point where the backoff is worse than the
 *  problem. */
export const USAGE_BACKOFF_MAX_SEC = 15 * 60;

/** When a 429 backoff should end: the server's `Retry-After`, floored at our own
 *  poll interval (never hammer) and capped at `maxSec` (never disappear). Pure. */
export function backoffUntil(
  nowSec: number,
  retryAfterSec: number,
  minSec: number,
  maxSec: number = Number.POSITIVE_INFINITY
): number {
  const asked = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 0;
  return nowSec + Math.min(Math.max(asked, minSec), maxSec);
}

/** Throttle gate for the PAID header poll: enough time passed AND the session
 *  was active recently. The activity condition is what keeps an idle editor from
 *  spending a token every few minutes on a number that cannot have moved.
 *
 *  `throttleSec` is the minimum gap between polls — the caller shortens it after
 *  a FAILED poll so a flaky link (where the request times out but recovers
 *  seconds later) is retried in ~a minute instead of staying stale for the full
 *  poll interval. `activityWindowSec` (defaults to throttleSec for backward
 *  compatibility) is kept at the NORMAL interval so shortening the retry gap
 *  does not also shrink the "is the user active?" window.
 *
 *  `forced` = the user clicked the item. It bypasses the throttle, the activity
 *  window AND the backoff, because a gate the user cannot override is not a
 *  refresh button — it just repaints the same stale numbers. */
export function shouldPoll(
  lastFetchSec: number,
  nowSec: number,
  throttleSec: number,
  lastActivityMs: number,
  rateLimitedUntilSec: number,
  activityWindowSec: number = throttleSec,
  forced = false
): boolean {
  if (forced) return nowSec - lastFetchSec >= FORCE_MIN_GAP_SEC;
  if (nowSec < rateLimitedUntilSec) return false; // backing off after a 429
  if (nowSec - lastFetchSec < throttleSec) return false;
  const activeRecently = lastActivityMs > 0 && Date.now() - lastActivityMs < activityWindowSec * 1000;
  return activeRecently;
}

/** Throttle gate for the FREE usage route — deliberately WITHOUT the activity
 *  condition above.
 *
 *  That condition exists to avoid spending tokens on an idle editor. This route
 *  is a plain GET: it generates no message and costs ZERO tokens, so the reason
 *  never applied to it — it was inherited by sharing the paid route's gate. And
 *  the cost of keeping it is exactly the failure it was never meant to cause:
 *  the numbers freeze the moment the human stops typing, which is precisely when
 *  a long autonomous run is burning the quota they are trying to watch.
 *
 *  So: poll on a fixed cadence, idle or not. Pure. */
export function shouldPollFree(
  lastFetchSec: number,
  nowSec: number,
  throttleSec: number,
  backoffUntilSec: number,
  forced = false
): boolean {
  if (forced) return nowSec - lastFetchSec >= FORCE_MIN_GAP_SEC;
  if (nowSec < backoffUntilSec) return false; // backing off after a 429
  return nowSec - lastFetchSec >= throttleSec;
}

/** Whether SOME reading is currently doing the header poll's job — it is recent
 *  and it carries the 5h/7d windows. While that holds, the 1-token message poll
 *  is skipped entirely.
 *
 *  Deliberately takes loose parts rather than a UsageResult: the qualifying
 *  reading may equally be one THIS window fetched or one another window fetched
 *  and shared. Judging only our own would have every extra editor window fall
 *  back to the paid poll while a perfectly good free reading sat in the shared
 *  file — N-1 paid requests per interval to learn a number already on disk.
 *  Pure. */
export function coversQuota(
  fiveH: QuotaWindow | null,
  sevenD: QuotaWindow | null,
  atSec: number,
  nowSec: number,
  maxAgeSec: number
): boolean {
  if (!fiveH && !sevenD) return false;
  if (atSec <= 0) return false;
  return nowSec - atSec < maxAgeSec;
}

/** The above, for a reading this window fetched itself. Pure. */
export function usageCoversQuota(usage: UsageResult | null, nowSec: number, maxAgeSec: number): boolean {
  if (!usage || usage.state !== "ok") return false;
  return coversQuota(usage.fiveH, usage.sevenD, usage.fetchedAtSec, nowSec, maxAgeSec);
}

/** `Retry-After` → seconds to wait. The header has TWO legal forms and only one
 *  of them is a number: an HTTP-date is equally valid, and running it through
 *  `Number()` yields NaN, i.e. "the server asked for nothing" — so we would have
 *  retried a route that had just told us to wait until a specific time. Returns
 *  0 when the header is absent or unparseable, which the caller floors at its
 *  own interval. Pure. */
export function parseRetryAfterSec(raw: unknown, nowSec: number): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
  if (typeof raw !== "string" || !raw.trim()) return 0;
  const s = raw.trim();
  const delta = Number(s);
  if (Number.isFinite(delta)) return Math.max(0, Math.round(delta));
  const atMs = Date.parse(s);
  return Number.isFinite(atMs) ? Math.max(0, Math.round(atMs / 1000) - nowSec) : 0;
}

/** Seconds to wait before retrying after a FAILED poll (timeout / network). Much
 *  shorter than the normal interval so an intermittent link is caught quickly,
 *  but long enough not to hammer a down link. */
export const FAIL_RETRY_SEC = 45;
