import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveTokens,
  sumTranscript,
  fmtTokens,
  fmtRemaining,
  paceLevel,
  parseRateLimitHeaders,
  WINDOW_5H_SECONDS,
} from "../metrics";
import { buildView } from "../render";
import { resolveLang, messages } from "../i18n";

const W = { cacheRead: 0.1, cacheWrite: 1.25 };
const EN_UNITS = messages("en").units;
const RU_UNITS = messages("ru").units;

test("effectiveTokens: no cache equals work", () => {
  assert.equal(effectiveTokens({ input: 600, output: 400, work: 1000, cacheRead: 0, cacheWrite: 0 }, W), 1000);
});

test("effectiveTokens: combined weights", () => {
  // 200000 + 0.1*10_000_000 + 1.25*1_000_000 = 2_450_000
  const t = { input: 50000, output: 150000, work: 200000, cacheRead: 10_000_000, cacheWrite: 1_000_000 };
  assert.equal(effectiveTokens(t, W), 2_450_000);
});

test("sumTranscript: counts only assistant usage, tolerates junk line", () => {
  const raw = [
    JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } } }),
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    "{ broken json",
    JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 5 } } }),
  ].join("\n");
  const t = sumTranscript(raw);
  assert.equal(t.input, 110);
  assert.equal(t.output, 55);
  assert.equal(t.work, 165);
  assert.equal(t.cacheRead, 1000);
  assert.equal(t.cacheWrite, 200);
});

test("fmtTokens", () => {
  assert.equal(fmtTokens(500), "500");
  assert.equal(fmtTokens(1500), "1.5k");
  assert.equal(fmtTokens(2_450_000), "2.5M");
});

test("fmtRemaining: english units", () => {
  assert.equal(fmtRemaining(0, EN_UNITS), "—");
  assert.equal(fmtRemaining(120, EN_UNITS), "2m");
  assert.equal(fmtRemaining(2 * 3600 + 41 * 60, EN_UNITS), "2h41m");
  assert.equal(fmtRemaining(4 * 86400 + 3 * 3600, EN_UNITS), "4d3h");
});

test("fmtRemaining: russian units", () => {
  assert.equal(fmtRemaining(0, RU_UNITS), "—");
  assert.equal(fmtRemaining(120, RU_UNITS), "2м");
  assert.equal(fmtRemaining(2 * 3600 + 41 * 60, RU_UNITS), "2ч41м");
  assert.equal(fmtRemaining(4 * 86400 + 3 * 3600, RU_UNITS), "4д3ч");
});

test("paceLevel: normal / tight / over", () => {
  const now = 1000;
  // 24% used, half the 5h window elapsed → projected ~48% → normal
  const half = now + WINDOW_5H_SECONDS * 0.5;
  assert.equal(paceLevel(24, half, now, WINDOW_5H_SECONDS), "normal");
  // 50% used at ~52% elapsed → ~96% → tight
  const t52 = now + WINDOW_5H_SECONDS * (1 - 0.52);
  assert.equal(paceLevel(50, t52, now, WINDOW_5H_SECONDS), "tight");
  // 30% used at 25% elapsed → 120% → over
  const q = now + WINDOW_5H_SECONDS * 0.75;
  assert.equal(paceLevel(30, q, now, WINDOW_5H_SECONDS), "over");
});

test("paceLevel: early-window guard stays normal", () => {
  const now = 1000;
  // only 1% of window elapsed → projection skipped → normal even if 10% used
  const early = now + WINDOW_5H_SECONDS * 0.99;
  assert.equal(paceLevel(10, early, now, WINDOW_5H_SECONDS), "normal");
});

test("parseRateLimitHeaders: utilization ×100, missing → null", () => {
  const h: Record<string, string> = {
    "anthropic-ratelimit-unified-5h-utilization": "0.235",
    "anthropic-ratelimit-unified-5h-reset": "1738425600",
    "anthropic-ratelimit-unified-5h-status": "allowed",
  };
  const { fiveH, sevenD } = parseRateLimitHeaders((n) => h[n] ?? null);
  assert.ok(fiveH);
  assert.equal(Math.round(fiveH!.pct), 24);
  assert.equal(fiveH!.resetAt, 1738425600);
  assert.equal(sevenD, null);
});

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
  const totals = { input: 50000, output: 150000, work: 200000, cacheRead: 10_000_000, cacheWrite: 1_000_000 };
  const v = buildView(totals, W, {
    state: "ok",
    fiveH: { pct: 24, resetAt: now + WINDOW_5H_SECONDS * 0.5 },
    sevenD: { pct: 41, resetAt: now + 7 * 86400 * 0.4 },
  }, now, "ru");
  // collapsed bar: tariff only, with colored dot + reset countdown, NO эфф
  assert.match(v.text, /🟢 5ч 24%/);
  assert.match(v.text, /7д 41%/);
  assert.ok(!/эфф/.test(v.text), "effective must NOT be in collapsed bar");
  // analytical numbers live in the tooltip, decomposition sums to effective
  assert.match(v.tooltip, /эффективно: \*\*2\.5M\*\*/);
  assert.match(v.tooltip, /на кэш/);
});

test("buildView (en): ok state, english bar + tooltip", () => {
  const now = 1000;
  const totals = { input: 50000, output: 150000, work: 200000, cacheRead: 10_000_000, cacheWrite: 1_000_000 };
  const v = buildView(totals, W, {
    state: "ok",
    fiveH: { pct: 24, resetAt: now + WINDOW_5H_SECONDS * 0.5 },
    sevenD: { pct: 41, resetAt: now + 7 * 86400 * 0.4 },
  }, now, "en");
  assert.match(v.text, /🟢 5h 24%/);
  assert.match(v.text, /7d 41%/);
  assert.match(v.tooltip, /effective: \*\*2\.5M\*\*/);
  assert.match(v.tooltip, /Subscription quota/);
  assert.match(v.tooltip, /on track/);
});

test("buildView (en): default lang is english", () => {
  const totals = { input: 5000, output: 8000, work: 13000, cacheRead: 0, cacheWrite: 0 };
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000);
  assert.match(v.text, /eff/);
  assert.match(v.tooltip, /session usage/);
});

test("buildView (en): disabled state falls back to eff in bar, normal level", () => {
  const totals = { input: 5000, output: 8000, work: 13000, cacheRead: 0, cacheWrite: 0 };
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en");
  assert.match(v.text, /eff/);
  assert.equal(v.level, "normal");
  assert.match(v.tooltip, /polling is off/);
});

test("buildView (ru): disabled state falls back to эфф in bar", () => {
  const totals = { input: 5000, output: 8000, work: 13000, cacheRead: 0, cacheWrite: 0 };
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru");
  assert.match(v.text, /эфф/);
  assert.match(v.tooltip, /опрос выключен/);
});

test("buildView: over pace yields over level (item color)", () => {
  const now = 1000;
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0 };
  const v = buildView(totals, W, {
    state: "ok",
    fiveH: { pct: 30, resetAt: now + WINDOW_5H_SECONDS * 0.75 }, // 25% elapsed → over
    sevenD: null,
  }, now, "en");
  assert.equal(v.level, "over");
});
