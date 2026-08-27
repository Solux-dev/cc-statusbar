// The context window and the cache section, plus the transport rules the
// quota poll leans on.
//
// Lifted out of logic.test.ts unchanged and in order — no test was renamed,
// reordered, or rewritten in the move.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WINDOW_5H_SECONDS } from "../metrics";
import { buildView, buildPanelHtml } from "../render";
import { attemptTimeoutsMs, isRetryableStatus } from "../quota";
import { projectSlug } from "../transcript";
import { W, ctxTotals } from "./fixtures";

test("buildView: context segment in collapsed bar + line in tooltip (en)", () => {
  const v = buildView(ctxTotals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en", {
    usedTokens: 468_000,
    limitTokens: 1_000_000,
    limitState: "ok",
  });
  // 468k / 1M = 47% → in the 40–60% band → 🟡: time to look for a good stopping
  // point, long before the window is actually full
  assert.match(v.text, /· 🟡 ctx 47%$/);
  assert.ok(!/🔴/.test(v.text), "47% is a heads-up, not the last call");
  assert.match(v.tooltip, /- context: 47% \(468k \/ 1M\)/);
});

test("buildView: context segment in collapsed bar (ru) appended after tariff", () => {
  const now = 1000;
  const v = buildView(ctxTotals, W, {
    state: "ok",
    fiveH: { pct: 24, resetAt: now + WINDOW_5H_SECONDS * 0.5 },
    sevenD: { pct: 41, resetAt: now + 7 * 86400 * 0.4 },
  }, now, "ru", { usedTokens: 468_000, limitTokens: 1_000_000, limitState: "ok" });
  assert.match(v.text, /🟢 5ч 24%/);
  assert.match(v.text, /· 🟡 конт 47%$/);
  assert.match(v.tooltip, /контекст: 47% \(468k \/ 1M\)/);
});

test("buildView: a coloured context dot is informational — does NOT change item level", () => {
  const v = buildView(ctxTotals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en", {
    usedTokens: 600_000,
    limitTokens: 1_000_000,
    limitState: "ok",
  });
  assert.match(v.text, /🔴 ctx 60%/);
  // item background stays tariff-pace; context fill must NOT drive it
  assert.equal(v.level, "normal");
});

test("buildView: context ≥60% → 🔴 dot, still does not tint the bar", () => {
  const v = buildView(ctxTotals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en", {
    usedTokens: 350_000,
    limitTokens: 1_000_000,
    limitState: "ok",
  });
  assert.match(v.text, /🟢 ctx 35%/, "35% is still comfortable");
  const hot = buildView(ctxTotals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en", {
    usedTokens: 970_000,
    limitTokens: 1_000_000,
    limitState: "ok",
  });
  assert.match(hot.text, /🔴 ctx 97%/);
  assert.equal(v.level, "normal");
});

test("buildView: the hover speaks the same words as the panel — no 'tier'", () => {
  // The panel row was reworded in 1.0.24 and this line was missed, so the same
  // fact was called "Cache stays warm" in one place and "1-hour tier" in the
  // other. One vocabulary, or the reader thinks they are two different things.
  const base = { state: "disabled" as const, fiveH: null, sevenD: null };
  const v1h = buildView(ctxTotals, W, base, 1000, "en", undefined, { tier: "1h", hitRatePct: 82 });
  assert.match(v1h.tooltip, /Cache stays warm — 1 hour idle/);
  assert.ok(!/tier/i.test(v1h.tooltip), "the jargon is gone from the hover too");
  const v5m = buildView(ctxTotals, W, base, 1000, "ru", undefined, { tier: "5m", hitRatePct: 40 });
  assert.match(v5m.tooltip, /Кэш держится — 5 минут простоя/);
  assert.ok(!/тир/i.test(v5m.tooltip), "и в русском тоже");
  const none = buildView(ctxTotals, W, base, 1000, "en", undefined, { tier: null, hitRatePct: null });
  assert.ok(!/Cache stays warm/.test(none.tooltip), "no tier → no cache line");
});

test("buildPanelHtml: cache section — tier + hit rate + hover footnotes; hidden when empty", () => {
  const base = { state: "disabled" as const, fiveH: null, sevenD: null };
  const html = buildPanelHtml(ctxTotals, W, base, 1000, "en", undefined, { tier: "1h", hitRatePct: 82 });
  assert.match(html, />Cache</);
  assert.match(html, /1-hour/);
  assert.match(html, /Input from cache/);
  assert.match(html, /<b>82%<\/b>/);
  // themed CSS tooltip (not native title=, which ignores dark mode)
  assert.match(html, /class="tip">[^<]*prompt cache stays warm/, "tier footnote in themed tooltip");
  assert.match(html, /class="tip">[^<]*served from cache/, "hit-rate footnote in themed tooltip");
  assert.ok(!/title=/.test(html), "no native title attribute (uses themeable CSS tooltip)");
  const none = buildPanelHtml(ctxTotals, W, base, 1000, "en", undefined, { tier: null, hitRatePct: null });
  assert.ok(!/>Cache</.test(none), "no cache data → no cache header");
});

test("buildView: limit unavailable → used shown in tooltip, NO % in bar (fail-visibly)", () => {
  const v = buildView(ctxTotals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en", {
    usedTokens: 468_000,
    limitTokens: null,
    limitState: "unavailable",
  });
  assert.ok(!/ctx/.test(v.text), "no context % in the collapsed bar without a limit");
  assert.match(v.tooltip, /context: 468k \(limit n\/a\)/);
});

test("buildView: limit unavailable WITH a reason → shows it for diagnosability", () => {
  const v = buildView(ctxTotals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en", {
    usedTokens: 468_000,
    limitTokens: null,
    limitState: "unavailable",
    limitDetail: "http 403",
  });
  assert.match(v.tooltip, /context: 468k \(limit n\/a — http 403\)/);
});

test("buildView: limit pending → context hidden everywhere (no flicker)", () => {
  const v = buildView(ctxTotals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en", {
    usedTokens: 468_000,
    limitTokens: null,
    limitState: "pending",
  });
  assert.ok(!/ctx/.test(v.text));
  assert.ok(!/context:/.test(v.tooltip), "pending limit shows nothing yet");
});

test("buildView: no context arg → no context anywhere (backward compatible)", () => {
  const v = buildView(ctxTotals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en");
  assert.ok(!/ctx/.test(v.text));
  assert.ok(!/context:/.test(v.tooltip));
});

test("buildPanelHtml: context line rendered when limit known (both langs)", () => {
  const now = 1000;
  const q = { state: "ok" as const, fiveH: { pct: 24, resetAt: now + WINDOW_5H_SECONDS * 0.5 }, sevenD: null };
  const ctx = { usedTokens: 468_000, limitTokens: 1_000_000, limitState: "ok" as const };
  const en = buildPanelHtml(ctxTotals, W, q, now, "en", ctx);
  assert.match(en, /context: 47% \(468k \/ 1M\)/);
  const ru = buildPanelHtml(ctxTotals, W, q, now, "ru", ctx);
  assert.match(ru, /контекст: 47% \(468k \/ 1M\)/);
});

test("attemptTimeoutsMs: escalating schedule, no RTT history → base", () => {
  assert.deepEqual(attemptTimeoutsMs(0), [6000, 14000, 22000]);
  assert.deepEqual(attemptTimeoutsMs(), [6000, 14000, 22000]);
  // strictly increasing so each retry is more patient than the last
  const s = attemptTimeoutsMs(0);
  assert.ok(s[0] < s[1] && s[1] < s[2]);
});

test("attemptTimeoutsMs: adapts to a slow link by flooring attempts at ~2× last RTT", () => {
  // last round-trip 8s → floor 16s: the short first attempt is lifted, not wasted
  assert.deepEqual(attemptTimeoutsMs(8000), [16000, 16000, 22000]);
  // a fast link (1s) leaves the base schedule untouched
  assert.deepEqual(attemptTimeoutsMs(1000), [6000, 14000, 22000]);
  // floor is capped at 30s so a pathological sample can't blow up the budget
  assert.deepEqual(attemptTimeoutsMs(60000), [30000, 30000, 30000]);
});

test("isRetryableStatus: transient (timeouts/5xx) retried, auth/4xx not", () => {
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(502), true);
  assert.equal(isRetryableStatus(529), true); // Anthropic "overloaded"
  assert.equal(isRetryableStatus(408), true);
  assert.equal(isRetryableStatus(425), true);
  assert.equal(isRetryableStatus(401), false); // auth — retry won't help
  assert.equal(isRetryableStatus(403), false);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(200), false);
});

test("buildView: over pace yields over level (item color)", () => {
  const now = 1000;
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const v = buildView(totals, W, {
    state: "ok",
    fiveH: { pct: 30, resetAt: now + WINDOW_5H_SECONDS * 0.75 }, // 25% elapsed → over
    sevenD: null,
  }, now, "en");
  assert.equal(v.level, "over");
});

test("projectSlug: replaces every non-alphanumeric char (incl. spaces) like Claude Code", () => {
  // regression: a space in the folder name must collapse to '-' so the session
  // dir is found. Was the bug behind "extension shows nothing" on "Kasta Rico".
  assert.equal(
    projectSlug("c:\\Users\\Honor\\Desktop\\My_Projects\\Kasta Rico"),
    "c--Users-Honor-Desktop-My-Projects-Kasta-Rico"
  );
  assert.equal(
    projectSlug("c:\\Users\\Honor\\Desktop\\My Projects\\ACME - Billing_v2.1"),
    "c--Users-Honor-Desktop-My-Projects-ACME---Billing-v2-1"
  );
  // existing space-free paths must be unchanged (no regression).
  assert.equal(
    projectSlug("c:\\Users\\Honor\\Desktop\\My_Projects\\cc-statusbar"),
    "c--Users-Honor-Desktop-My-Projects-cc-statusbar"
  );
});
