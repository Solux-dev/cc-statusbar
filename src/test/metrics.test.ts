// Arithmetic and transcript reading: what the counters add up to, how a
// transcript is summed and de-duplicated, and how a number is printed.
//
// Lifted out of logic.test.ts unchanged and in order — no test was renamed,
// reordered, or rewritten in the move.

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
import { W, EN_UNITS, RU_UNITS } from "./fixtures";


test("effectiveTokens: no cache equals work", () => {
  assert.equal(effectiveTokens({ input: 600, output: 400, work: 1000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 }, W), 1000);
});

test("effectiveTokens: combined weights", () => {
  // 200000 + 0.1*10_000_000 + 1.25*1_000_000 = 2_450_000
  const t = { input: 50000, output: 150000, work: 200000, cacheRead: 10_000_000, cacheWrite: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 1_000_000 };
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

test("sumTranscript: counts one response once when split across content-block lines (same message.id)", () => {
  // One API response → 3 jsonl lines (thinking / text / tool_use), each repeating the SAME usage.
  const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 };
  const raw = [
    JSON.stringify({ type: "assistant", uuid: "a", message: { id: "msg_1", usage } }),
    JSON.stringify({ type: "assistant", uuid: "b", message: { id: "msg_1", usage } }),
    JSON.stringify({ type: "assistant", uuid: "c", message: { id: "msg_1", usage } }),
  ].join("\n");
  const t = sumTranscript(raw);
  assert.equal(t.input, 100); // counted once, not ×3
  assert.equal(t.output, 50);
  assert.equal(t.work, 150);
  assert.equal(t.cacheRead, 1000);
  assert.equal(t.cacheWrite, 200);
});

test("sumTranscript: distinct message.id responses are all summed (no over-dedup)", () => {
  const raw = [
    JSON.stringify({ type: "assistant", message: { id: "msg_1", usage: { input_tokens: 100, output_tokens: 50 } } }),
    JSON.stringify({ type: "assistant", message: { id: "msg_2", usage: { input_tokens: 10, output_tokens: 5 } } }),
  ].join("\n");
  const t = sumTranscript(raw);
  assert.equal(t.input, 110);
  assert.equal(t.output, 55);
  assert.equal(t.work, 165);
});

test("sumTranscript: dedups by requestId when message.id is absent", () => {
  const usage = { input_tokens: 100, output_tokens: 50 };
  const raw = [
    JSON.stringify({ type: "assistant", requestId: "req_1", message: { usage } }),
    JSON.stringify({ type: "assistant", requestId: "req_1", message: { usage } }),
  ].join("\n");
  const t = sumTranscript(raw);
  assert.equal(t.input, 100); // counted once
  assert.equal(t.output, 50);
});

test("sumTranscript: lines with neither id are all counted (no silent drop)", () => {
  const usage = { input_tokens: 100, output_tokens: 50 };
  const raw = [
    JSON.stringify({ type: "assistant", message: { usage } }),
    JSON.stringify({ type: "assistant", message: { usage } }),
  ].join("\n");
  const t = sumTranscript(raw);
  assert.equal(t.input, 200); // both kept — no id to dedup on
  assert.equal(t.output, 100);
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

test("contextLevel: informational dot thresholds (<40 🟢 · 40–60 🟡 · ≥60 🔴)", () => {
  // Deliberately early: quality degrades and quota burn grows long before the
  // window is full, so the dot warns while there is still room to finish well.
  assert.equal(contextLevel(0), "normal");
  assert.equal(contextLevel(39), "normal");
  assert.equal(contextLevel(40), "tight");
  assert.equal(contextLevel(59), "tight");
  assert.equal(contextLevel(60), "over");
  assert.equal(contextLevel(100), "over");
});

test("cacheHitRatePct: read / (read + write + input); null when empty", () => {
  assert.equal(cacheHitRatePct({ input: 1000, output: 0, work: 1000, cacheRead: 8000, cacheWrite: 1000, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 1000 }), 80);
  assert.equal(cacheHitRatePct({ input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 }), null);
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
  assert.deepEqual(lastAssistantContext(""), { tokens: null, modelId: null, effort: null, turnId: null });
  const onlyUser = JSON.stringify({ type: "user", message: { content: "x" } });
  assert.deepEqual(lastAssistantContext(onlyUser), {
    tokens: null,
    modelId: null,
    effort: null,
    turnId: null,
  });
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
