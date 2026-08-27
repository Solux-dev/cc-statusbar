// Quota: the four sources it can come from, when we may poll, what an aged or
// missing reading is allowed to say, and the bar it produces.
//
// Lifted out of logic.test.ts unchanged and in order — no test was renamed,
// reordered, or rewritten in the move.

import { test } from "node:test";
import assert from "node:assert/strict";
import { knownModelWindow, WINDOW_5H_SECONDS } from "../metrics";
import { buildView, buildPanelHtml } from "../render";
import { parseLocalQuota, windowFromBridge } from "../localQuota";
import {
  parseCachedUsage,
  parseUsageBody,
  hasUsageWindows,
  scopedWindowFromLimit,
  windowFromUsage,
  toUnixSec,
} from "../usage";
import { resolveLang } from "../i18n";
import {
  backoffUntil,
  coversQuota,
  parseRetryAfterSec,
  resolveCredentialsPath,
  shouldPoll,
  shouldPollFree,
  usageCoversQuota,
  FAIL_RETRY_SEC,
  FORCE_MIN_GAP_SEC,
  USAGE_BACKOFF_MAX_SEC,
} from "../quota";
import {
  accountKey,
  claimUsagePoll,
  parseSharedUsage,
  readSharedUsage,
  releaseUsagePoll,
  sharePath,
  usableSharedAtSec,
  writeSharedUsage,
} from "../usageShare";
import { W } from "./fixtures";

test("resolveLang: explicit overrides, auto follows locale", () => {
  assert.equal(resolveLang("en", "ru"), "en");
  assert.equal(resolveLang("ru", "en-US"), "ru");
  assert.equal(resolveLang("auto", "ru"), "ru");
  assert.equal(resolveLang("auto", "ru-RU"), "ru");
  assert.equal(resolveLang("auto", "en-US"), "en");
  assert.equal(resolveLang("auto", ""), "en");
  assert.equal(resolveLang("auto", "fr"), "en");
});

test("buildView (ru): ok state shows tariff-only bar (dots + 5ч/7д), эфф in tooltip", () => {
  const now = 1000;
  const totals = { input: 50000, output: 150000, work: 200000, cacheRead: 10_000_000, cacheWrite: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 1_000_000 };
  const v = buildView(totals, W, {
    state: "ok",
    fiveH: { pct: 24, resetAt: now + WINDOW_5H_SECONDS * 0.5 },
    sevenD: { pct: 41, resetAt: now + 7 * 86400 * 0.4 },
  }, now, "ru");
  // collapsed bar: tariff only, with colored dot + reset countdown, NO эфф
  assert.match(v.text, /🟢 5ч 24%/);
  assert.match(v.text, /7д 41%/);
  assert.ok(!/эфф/.test(v.text), "effective must NOT be in collapsed bar");
  // cost-first headline. Round 19: the comparison word describes the figure it
  // FOLLOWS — the without-cache one — the same subject both panels use.
  assert.match(v.tooltip, /токен-эквивалент с кэшем ≈ \*\*2\.5M\*\* · без кэша ≈ \*\*11\.2M\*\* \(в ~4\.6× больше\)/);
  // muted technical breakdown line still present
  assert.match(v.tooltip, /обычные ввод\+вывод 200k · кэш: чтение 10M \/ запись 1M/);
});

test("buildView (en): ok state, english bar + tooltip", () => {
  const now = 1000;
  const totals = { input: 50000, output: 150000, work: 200000, cacheRead: 10_000_000, cacheWrite: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 1_000_000 };
  const v = buildView(totals, W, {
    state: "ok",
    fiveH: { pct: 24, resetAt: now + WINDOW_5H_SECONDS * 0.5 },
    sevenD: { pct: 41, resetAt: now + 7 * 86400 * 0.4 },
  }, now, "en");
  assert.match(v.text, /🟢 5h 24%/);
  assert.match(v.text, /7d 41%/);
  assert.match(v.tooltip, /token-equivalent with cache ≈ \*\*2\.5M\*\* · without cache ≈ \*\*11\.2M\*\* \(~4\.6× more\)/);
  assert.match(v.tooltip, /ordinary in\+out 200k · cache: read 10M \/ write 1M/);
  assert.match(v.tooltip, /Subscription quota/);
  assert.match(v.tooltip, /on track/);
});

test("buildView (en): default lang is english", () => {
  const totals = { input: 5000, output: 8000, work: 13000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000);
  assert.match(v.text, /eff/);
  assert.match(v.tooltip, /session usage/);
});

test("buildView (en): disabled state falls back to eff in bar, normal level", () => {
  const totals = { input: 5000, output: 8000, work: 13000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en");
  assert.match(v.text, /eff/);
  assert.equal(v.level, "normal");
  assert.match(v.tooltip, /polling is off/);
});

test("buildView (ru): disabled state falls back to эфф in bar", () => {
  const totals = { input: 5000, output: 8000, work: 13000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru");
  assert.match(v.text, /эфф/);
  assert.match(v.tooltip, /опрос выключен/);
});

test("buildView: quota fetch error → visible offline marker + local eff still shown (both langs)", () => {
  const totals = { input: 5000, output: 8000, work: 13000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const en = buildView(totals, W, { state: "error", fiveH: null, sevenD: null }, 1000, "en");
  assert.match(en.text, /cloud-offline/); // marker icon present
  assert.match(en.text, /quota offline/);
  assert.match(en.text, /eff/); // local token-equivalent kept beside it — never blank
  assert.equal(en.level, "normal"); // a connectivity blip must NOT tint the item
  const ru = buildView(totals, W, { state: "error", fiveH: null, sevenD: null }, 1000, "ru");
  assert.match(ru.text, /лимиты офлайн/);
  assert.match(ru.text, /эфф/);
});

test("buildView: rate-limited and no-credentials get their own collapsed-bar markers", () => {
  const totals = { input: 100, output: 100, work: 200, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const limited = buildView(totals, W, { state: "rate-limited", fiveH: null, sevenD: null }, 1000, "en");
  assert.match(limited.text, /quota paused/);
  const noCreds = buildView(totals, W, { state: "no-credentials", fiveH: null, sevenD: null }, 1000, "en");
  assert.match(noCreds.text, /no token/);
});

test("buildView: disabled state stays silent (intentional off, no offline marker)", () => {
  const totals = { input: 100, output: 100, work: 200, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en");
  assert.doesNotMatch(v.text, /offline|paused|no token/);
  assert.match(v.text, /eff/);
});

test("localQuota: windowFromBridge maps used_percentage/resets_at → pct/resetAt", () => {
  const w = windowFromBridge({ used_percentage: 12, resets_at: 1782122400, status: "allowed" });
  assert.deepEqual(w, { pct: 12, resetAt: 1782122400, status: "allowed" });
  // missing/invalid % → null (never guess)
  assert.equal(windowFromBridge({ resets_at: 1 }), null);
  assert.equal(windowFromBridge(null), null);
  // a window with % but no reset is still valid (reset just unknown)
  assert.deepEqual(windowFromBridge({ used_percentage: 0 }), { pct: 0, resetAt: null, status: undefined });
});

test("localQuota: parseLocalQuota reads the statusline bridge payload", () => {
  const raw = JSON.stringify({
    writtenAtSec: 1782107243,
    rate_limits: {
      five_hour: { used_percentage: 1, resets_at: 1782122400 },
      seven_day: { used_percentage: 10, resets_at: 1782165600 },
    },
  });
  const r = parseLocalQuota(raw);
  assert.equal(r.ok, true);
  assert.equal(r.writtenAtSec, 1782107243);
  assert.equal(r.fiveH?.pct, 1);
  assert.equal(r.sevenD?.pct, 10);
});

test("localQuota: parseLocalQuota fails safe on junk / missing windows", () => {
  assert.equal(parseLocalQuota("not json").ok, false);
  assert.equal(parseLocalQuota(JSON.stringify({ writtenAtSec: 1, rate_limits: {} })).ok, false);
});

// ── the usage payload: 5h/7d + per-model weekly windows (Fable) ──────────────

/** VERBATIM shape of the live GET /api/oauth/usage body (verified 2026-07-26),
 *  which is also what Claude Code persists in ~/.claude.json. Only the
 *  `weekly_scoped` rows are per-model. */
const USAGE_BODY = {
  five_hour: { utilization: 3, resets_at: "2026-07-25T22:40:01.007784+00:00", limit_dollars: null },
  seven_day: { utilization: 73, resets_at: "2026-07-28T13:00:01.007829+00:00", limit_dollars: null },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false },
  limits: [
    { kind: "session", group: "session", percent: 3, resets_at: "2026-07-25T22:40:01Z", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 73, resets_at: "2026-07-28T13:00:01Z", scope: null },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 91,
      severity: "critical",
      resets_at: "2026-07-28T13:00:01.008052+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: true,
    },
  ],
};

/** The same body as the CLI caches it: wrapped with its fetch timestamp. */
const USAGE_CACHE = JSON.stringify({
  cachedUsageUtilization: { fetchedAtMs: 1_784_987_462_966, accountUuid: "acc-1", utilization: USAGE_BODY },
});

test("usage: parseUsageBody reads 5h, 7d and ONLY the model-scoped weekly rows", () => {
  const u = parseUsageBody(USAGE_BODY);
  assert.equal(u.fiveH?.pct, 3);
  assert.equal(u.sevenD?.pct, 73);
  assert.equal(u.fiveH?.resetAt, Math.round(Date.parse("2026-07-25T22:40:01.007784+00:00") / 1000));
  assert.equal(u.scoped.length, 1); // session / weekly_all are NOT model-scoped
  assert.equal(u.scoped[0].label, "Fable");
  assert.equal(u.scoped[0].pct, 91);
  assert.equal(u.scoped[0].resetAt, Math.round(Date.parse("2026-07-28T13:00:01.008052+00:00") / 1000));
});

test("usage: an unreadable payload yields nothing rather than a guessed 0%", () => {
  assert.equal(hasUsageWindows(parseUsageBody(null)), false);
  assert.equal(hasUsageWindows(parseUsageBody({})), false);
  assert.equal(hasUsageWindows(parseUsageBody({ limits: "not an array" })), false);
  // a window whose percentage is missing is hidden, not zeroed
  assert.equal(windowFromUsage({ resets_at: "2026-07-28T13:00:00Z" }), null);
  assert.equal(windowFromUsage(null), null);
  assert.deepEqual(windowFromUsage({ utilization: 0 }), { pct: 0, resetAt: null });
});

test("usage: parseCachedUsage unwraps the CLI's on-disk copy with its fetch time", () => {
  const r = parseCachedUsage(USAGE_CACHE);
  assert.equal(r.ok, true);
  assert.equal(r.fetchedAtSec, 1_784_987_463); // ms → s, rounded
  assert.equal(r.sevenD?.pct, 73);
  assert.equal(r.scoped[0].label, "Fable");
});

test("usage: parseCachedUsage fails safe on junk, a missing cache, or a new shape", () => {
  assert.equal(parseCachedUsage("not json").ok, false);
  assert.equal(parseCachedUsage("{}").ok, false); // no cachedUsageUtilization (older CLI)
  assert.equal(parseCachedUsage(JSON.stringify({ cachedUsageUtilization: { utilization: {} } })).ok, false);
});

test("usage: a nameless or percent-less row is dropped, never shown as 0%", () => {
  const base = { kind: "weekly_scoped", percent: 50, scope: { model: { display_name: "Fable" } } };
  assert.equal(scopedWindowFromLimit(base)?.pct, 50);
  assert.equal(scopedWindowFromLimit({ ...base, percent: null }), null);
  assert.equal(scopedWindowFromLimit({ ...base, scope: { model: {} } }), null);
  assert.equal(scopedWindowFromLimit({ ...base, kind: "weekly_all" }), null);
  assert.equal(scopedWindowFromLimit(null), null);
  // reset is optional — a window without one is still usable
  assert.equal(scopedWindowFromLimit(base)?.resetAt, null);
});

test("usage: toUnixSec accepts the ISO strings limits[] uses and raw seconds", () => {
  assert.equal(toUnixSec("2026-07-28T13:00:00Z"), 1785243600);
  assert.equal(toUnixSec(1785243600), 1785243600);
  assert.equal(toUnixSec("not a date"), null);
  assert.equal(toUnixSec("" as any), null);
  assert.equal(toUnixSec(null), null);
});

test("usageCoversQuota: the paid header poll is skipped ONLY while the free one delivers", () => {
  const now = 1_000_000;
  const ok = { ...parseUsageBody(USAGE_BODY), fetchedAtSec: now - 60, state: "ok" as const };
  // fresh payload carrying 5h/7d → the 1-token poll is redundant
  assert.equal(usageCoversQuota(ok, now, 600), true);
  // ...but it resumes the moment the payload is stale, failed, or windowless
  assert.equal(usageCoversQuota({ ...ok, fetchedAtSec: now - 900 }, now, 600), false);
  assert.equal(usageCoversQuota({ ...ok, state: "error" }, now, 600), false);
  assert.equal(usageCoversQuota({ ...ok, fiveH: null, sevenD: null }, now, 600), false);
  // a payload that only carried the Fable row must NOT suppress the poll:
  // 5h/7d would silently stop updating
  assert.equal(usageCoversQuota({ ...ok, fiveH: null, sevenD: null, scoped: ok.scoped }, now, 600), false);
  assert.equal(usageCoversQuota(null, now, 600), false);
});

test("buildView: the Fable weekly row lands in the tooltip and NEVER in the bar", () => {
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const now = 1_000_000;
  const q = {
    state: "ok" as const,
    fiveH: { pct: 7, resetAt: now + WINDOW_5H_SECONDS },
    sevenD: { pct: 67, resetAt: now + 7 * 86400 },
    asOfSec: now - 5,
    scoped: [{ label: "Fable", pct: 82, resetAt: now + 2 * 86400 }],
    scopedAsOfSec: now - 60,
  };
  const en = buildView(totals, W, q, now, "en");
  assert.match(en.tooltip, /Fable \(7d\).*82%/);
  assert.doesNotMatch(en.text, /Fable/); // collapsed bar stays tariff-only
  assert.doesNotMatch(en.text, /82%/);
  // a per-model window must not tint the item either — it is informational here
  assert.equal(en.level, "normal");
  const ru = buildView(totals, W, q, now, "ru");
  assert.match(ru.tooltip, /Fable \(7д\).*82%/);
  // fresh reading (< 15 min) → no age suffix
  assert.doesNotMatch(en.tooltip, /read .* ago/);
});

test("buildView: an aged Fable row states its age; a day-old one is dropped", () => {
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const now = 1_000_000;
  const q = (scopedAsOfSec: number) => ({
    state: "ok" as const,
    fiveH: { pct: 7, resetAt: now + WINDOW_5H_SECONDS },
    sevenD: null,
    asOfSec: now - 5,
    scoped: [{ label: "Fable", pct: 82, resetAt: now + 2 * 86400 }],
    scopedAsOfSec,
  });
  // 4h old: still shown (a weekly % moves slowly) but explicitly dated
  const aged = buildView(totals, W, q(now - 4 * 3600), now, "en");
  assert.match(aged.tooltip, /Fable \(7d\).*82%.*read .* ago/);
  assert.match(buildView(totals, W, q(now - 4 * 3600), now, "ru").tooltip, /данные .* назад/);
  // 30h old: could be wrong by a whole working day → hidden, not guessed
  assert.doesNotMatch(buildView(totals, W, q(now - 30 * 3600), now, "en").tooltip, /Fable/);
  // unknown age is treated the same as too old
  assert.doesNotMatch(buildView(totals, W, q(0), now, "en").tooltip, /Fable/);
});

test("buildView/buildPanelHtml: the Fable row survives a dead 5h/7d poll", () => {
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const now = 1_000_000;
  const q = {
    state: "error" as const,
    fiveH: null,
    sevenD: null,
    scoped: [{ label: "Fable", pct: 82, resetAt: now + 2 * 86400 }],
    scopedAsOfSec: now - 120,
  };
  // independent source: the 5h/7d failure says nothing about this number
  assert.match(buildView(totals, W, q, now, "en").tooltip, /Fable \(7d\).*82%/);
  assert.match(buildPanelHtml(totals, W, q, now, "en"), /Fable \(7d\)/);
});

test("buildPanelHtml: the Fable row renders with a bar and an explanatory footnote", () => {
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const now = 1_000_000;
  const html = buildPanelHtml(
    totals,
    W,
    {
      state: "ok",
      fiveH: { pct: 7, resetAt: now + WINDOW_5H_SECONDS },
      sevenD: { pct: 67, resetAt: now + 7 * 86400 },
      asOfSec: now - 5,
      scoped: [{ label: "Fable", pct: 82, resetAt: now + 2 * 86400 }],
      scopedAsOfSec: now - 5,
    },
    now,
    "ru"
  );
  assert.match(html, /Fable \(7д\)/);
  assert.match(html, /width:82%/);
  assert.match(html, /title="Недельное окно для одной модели/);
});

test("buildView: last-known reading shows an 'updated N ago' note when aged (both langs)", () => {
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const now = 1_000_000;
  const okAged = {
    state: "ok" as const,
    fiveH: { pct: 12, resetAt: now + WINDOW_5H_SECONDS },
    sevenD: null,
    asOfSec: now - 600, // 10 min old
  };
  assert.match(buildView(totals, W, okAged, now, "en").tooltip, /Updated .* ago/);
  assert.match(buildView(totals, W, okAged, now, "ru").tooltip, /Обновлено .* назад/);
  // fresh reading (age < 60s) → no note (avoids "updated 0 ago" noise)
  const okFresh = { ...okAged, asOfSec: now - 5 };
  assert.doesNotMatch(buildView(totals, W, okFresh, now, "en").tooltip, /Updated/);
});

test("shouldPoll: shorter throttle after a failure still gated by activity window", () => {
  const now = 1_000_000;
  const active = Date.now(); // transcript just touched
  // 50s since last fetch: blocked at the normal 300s throttle...
  assert.equal(shouldPoll(now - 50, now, 300, active, 0), false);
  // ...but allowed at the shortened fail-retry throttle (45s), with the activity
  // window kept at the normal 300s so the short gap doesn't shrink "is active".
  assert.equal(shouldPoll(now - 50, now, FAIL_RETRY_SEC, active, 0, 300), true);
  // idle (no recent activity) → still no poll even on the short retry gap
  assert.equal(shouldPoll(now - 50, now, FAIL_RETRY_SEC, Date.now() - 10 * 60 * 1000, 0, 300), false);
});

test("shouldPoll: a click overrides the activity window, the throttle AND the backoff", () => {
  const now = 1_000_000;
  const idle = Date.now() - 40 * 60 * 1000; // away from the keyboard for 40 min
  // This is the whole bug the flag exists for: the user clicks BECAUSE the
  // number looks stale, and staleness implies idleness, so the gate swallowed
  // every click that could ever have mattered.
  assert.equal(shouldPoll(now - 5, now, 300, idle, 0, 300), false);
  assert.equal(shouldPoll(now - 300, now, 300, idle, now + 3600, 300, true), true);
  // ...but a double-click is not a request burst: the anti-spam floor holds.
  assert.equal(shouldPoll(now - (FORCE_MIN_GAP_SEC - 1), now, 300, idle, 0, 300, true), false);
  assert.equal(shouldPoll(now - FORCE_MIN_GAP_SEC, now, 300, idle, 0, 300, true), true);
});

test("shouldPollFree: the zero-token route polls on cadence whether or not the user is active", () => {
  const now = 1_000_000;
  // No activity argument exists at all — that is the point. Idle for hours, the
  // 5h/7d numbers still refresh every interval, which is what makes a glance at
  // the bar during a long autonomous run mean anything.
  assert.equal(shouldPollFree(now - 300, now, 300, 0), true);
  assert.equal(shouldPollFree(now - 299, now, 300, 0), false); // throttle still holds
  // a 429 backoff silences it until it expires...
  assert.equal(shouldPollFree(now - 600, now, 300, now + 60), false);
  assert.equal(shouldPollFree(now - 600, now, 300, now - 1), true);
  // ...unless the user asks explicitly.
  assert.equal(shouldPollFree(now - 600, now, 300, now + 3600, true), true);
  assert.equal(shouldPollFree(now - 1, now, 300, 0, true), false); // anti-spam floor
});

test("backoffUntil: floored at our interval, and capped only where a cap is asked for", () => {
  const now = 1_000_000;
  // Server asks for less than our own cadence → we wait our cadence anyway.
  assert.equal(backoffUntil(now, 10, 300), now + 300);
  // Missing/garbage Retry-After → same floor, never a zero-length backoff.
  assert.equal(backoffUntil(now, NaN, 300), now + 300);
  assert.equal(backoffUntil(now, 0, 300), now + 300);
  // The PAID route honours an hour verbatim: no cap passed.
  assert.equal(backoffUntil(now, 3600, 300), now + 3600);
  // The FREE route caps it — this exact case (Retry-After: 3600 alongside an
  // expired token) is what blanked the feature for an hour.
  assert.equal(backoffUntil(now, 3600, 300, USAGE_BACKOFF_MAX_SEC), now + USAGE_BACKOFF_MAX_SEC);
});

test("parseSharedUsage: another window's reading is validated, never trusted", () => {
  const good = parseSharedUsage(
    JSON.stringify({
      fiveH: { pct: 12, resetAt: 1_700_000_000 },
      sevenD: { pct: 68, resetAt: null },
      scoped: [{ label: "Fable", pct: 80, resetAt: 1_700_000_000 }],
      fetchedAtSec: 1_699_999_000,
    })
  );
  assert.equal(good.ok, true);
  assert.equal(good.fiveH?.pct, 12);
  assert.equal(good.sevenD?.resetAt, null);
  assert.deepEqual(good.scoped, [{ label: "Fable", pct: 80, resetAt: 1_700_000_000 }]);

  // No clock → the reading cannot be compared against the other sources on
  // freshness, so it is worthless rather than "probably current".
  assert.equal(parseSharedUsage(JSON.stringify({ fiveH: { pct: 12 } })).ok, false);
  // Half-written / wrong-typed fields are dropped individually, not guessed.
  const partial = parseSharedUsage(JSON.stringify({ fiveH: { pct: "12" }, fetchedAtSec: 1 }));
  assert.equal(partial.fiveH, null);
  assert.equal(partial.ok, false);
  const unlabelled = parseSharedUsage(JSON.stringify({ scoped: [{ pct: 80 }], fetchedAtSec: 1 }));
  assert.deepEqual(unlabelled.scoped, []);
  // Truncated file mid-write → empty, never a throw.
  assert.equal(parseSharedUsage('{"fiveH":{"pct":1').ok, false);
  assert.equal(parseSharedUsage("").ok, false);
});

test("usableSharedAtSec: a future-dated shared reading is refused, not trusted", () => {
  const now = 1_000_000;
  const base = { fiveH: { pct: 5, resetAt: null }, sevenD: null, scoped: [], ok: true };
  assert.equal(usableSharedAtSec({ ...base, fetchedAtSec: now - 60 }, now), now - 60);
  assert.equal(usableSharedAtSec({ ...base, fetchedAtSec: now }, now), now); // same second is fine
  // A clock ahead of ours would (a) say "someone just polled" forever, freezing
  // this window's cadence, and (b) win the freshest-wins merge permanently,
  // since the winner is kept and persisted. Both are silent failures.
  assert.equal(usableSharedAtSec({ ...base, fetchedAtSec: now + 1 }, now), 0);
  assert.equal(usableSharedAtSec({ ...base, fetchedAtSec: 4_000_000_000 }, now), 0);
  assert.equal(usableSharedAtSec({ ...base, ok: false, fetchedAtSec: now - 60 }, now), 0);
});

test("coversQuota: a reading from ANOTHER window also spares the paid poll", () => {
  const now = 1_000_000;
  const w = { pct: 12, resetAt: null };
  // The point of the loose signature: this is a SHARED reading, not a
  // UsageResult. Judging coverage by our own fetch alone sent every extra editor
  // window to the paid route each interval for a number already on disk.
  assert.equal(coversQuota(w, null, now - 60, now, 600), true);
  assert.equal(coversQuota(null, w, now - 60, now, 600), true);
  // too old / no windows / no clock → the paid safety net must take over
  assert.equal(coversQuota(w, null, now - 900, now, 600), false);
  assert.equal(coversQuota(null, null, now - 60, now, 600), false);
  assert.equal(coversQuota(w, null, 0, now, 600), false);
});

test("parseRetryAfterSec: both legal header forms, and neither one guessed at", () => {
  const now = 1_700_000_000;
  assert.equal(parseRetryAfterSec("3600", now), 3600); // delta-seconds
  assert.equal(parseRetryAfterSec(120, now), 120);
  // HTTP-date — the form that used to become NaN, i.e. "the server asked for
  // nothing", so we retried a route that had named an exact time to wait for.
  assert.equal(parseRetryAfterSec(new Date((now + 300) * 1000).toUTCString(), now), 300);
  // A date already in the past means "you may retry now", not a negative wait.
  assert.equal(parseRetryAfterSec(new Date((now - 300) * 1000).toUTCString(), now), 0);
  // Absent/garbage → 0, which the caller floors at its own interval.
  assert.equal(parseRetryAfterSec("", now), 0);
  assert.equal(parseRetryAfterSec("soon", now), 0);
  assert.equal(parseRetryAfterSec(undefined, now), 0);
});

test("accountKey: two credential files never share a quota reading", () => {
  const a = resolveCredentialsPath("");
  const b = resolveCredentialsPath("D:/work/other-account/.credentials.json");
  assert.notEqual(accountKey(a), accountKey(b));
  assert.notEqual(sharePath(a), sharePath(b));
  // On Windows, different spellings of one path are one file → SAME key, or the
  // share silently fragments and every window polls for itself.
  assert.equal(
    accountKey("C:/Users/x/.claude/.credentials.json", "win32"),
    accountKey("C:\\Users\\X\\.claude\\.credentials.json", "win32")
  );
  // Elsewhere case is significant: folding it would merge two real accounts into
  // one share, which is the failure this key exists to prevent.
  assert.notEqual(
    accountKey("/home/x/.claude/.credentials.json", "linux"),
    accountKey("/home/X/.claude/.credentials.json", "linux")
  );
  // Stable across calls (it keys a file name, so drift would orphan readings).
  assert.equal(accountKey(a), accountKey(a));
  assert.match(sharePath(a), /\.cc-statusbar-usage-[0-9a-f]{16}\.json$/);
});

test("writeSharedUsage: yields to a newer reading, but never to an impossible one", () => {
  const fs = require("node:fs") as typeof import("fs");
  const os = require("node:os") as typeof import("os");
  const path = require("node:path") as typeof import("path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccsb-")), "share.json");
  const cred = "/tmp/creds.json";
  const at = 1_700_000_000;
  const win = (pct: number) => ({ fiveH: { pct, resetAt: null }, sevenD: null, scoped: [] });

  writeSharedUsage(cred, win(10), at, file);
  assert.equal(readSharedUsage(cred, file).fiveH?.pct, 10);

  // An older reading finishing late must not replace a newer one: windows
  // already running only accept fresher, but one opening next would read the
  // regressed value as the best available.
  writeSharedUsage(cred, win(20), at - 60, file);
  assert.equal(readSharedUsage(cred, file).fiveH?.pct, 10);

  // A newer one is exactly what the file is for.
  writeSharedUsage(cred, win(30), at + 60, file);
  assert.equal(readSharedUsage(cred, file).fiveH?.pct, 30);

  // A file dated in the far future is a broken clock, not a faster window.
  // Yielding to it would be PERMANENT: readers reject a future date, so the
  // share would be unusable and unrepairable at the same time.
  fs.writeFileSync(file, JSON.stringify({ ...win(99), fetchedAtSec: at + 40 * 86400 }), "utf-8");
  writeSharedUsage(cred, win(40), at + 120, file);
  assert.equal(readSharedUsage(cred, file).fiveH?.pct, 40);

  // No stray temp files left behind.
  const dir = path.dirname(file);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("claimUsagePoll: exactly one window polls, and a dead one blocks nobody", () => {
  const fs = require("node:fs") as typeof import("fs");
  const os = require("node:os") as typeof import("os");
  const path = require("node:path") as typeof import("path");
  const share = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccsb-")), "share.json");
  const cred = "/tmp/creds.json";
  const now = 1_700_000_000;

  // First window in wins; the others use what it will publish.
  const held = claimUsagePoll(cred, now, 60, share);
  assert.ok(held);
  assert.equal(claimUsagePoll(cred, now, 60, share), null);
  assert.equal(claimUsagePoll(cred, now + 59, 60, share), null);
  // A contender whose clock reads a second EARLIER must not decide the winner's
  // brand-new claim is impossible and steal it — that would defeat the claim in
  // exactly the simultaneous-start case it exists for.
  assert.equal(claimUsagePoll(cred, now - 1, 60, share), null);

  // The claim EXPIRES. A window killed mid-request must not stop the account
  // from ever polling again — the whole reason this is not a lock.
  const successor = claimUsagePoll(cred, now + 61, 60, share);
  assert.ok(successor);
  assert.notEqual(successor, held);

  // The overtaken window wakes up and releases: it must NOT remove the claim
  // that superseded it, or a third window would join the one now polling.
  releaseUsagePoll(cred, held, share);
  assert.equal(claimUsagePoll(cred, now + 62, 60, share), null);

  // Its own owner releases it, and the next interval is free again.
  releaseUsagePoll(cred, successor, share);
  assert.ok(claimUsagePoll(cred, now + 63, 60, share));

  // A claim dated far in the future is a broken clock, not a live holder;
  // honouring it would silence this account permanently.
  fs.writeFileSync(`${share}.lock`, JSON.stringify({ untilSec: now + 400 * 86400 }), "utf-8");
  assert.ok(claimUsagePoll(cred, now + 64, 60, share));

  // Garbage in the claim file is not a reason to stop polling.
  fs.writeFileSync(`${share}.lock`, "not json", "utf-8");
  assert.ok(claimUsagePoll(cred, now + 65, 60, share));
});

test("buildView: a 429 backoff is named in the tooltip, not left as a silently ageing number", () => {
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const now = 1_000_000;
  const q = {
    state: "ok" as const,
    fiveH: { pct: 12, resetAt: now + WINDOW_5H_SECONDS },
    sevenD: null,
    asOfSec: now - 600,
    pausedUntilSec: now + 12 * 60,
  };
  assert.match(buildView(totals, W, q, now, "en").tooltip, /Polling paused by the server/);
  assert.match(buildView(totals, W, q, now, "ru").tooltip, /Опрос на паузе по требованию сервера/);
  assert.match(buildPanelHtml(totals, W, q, now, "ru"), /Опрос на паузе по требованию сервера/);
  // An expired backoff says nothing — the note must not outlive the pause.
  const over = { ...q, pausedUntilSec: now - 1 };
  assert.doesNotMatch(buildView(totals, W, over, now, "en").tooltip, /paused by the server/);
  assert.doesNotMatch(buildView(totals, W, q, now, "en").text, /paused/); // bar stays clean
  // The routes back off independently: one can be paused while the other keeps
  // the number live. Announcing a pause beside a figure that is visibly current
  // would be a contradiction, not a warning.
  const live = { ...q, asOfSec: now - 30 };
  assert.doesNotMatch(buildView(totals, W, live, now, "en").tooltip, /paused by the server/);
  assert.doesNotMatch(buildPanelHtml(totals, W, live, now, "en"), /paused by the server/);
});

test("buildView: stale reading is NOT painted in the bar — neutral offline marker instead", () => {
  const totals = { input: 1000, output: 1000, work: 2000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const now = 2_000_000;
  const q = (asOfSec: number) => ({
    state: "ok" as const,
    fiveH: { pct: 80, resetAt: now + WINDOW_5H_SECONDS }, // high % that WOULD tint red if painted
    sevenD: { pct: 13, resetAt: now + 7 * 86400 },
    asOfSec,
  });
  // fresh (2 min old) → live colored % shown, no offline marker
  const live = buildView(totals, W, q(now - 120), now, "en");
  assert.match(live.text, /80%/);
  assert.doesNotMatch(live.text, /offline/);

  // stale (20 min old) → NO colored %, neutral offline marker, item not tinted
  const stale = buildView(totals, W, q(now - 20 * 60), now, "en");
  assert.match(stale.text, /offline/);
  assert.doesNotMatch(stale.text, /80%/); // the misleading colored % is gone from the bar
  assert.equal(stale.level, "normal"); // stale data must NOT drive the item color
  // ...but the last-known value + age is still available in the tooltip
  assert.match(stale.tooltip, /80%/);
  assert.match(stale.tooltip, /Updated .* ago/);
  // ru offline marker too
  assert.match(buildView(totals, W, q(now - 20 * 60), now, "ru").text, /офлайн/);
});

test("knownModelWindow: API-confirmed offline fallback windows, prefix-matched", () => {
  assert.equal(knownModelWindow("claude-opus-4-8"), 1_000_000);
  assert.equal(knownModelWindow("claude-sonnet-4-6"), 1_000_000);
  assert.equal(knownModelWindow("claude-fable-5"), 1_000_000);
  // dated id resolves via prefix
  assert.equal(knownModelWindow("claude-haiku-4-5-20251001"), 200_000);
  // unknown model / empty → null (caller relies on live API or hides %)
  assert.equal(knownModelWindow("claude-future-9-9"), null);
  assert.equal(knownModelWindow(null), null);
});

test("buildPanelHtml: stale reading shows offline + muted last-known, not a live %", () => {
  const totals = { input: 1000, output: 1000, work: 2000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const now = 3_000_000;
  const q = (asOfSec: number) => ({
    state: "ok" as const,
    fiveH: { pct: 7, resetAt: now + WINDOW_5H_SECONDS },
    sevenD: { pct: 11, resetAt: now + 7 * 86400 },
    asOfSec,
  });
  // fresh → painted quota bars present
  const live = buildPanelHtml(totals, W, q(now - 60), now, "en");
  assert.match(live, /class="bar"/);
  // stale → no painted bars; offline reason + muted "Last known" line with age
  const stale = buildPanelHtml(totals, W, q(now - 30 * 60), now, "en");
  assert.doesNotMatch(stale, /class="bar"/);
  assert.match(stale, /Last known: .*7%.*11%/);
  assert.match(stale, /updated .* ago/);
  assert.match(buildPanelHtml(totals, W, q(now - 30 * 60), now, "ru"), /Последнее известное/);
});

test("buildView: tooltip carries the switch-language command link (both langs)", () => {
  const totals = { input: 100, output: 100, work: 200, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const en = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en");
  const ru = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru");
  assert.match(en.tooltip, /\(command:ccStatusbar\.switchLanguage\)/);
  assert.match(ru.tooltip, /\(command:ccStatusbar\.switchLanguage\)/);
  assert.match(en.tooltip, /Change language/);
  assert.match(ru.tooltip, /Сменить язык/);
});

test("buildView: pace verdicts use the agreed wording", () => {
  const now = 1000;
  const tightQ = { state: "ok" as const, fiveH: { pct: 50, resetAt: now + WINDOW_5H_SECONDS * (1 - 0.52) }, sevenD: null };
  assert.match(buildView({ input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 }, W, tightQ, now, "en").tooltip, /running tight/);
  assert.match(buildView({ input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 }, W, tightQ, now, "ru").tooltip, /близко к лимиту/);
});

test("buildPanelHtml: valid doc with effective + quota (en) and localized (ru)", () => {
  const now = 1000;
  const totals = { input: 50000, output: 150000, work: 200000, cacheRead: 10_000_000, cacheWrite: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 1_000_000 };
  const q = { state: "ok" as const, fiveH: { pct: 24, resetAt: now + WINDOW_5H_SECONDS * 0.5 }, sevenD: { pct: 41, resetAt: now + 7 * 86400 * 0.4 } };
  const en = buildPanelHtml(totals, W, q, now, "en");
  assert.match(en, /^<!DOCTYPE html>/);
  assert.match(en, /Token-equivalent with cache/);
  assert.match(en, /without cache ≈ 11\.2M tok/);
  assert.match(en, /Cache saved/);
  // The ratio lives on the VISIBLE line, against the two figures it is between.
  // Inside the ⓘ it followed the saving — which is neither operand, so "the
  // saving is ~4.6× lower" than nothing in particular. Round 20.
  assert.match(en, /without cache ≈ 11\.2M tok — ~4\.6× more/);
  assert.ok(!/~4\.6× lower/.test(en));
  assert.match(en, /2\.5M/);
  assert.match(en, /11\.2M/);
  assert.match(en, /Subscription quota/);
  assert.match(en, /Details/);
  const ru = buildPanelHtml(totals, W, q, now, "ru");
  assert.match(ru, /Токен-эквивалент с кэшем/);
  assert.match(ru, /без кэша было бы ≈ 11\.2M ток/);
  assert.match(ru, /Сэкономлено кэшем/);
  assert.match(ru, /без кэша было бы ≈ 11\.2M ток — в ~4\.6× больше/);
  assert.ok(!/в ~4\.6× меньше/.test(ru));
  assert.match(ru, /Тариф/);
});

test("buildPanelHtml: escapes nothing dangerous + handles disabled quota", () => {
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const html = buildPanelHtml(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en");
  assert.ok(!/<script/i.test(html), "no script tags");
  assert.match(html, /polling is off/);
});
