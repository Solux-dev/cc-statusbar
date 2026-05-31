import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveTokens,
  sumTranscript,
  fmtTokens,
  fmtMult,
  fmtRemaining,
  paceLevel,
  contextLevel,
  lastAssistantContext,
  cacheHitRatePct,
  lastCacheTier,
  parseRateLimitHeaders,
  WINDOW_5H_SECONDS,
} from "../metrics";
import { buildView, buildPanelHtml } from "../render";
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

test("sumTranscript: falls back to nested cache_creation when top-level is 0 (<v2.1.152)", () => {
  // top-level cache_creation_input_tokens missing/0, value only in the nested breakdown
  const raw = JSON.stringify({
    type: "assistant",
    message: { usage: { input_tokens: 10, output_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4812 } } },
  });
  const t = sumTranscript(raw);
  assert.equal(t.cacheWrite, 4812);
});

test("sumTranscript: excludes subagent (isSidechain) turns from main totals", () => {
  const raw = [
    JSON.stringify({ type: "assistant", isSidechain: true, message: { usage: { input_tokens: 999, output_tokens: 999, cache_read_input_tokens: 999, cache_creation_input_tokens: 999 } } }),
    JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } } }),
  ].join("\n");
  const t = sumTranscript(raw);
  assert.equal(t.input, 100);
  assert.equal(t.output, 50);
  assert.equal(t.cacheRead, 1000);
  assert.equal(t.cacheWrite, 200);
});

test("lastAssistantContext: a trailing subagent turn must NOT become the main context", () => {
  const raw = [
    JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8", usage: { input_tokens: 200, cache_read_input_tokens: 468000, cache_creation_input_tokens: 0 } } }),
    JSON.stringify({ type: "assistant", isSidechain: true, message: { model: "claude-haiku-4-5", usage: { input_tokens: 5, cache_read_input_tokens: 5, cache_creation_input_tokens: 5 } } }),
  ].join("\n");
  const c = lastAssistantContext(raw);
  // main turn wins, not the trailing subagent turn
  assert.equal(c.tokens, 468200);
  assert.equal(c.modelId, "claude-opus-4-8");
});

test("fmtTokens", () => {
  assert.equal(fmtTokens(500), "500");
  assert.equal(fmtTokens(1500), "1.5k");
  assert.equal(fmtTokens(2_450_000), "2.5M");
  // drop trailing ".0" → "1M" not "1.0M", "468k" not "468.0k"
  assert.equal(fmtTokens(1_000_000), "1M");
  assert.equal(fmtTokens(468_000), "468k");
  assert.equal(fmtTokens(10_000_000), "10M");
});

test("fmtMult: one decimal, drops trailing .0", () => {
  assert.equal(fmtMult(11_200_000 / 2_450_000), "4.6");
  assert.equal(fmtMult(7), "7");
  assert.equal(fmtMult(6.84), "6.8");
});

test("contextLevel: informational dot thresholds (<50 🟢 · 50–80 🟡 · ≥80 🔴)", () => {
  assert.equal(contextLevel(0), "normal");
  assert.equal(contextLevel(49), "normal");
  assert.equal(contextLevel(50), "tight");
  assert.equal(contextLevel(79), "tight");
  assert.equal(contextLevel(80), "over");
  assert.equal(contextLevel(100), "over");
});

test("cacheHitRatePct: read / (read + write + input); null when empty", () => {
  assert.equal(cacheHitRatePct({ input: 1000, output: 0, work: 1000, cacheRead: 8000, cacheWrite: 1000 }), 80);
  assert.equal(cacheHitRatePct({ input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0 }), null);
});

test("lastCacheTier: last MAIN write-turn decides; sidechain + breakdown-less ignored", () => {
  const raw = [
    JSON.stringify({ type: "assistant", message: { usage: { cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 } } } }),
    // a subagent 5m write must NOT flip the main tier
    JSON.stringify({ type: "assistant", isSidechain: true, message: { usage: { cache_creation: { ephemeral_5m_input_tokens: 999, ephemeral_1h_input_tokens: 0 } } } }),
    // a read-only / breakdown-less turn leaves the tier unchanged
    JSON.stringify({ type: "assistant", message: { usage: { cache_read_input_tokens: 50 } } }),
  ].join("\n");
  assert.equal(lastCacheTier(raw), "1h");
});

test("lastCacheTier: 5m detected; null when no write turn", () => {
  const fivem = JSON.stringify({ type: "assistant", message: { usage: { cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 } } } });
  assert.equal(lastCacheTier(fivem), "5m");
  assert.equal(lastCacheTier(""), null);
  const noWrite = JSON.stringify({ type: "assistant", message: { usage: { cache_read_input_tokens: 50 } } });
  assert.equal(lastCacheTier(noWrite), null);
});

test("lastAssistantContext: last assistant turn wins, main-only numerator + model id", () => {
  const raw = [
    JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8", usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 } } }),
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    "{ broken",
    JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8", usage: { input_tokens: 200, cache_read_input_tokens: 468000, cache_creation_input_tokens: 0 } } }),
  ].join("\n");
  const c = lastAssistantContext(raw);
  // last turn: 200 + 468000 + 0
  assert.equal(c.tokens, 468200);
  assert.equal(c.modelId, "claude-opus-4-8");
});

test("lastAssistantContext: empty / no usage → nulls", () => {
  assert.deepEqual(lastAssistantContext(""), { tokens: null, modelId: null });
  const onlyUser = JSON.stringify({ type: "user", message: { content: "x" } });
  assert.deepEqual(lastAssistantContext(onlyUser), { tokens: null, modelId: null });
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
  // cost-first headline: with-cache · without-cache · ×cheaper (4.6×)
  assert.match(v.tooltip, /с кэшем ≈ \*\*2\.5M\*\* · без кэша ≈ \*\*11\.2M\*\* \(дешевле в ~4\.6×\)/);
  // muted technical breakdown line still present
  assert.match(v.tooltip, /работа \(ввод\+вывод\) 200k · кэш: чтение 10M \/ запись 1M/);
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
  assert.match(v.tooltip, /with cache ≈ \*\*2\.5M\*\* · without cache ≈ \*\*11\.2M\*\* \(~4\.6× cheaper\)/);
  assert.match(v.tooltip, /work \(in\+out\) 200k · cache: read 10M \/ write 1M/);
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

test("buildView: tooltip carries the switch-language command link (both langs)", () => {
  const totals = { input: 100, output: 100, work: 200, cacheRead: 0, cacheWrite: 0 };
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
  assert.match(buildView({ input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0 }, W, tightQ, now, "en").tooltip, /running tight/);
  assert.match(buildView({ input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0 }, W, tightQ, now, "ru").tooltip, /близко к лимиту/);
});

test("buildPanelHtml: valid doc with effective + quota (en) and localized (ru)", () => {
  const now = 1000;
  const totals = { input: 50000, output: 150000, work: 200000, cacheRead: 10_000_000, cacheWrite: 1_000_000 };
  const q = { state: "ok" as const, fiveH: { pct: 24, resetAt: now + WINDOW_5H_SECONDS * 0.5 }, sevenD: { pct: 41, resetAt: now + 7 * 86400 * 0.4 } };
  const en = buildPanelHtml(totals, W, q, now, "en");
  assert.match(en, /^<!DOCTYPE html>/);
  assert.match(en, /This session cost/);
  assert.match(en, /Without caching/);
  assert.match(en, /Cache saved/);
  assert.match(en, /~4\.6× cheaper/);
  assert.match(en, /2\.5M/);
  assert.match(en, /11\.2M/);
  assert.match(en, /Subscription quota/);
  assert.match(en, /Details/);
  const ru = buildPanelHtml(totals, W, q, now, "ru");
  assert.match(ru, /Стоило \(с учётом кэша\)/);
  assert.match(ru, /Без кэша было бы/);
  assert.match(ru, /Экономия за счёт кэша/);
  assert.match(ru, /в ~4\.6× дешевле/);
  assert.match(ru, /Тариф/);
});

test("buildPanelHtml: escapes nothing dangerous + handles disabled quota", () => {
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0 };
  const html = buildPanelHtml(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en");
  assert.ok(!/<script/i.test(html), "no script tags");
  assert.match(html, /polling is off/);
});

const ctxTotals = { input: 50000, output: 150000, work: 200000, cacheRead: 10_000_000, cacheWrite: 1_000_000 };

test("buildView: context segment in collapsed bar + line in tooltip (en)", () => {
  const v = buildView(ctxTotals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en", {
    usedTokens: 468_000,
    limitTokens: 1_000_000,
    limitState: "ok",
  });
  // 468k / 1M = 47% → <50% → 🟢 informational dot, appended after the eff fallback
  assert.match(v.text, /· 🟢 ctx 47%$/);
  assert.ok(!/🟡|🔴/.test(v.text), "47% is green, not a warning");
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
  assert.match(v.text, /· 🟢 конт 47%$/);
  assert.match(v.tooltip, /контекст: 47% \(468k \/ 1M\)/);
});

test("buildView: 🟡 mid-fill (50–80%) is informational — does NOT change item level", () => {
  const v = buildView(ctxTotals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en", {
    usedTokens: 600_000,
    limitTokens: 1_000_000,
    limitState: "ok",
  });
  assert.match(v.text, /🟡 ctx 60%/);
  // item background stays tariff-pace; context fill must NOT drive it
  assert.equal(v.level, "normal");
});

test("buildView: context ≥80% → 🔴 dot, still does not tint the bar", () => {
  const v = buildView(ctxTotals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en", {
    usedTokens: 970_000,
    limitTokens: 1_000_000,
    limitState: "ok",
  });
  assert.match(v.text, /🔴 ctx 97%/);
  assert.equal(v.level, "normal");
});

test("buildView: cache tier line in tooltip (concise); absent when tier null", () => {
  const base = { state: "disabled" as const, fiveH: null, sevenD: null };
  const v1h = buildView(ctxTotals, W, base, 1000, "en", undefined, { tier: "1h", hitRatePct: 82 });
  assert.match(v1h.tooltip, /Cache: 1-hour tier/);
  const v5m = buildView(ctxTotals, W, base, 1000, "ru", undefined, { tier: "5m", hitRatePct: 40 });
  assert.match(v5m.tooltip, /5-мин тир/);
  const none = buildView(ctxTotals, W, base, 1000, "en", undefined, { tier: null, hitRatePct: null });
  assert.ok(!/Cache:/.test(none.tooltip), "no tier → no cache line");
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
