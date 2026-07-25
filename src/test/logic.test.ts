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
  agentDigest,
  cacheHitRatePct,
  lastCacheTier,
  parseRateLimitHeaders,
  knownModelWindow,
  WINDOW_5H_SECONDS,
} from "../metrics";
import { buildView, buildPanelHtml, buildCodexQuotaView, buildCodexPanelHtml, subagentGroups, choicesMarkdown } from "../render";
import { parseLocalQuota, windowFromBridge } from "../localQuota";
import {
  parseCachedUsage,
  parseUsageBody,
  hasUsageWindows,
  scopedWindowFromLimit,
  windowFromUsage,
  toUnixSec,
} from "../usage";
import { resolveLang, messages } from "../i18n";
import { attemptTimeoutsMs, isRetryableStatus, shouldPoll, usageCoversQuota, FAIL_RETRY_SEC } from "../quota";
import { projectSlug } from "../transcript";
import {
  deriveLabel,
  fallbackLabel,
  isClaudeStyleId,
  parseSettingsEffort,
  pickOpenChats,
  isRealModelId,
  parseSessionEntry,
  parseSettingsModel,
  pickPlanned,
  shortModelLabel,
} from "../model";
import { buildCodexSnapshot, codexContext, codexWindowLabel, shortCodexModelLabel } from "../codexProvider";
import {
  CODEX_NOT_CONNECTED_DETAIL,
  isRecentProviderActivity,
  newestActivityProvider,
  providerActivity,
  resolveProvider,
} from "../providerResolver";
import {
  buildCodexRequest,
  codexErrorDetail,
  isCodexResponseForId,
  parseCodexRolloutIdentity,
  parseCodexRolloutTokenUsage,
  parseCodexJsonLines,
  parseCodexTokenUsageNotification,
  resolveCodexCommand,
  selectCodexRateLimits,
} from "../codexAppServer";

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

test("codexWindowLabel: known 5h / 7d windows, dynamic fallback", () => {
  assert.equal(codexWindowLabel(300), "5h");
  assert.equal(codexWindowLabel(10080), "7d");
  assert.equal(codexWindowLabel(60), "60m");
});

test("codexContext: last turn over model context window; missing limit fails visibly", () => {
  const known = codexContext({
    last: { inputTokens: 1000, cachedInputTokens: 250, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 1400 },
    total: null,
    modelContextWindow: 10_000,
  });
  assert.deepEqual(known, { usedTokens: 1000, limitTokens: 10_000, limitState: "ok" });

  const unknown = codexContext({
    last: { inputTokens: 1000, cachedInputTokens: 250, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 1400 },
    total: null,
    modelContextWindow: null,
  });
  assert.equal(unknown?.usedTokens, 1000);
  assert.equal(unknown?.limitTokens, null);
  assert.equal(unknown?.limitState, "unavailable");
});

test("buildCodexSnapshot: maps primary/secondary resets into quota windows", () => {
  const s = buildCodexSnapshot({
    workspacePath: "C:\\Projects\\Casta Rico",
    thread: { threadId: "thread-123", cwd: "C:\\Projects\\Casta Rico", modelId: "gpt-5.5" },
    primary: { usedPercent: 47, windowDurationMins: 300, resetsAt: 1000 },
    secondary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: 2000 },
    tokenUsage: {
      last: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, reasoningOutputTokens: 5, totalTokens: 135 },
      total: { inputTokens: 1000, cachedInputTokens: 250, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 1400 },
      modelContextWindow: 10_000,
    },
  });
  assert.equal(s.provider, "codex");
  assert.deepEqual(s.quota.fiveH, { pct: 47, resetAt: 1000 });
  assert.deepEqual(s.quota.sevenD, { pct: 25, resetAt: 2000 });
  assert.equal(s.context?.usedTokens, 100);
  assert.equal(s.context?.limitTokens, 10_000);
  assert.equal(s.cache?.hitRatePct, 25);
  assert.equal(s.source.threadId, "thread-123");
});

test("codexAppServer helpers: builds requests without undefined params", () => {
  assert.deepEqual(buildCodexRequest("1", "account/rateLimits/read", undefined), {
    id: "1",
    method: "account/rateLimits/read",
  });
  assert.deepEqual(buildCodexRequest("2", "account/read", { refreshToken: false }), {
    id: "2",
    method: "account/read",
    params: { refreshToken: false },
  });
});

test("codexAppServer helpers: resolves configured and env Codex commands", () => {
  assert.deepEqual(resolveCodexCommand("C:\\Tools\\codex.exe", {}), {
    command: "C:\\Tools\\codex.exe",
    source: "setting",
    shell: false,
  });
  assert.deepEqual(resolveCodexCommand("", { CODEX_CLI_PATH: "C:\\Tools\\codex.cmd" }), {
    command: "C:\\Tools\\codex.cmd",
    source: "env",
    shell: true,
  });
});

test("codexAppServer helpers: falls back to PATH command when no candidate is configured", () => {
  const r = resolveCodexCommand("", {});
  assert.ok(["openai-extension", "npm", "path"].includes(r.source));
  assert.equal(typeof r.command, "string");
});

test("codexAppServer helpers: partial/noisy JSON lines are ignored safely", () => {
  const state = { buffer: "" };
  assert.deepEqual(parseCodexJsonLines(state, "not json\n{\"id\":\"1\","), []);
  assert.deepEqual(parseCodexJsonLines(state, "\"result\":{\"ok\":true}}\n"), [
    { id: "1", result: { ok: true } },
  ]);
});

test("codexAppServer helpers: request id matching ignores notifications and other ids", () => {
  assert.equal(isCodexResponseForId({ method: "account/updated", params: {} }, "1"), false);
  assert.equal(isCodexResponseForId({ id: "2", result: {} }, "1"), false);
  assert.equal(isCodexResponseForId({ id: "1", result: {} }, 1), true);
  assert.equal(isCodexResponseForId({ id: 1, error: { message: "boom" } }, "1"), true);
});

test("codexAppServer helpers: error response becomes diagnostic detail", () => {
  assert.equal(codexErrorDetail({ id: "1", error: { message: "bad auth", code: -32001 } }), "bad auth (-32001)");
  assert.equal(codexErrorDetail({ id: "1", error: {} }), "app-server error");
});

test("codexAppServer helpers: prefers rateLimitsByLimitId.codex with fallback", () => {
  const fallback = { limitId: "fallback", primary: null, secondary: null };
  const codex = { limitId: "codex", primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 10 }, secondary: null };
  assert.equal(selectCodexRateLimits({ rateLimits: fallback, rateLimitsByLimitId: { codex } }), codex);
  assert.equal(selectCodexRateLimits({ rateLimits: fallback, rateLimitsByLimitId: {} }), fallback);
});

test("codexAppServer helpers: parses thread token-usage notifications", () => {
  const update = parseCodexTokenUsageNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: { totalTokens: 1000, inputTokens: 700, cachedInputTokens: 200, outputTokens: 80, reasoningOutputTokens: 20 },
        last: { totalTokens: 140, inputTokens: 90, cachedInputTokens: 20, outputTokens: 25, reasoningOutputTokens: 5 },
        modelContextWindow: 10_000,
      },
    },
  });
  assert.equal(update?.threadId, "thread-1");
  assert.equal(update?.tokenUsage.last.totalTokens, 140);
  assert.equal(update?.tokenUsage.modelContextWindow, 10_000);
  assert.equal(parseCodexTokenUsageNotification({ method: "thread/status/changed", params: {} }), null);
});

test("codexAppServer helpers: parses the latest local Codex rollout token_count", () => {
  const raw = [
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 1000, cached_input_tokens: 700, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 1100 },
          last_token_usage: { input_tokens: 600, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 650 },
          model_context_window: 10_000,
        },
      },
    }),
    "{ partial",
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 200, reasoning_output_tokens: 30, total_tokens: 2200 },
          last_token_usage: { input_tokens: 800, cached_input_tokens: 600, output_tokens: 70, reasoning_output_tokens: 20, total_tokens: 870 },
          model_context_window: 20_000,
        },
      },
    }),
  ].join("\n");
  const usage = parseCodexRolloutTokenUsage(raw);
  assert.equal(usage?.total.totalTokens, 2200);
  assert.equal(usage?.total.cachedInputTokens, 1500);
  assert.equal(usage?.last.totalTokens, 870);
  assert.equal(usage?.modelContextWindow, 20_000);
});

test("Codex rollout identity: reads the latest turn model and effort", () => {
  const raw = [
    JSON.stringify({ type: "turn_context", payload: { turn_id: "t1", model: "gpt-5.5", effort: "medium" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "ignored" } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "t2", model: "gpt-5.6-sol", effort: "high" } }),
  ].join("\n");
  assert.deepEqual(parseCodexRolloutIdentity(raw), {
    model: "gpt-5.6-sol",
    effort: "high",
    turnId: "t2",
  });
  assert.equal(shortCodexModelLabel("gpt-5.6-sol"), "GPT-5.6 Sol");
  assert.equal(shortCodexModelLabel("custom-model"), "custom-model");
});

test("buildCodexQuotaView: shows Codex quota without Claude cost lines", () => {
  const now = 1000;
  const v = buildCodexQuotaView(
    {
      state: "ok",
      fiveH: { pct: 47, resetAt: now + WINDOW_5H_SECONDS * 0.5 },
      sevenD: { pct: 25, resetAt: now + 7 * 86400 * 0.5 },
    },
    now,
    "en",
    { source: "stdio", planType: "prolite", userAgent: "codex_vscode/test" }
  );
  assert.match(v.text, /^Codex · .*5h 47%/);
  assert.match(v.tooltip, /Subscription quota/);
  assert.match(v.tooltip, /token-equivalent with cache: will appear after the next Codex response/);
  assert.ok(!/plan prolite|stdio|codex_vscode/.test(v.tooltip), "technical app-server details stay out of the hover");
  assert.ok(!/without cache ≈/.test(v.tooltip), "Codex quota tooltip must not show Claude cost copy before token data exists");
});

test("buildCodexQuotaView: keeps Codex context visible without inventing a percent", () => {
  const now = 1000;
  const v = buildCodexQuotaView(
    {
      state: "ok",
      fiveH: { pct: 47, resetAt: now + WINDOW_5H_SECONDS * 0.5 },
      sevenD: { pct: 25, resetAt: now + 7 * 86400 * 0.5 },
    },
    now,
    "ru",
    { source: "stdio", planType: "prolite", contextState: "waiting" }
  );
  assert.match(v.text, /конт н\/д/);
  assert.match(v.tooltip, /контекст: появится после следующего ответа Codex/);
  assert.ok(!/конт \d+%/.test(v.text), "no context percent without token usage");
});

test("buildCodexQuotaView/buildCodexPanelHtml: show confirmed Codex model and effort", () => {
  const now = 1000;
  const quota = { state: "ok" as const, fiveH: null, sevenD: { pct: 10, resetAt: now + 86400 } };
  const details = {
    source: "stdio" as const,
    model: { label: "GPT-5.6 Sol", state: "actual" as const, effort: "high" },
  };
  const view = buildCodexQuotaView(quota, now, "en", details);
  assert.match(view.text, /^◆ GPT-5\.6 Sol · effort high · Codex/);
  assert.match(view.tooltip, /model: \*\*GPT-5\.6 Sol\*\* — confirmed by the last turn/);
  assert.match(view.tooltip, /effort: \*\*high\*\* — confirmed by the last turn/);
  const html = buildCodexPanelHtml(quota, now, "en", details);
  assert.match(html, /model: GPT-5\.6 Sol — confirmed by the last turn/);
  assert.match(html, /effort: high — confirmed by the last turn/);
});

test("buildCodexPanelHtml: Codex panel is sectioned and user-readable", () => {
  const now = 1000;
  const html = buildCodexPanelHtml(
    {
      state: "ok",
      fiveH: { pct: 93, resetAt: now + 14 * 60 },
      sevenD: { pct: 32, resetAt: now + 3 * 86400 },
    },
    now,
    "ru",
    {
      source: "stdio",
      planType: "prolite",
      userAgent: "codex_vscode/test",
      contextState: "waiting",
      thread: {
        id: "019ea2ed-7d15-7ce3-b4d3-67f1bf0348cc",
        name: "Ввести provider setting",
        preview: null,
        cwd: "c:\\Users\\Honor\\Desktop\\My_Projects\\cc-statusbar",
        updatedAtSec: now,
        status: "notLoaded",
        source: "vscode",
        modelProvider: "openai",
        cliVersion: "0.137.0-alpha.4",
        loaded: false,
      },
      cacheState: "waiting",
      diagnostics: ["proxy unavailable: socket disconnected", "codex command: openai-extension"],
    }
  );
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, />Тариф \(реальный, с сервера\)</);
  assert.match(html, />Кэш</);
  assert.match(html, />Детали</);
  assert.match(html, /Токен-эквивалент с кэшем/);
  assert.match(html, /Без кэша было бы/);
  assert.match(html, /Сэкономлено кэшем/);
  assert.match(html, /Токен-эквивалент появится после следующего ответа Codex/);
  assert.match(html, /не денежная цена/);
  assert.match(html, /контекст: появится после следующего ответа Codex/);
  assert.match(html, /Данные по кэшу появятся после следующего ответа Codex/);
  assert.match(html, /Детали по токенам появятся после следующего ответа Codex/);
  assert.ok(!/Сессия|Подключение|Технические детали/.test(html), "user panel hides internal app-server sections");
  assert.ok(!/Ввести provider setting|notLoaded|socket disconnected|openai-extension/.test(html), "technical details stay out of the panel");
  assert.ok(!/<p>Codex — расход/.test(html), "Codex panel must not be a raw tooltip paragraph");
});

test("buildCodexPanelHtml: known Codex context renders beside quota", () => {
  const now = 1000;
  const html = buildCodexPanelHtml(
    { state: "ok", fiveH: { pct: 10, resetAt: now + WINDOW_5H_SECONDS }, sevenD: null },
    now,
    "en",
    {
      source: "stdio",
      context: { usedTokens: 14_000, limitTokens: 100_000, limitState: "ok" },
    }
  );
  assert.match(html, /context: 14% \(14k \/ 100k\)/);
});

test("buildCodexQuotaView/buildCodexPanelHtml: Codex cache appears when token usage is known", () => {
  const now = 1000;
  const details = {
    source: "stdio" as const,
    contextState: "waiting" as const,
    cache: { tier: null, hitRatePct: 25 },
    usage: {
      totalTokens: 1200,
      lastTokens: 200,
      inputTokens: 1000,
      cachedInputTokens: 250,
      outputTokens: 200,
      reasoningOutputTokens: 50,
    },
  };
  const quota = { state: "ok" as const, fiveH: { pct: 10, resetAt: now + WINDOW_5H_SECONDS }, sevenD: null };
  const view = buildCodexQuotaView(quota, now, "ru", details);
  assert.match(view.tooltip, /токен-эквивалент с кэшем ≈ \*\*975\*\* · без кэша ≈ \*\*1\.2k\*\*/);
  assert.match(view.tooltip, /ввод из кэша: 25%/);
  const html = buildCodexPanelHtml(quota, now, "ru", details);
  assert.match(html, />Кэш</);
  assert.match(html, /Токен-эквивалент с кэшем/);
  assert.match(html, /≈ 975 ток/);
  assert.match(html, /≈ 1\.2k ток/);
  assert.match(html, /≈ 225 ток/);
  assert.match(html, /Ввод из кэша/);
  assert.match(html, /<b>25%<\/b>/);
});

test("providerResolver: explicit claude mode picks Claude", () => {
  const result = resolveProvider({
    mode: "claude",
    candidates: [
      {
        provider: "claude",
        available: true,
        activity: providerActivity("claude", true, 1000, "recent transcript"),
      },
      {
        provider: "codex",
        available: false,
        unavailableDetail: CODEX_NOT_CONNECTED_DETAIL,
        activity: providerActivity("codex", false, null, "app-server not connected"),
      },
    ],
  });
  assert.equal(result.kind, "selected");
  if (result.kind !== "selected") assert.fail("expected selected provider");
  assert.equal(result.provider, "claude");
  assert.equal(result.reason, "manual");
});

test("providerResolver: explicit codex mode is unavailable before app-server integration", () => {
  const result = resolveProvider({
    mode: "codex",
    candidates: [
      {
        provider: "claude",
        available: true,
        activity: providerActivity("claude", true, 1000, "recent transcript"),
      },
      {
        provider: "codex",
        available: false,
        unavailableDetail: CODEX_NOT_CONNECTED_DETAIL,
        activity: providerActivity("codex", false, null, "app-server not connected"),
      },
    ],
  });
  assert.equal(result.kind, "unavailable");
  if (result.kind !== "unavailable") assert.fail("expected unavailable provider");
  assert.equal(result.provider, "codex");
  assert.equal(result.detail, CODEX_NOT_CONNECTED_DETAIL);
});

test("providerResolver: auto with only Claude activity picks Claude", () => {
  const result = resolveProvider({
    mode: "auto",
    candidates: [
      {
        provider: "claude",
        available: true,
        activity: providerActivity("claude", true, 1000, "recent transcript"),
      },
      {
        provider: "codex",
        available: true,
        activity: providerActivity("codex", false, null, "no matching thread"),
      },
    ],
  });
  assert.equal(result.kind, "selected");
  if (result.kind !== "selected") assert.fail("expected selected provider");
  assert.equal(result.provider, "claude");
  assert.equal(result.reason, "active");
});

test("providerResolver: auto conflict is representable when both providers are active", () => {
  const result = resolveProvider({
    mode: "auto",
    candidates: [
      {
        provider: "claude",
        available: true,
        activity: providerActivity("claude", true, 1000, "recent transcript"),
      },
      {
        provider: "codex",
        available: true,
        activity: providerActivity("codex", true, 2000, "recent thread"),
      },
    ],
  });
  assert.equal(result.kind, "conflict");
  if (result.kind !== "conflict") assert.fail("expected conflict");
  assert.deepEqual(
    result.activities.map((a) => a.provider),
    ["claude", "codex"]
  );
});

test("provider activity: stale Claude does not hold Auto; newest source is the idle fallback", () => {
  const now = 1_000_000;
  assert.equal(isRecentProviderActivity(now - 30_000, now), true);
  assert.equal(isRecentProviderActivity(now - 61_000, now), false);
  assert.equal(
    newestActivityProvider([
      { provider: "claude", lastActivityMs: now - 120_000 },
      { provider: "codex", lastActivityMs: now - 10_000 },
    ]),
    "codex"
  );
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
  // cost-first headline: token-equivalent with-cache · without-cache · ×lower (4.6×)
  assert.match(v.tooltip, /токен-эквивалент с кэшем ≈ \*\*2\.5M\*\* · без кэша ≈ \*\*11\.2M\*\* \(в ~4\.6× меньше\)/);
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
  assert.match(v.tooltip, /token-equivalent with cache ≈ \*\*2\.5M\*\* · without cache ≈ \*\*11\.2M\*\* \(~4\.6× lower\)/);
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

test("buildView: quota fetch error → visible offline marker + local eff still shown (both langs)", () => {
  const totals = { input: 5000, output: 8000, work: 13000, cacheRead: 0, cacheWrite: 0 };
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
  const totals = { input: 100, output: 100, work: 200, cacheRead: 0, cacheWrite: 0 };
  const limited = buildView(totals, W, { state: "rate-limited", fiveH: null, sevenD: null }, 1000, "en");
  assert.match(limited.text, /quota paused/);
  const noCreds = buildView(totals, W, { state: "no-credentials", fiveH: null, sevenD: null }, 1000, "en");
  assert.match(noCreds.text, /no token/);
});

test("buildView: disabled state stays silent (intentional off, no offline marker)", () => {
  const totals = { input: 100, output: 100, work: 200, cacheRead: 0, cacheWrite: 0 };
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
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0 };
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
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0 };
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
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0 };
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
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0 };
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
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0 };
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

test("buildView: stale reading is NOT painted in the bar — neutral offline marker instead", () => {
  const totals = { input: 1000, output: 1000, work: 2000, cacheRead: 0, cacheWrite: 0 };
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
  const totals = { input: 1000, output: 1000, work: 2000, cacheRead: 0, cacheWrite: 0 };
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
  assert.match(en, /Token-equivalent with cache/);
  assert.match(en, /Without cache/);
  assert.match(en, /Cache saved/);
  assert.match(en, /~4\.6× lower/);
  assert.match(en, /2\.5M/);
  assert.match(en, /11\.2M/);
  assert.match(en, /Subscription quota/);
  assert.match(en, /Details/);
  const ru = buildPanelHtml(totals, W, q, now, "ru");
  assert.match(ru, /Токен-эквивалент с кэшем/);
  assert.match(ru, /Без кэша было бы/);
  assert.match(ru, /Сэкономлено кэшем/);
  assert.match(ru, /в ~4\.6× меньше/);
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
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0 };
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

// ── model identity ───────────────────────────────────────────────────────────

test("shortModelLabel: derives a glanceable name from the id, fully offline", () => {
  // ids taken from the owner's real transcripts
  assert.equal(shortModelLabel("claude-opus-5"), "Opus 5");
  assert.equal(shortModelLabel("claude-sonnet-5"), "Sonnet 5");
  assert.equal(shortModelLabel("claude-fable-5"), "Fable 5");
  assert.equal(shortModelLabel("claude-opus-4-8"), "Opus 4.8");
  // release-date suffix must not leak into the label
  assert.equal(shortModelLabel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  // legacy id order (version before family) still reads correctly
  assert.equal(deriveLabel("claude-3-5-sonnet-20241022"), "Sonnet 3.5");
  // family alias, as Claude Code may store it in settings.json
  assert.equal(shortModelLabel("opus"), "Opus");
});

test("shortModelLabel: 1M-context variant is a DIFFERENT budget → shown", () => {
  assert.equal(shortModelLabel("claude-opus-5[1m]"), "Opus 5 1M");
  assert.equal(shortModelLabel("claude-fable-5[1M]"), "Fable 5 1M");
});

test("shortModelLabel: Anthropic's own display name wins, 'Claude ' prefix dropped", () => {
  assert.equal(shortModelLabel("claude-opus-5", "Claude Opus 5"), "Opus 5");
  assert.equal(shortModelLabel("claude-haiku-4-5-20251001", "Claude Haiku 4.5"), "Haiku 4.5");
  // an id we do NOT recognise keeps its raw form — inventing "Some 7" out of
  // "some-custom-model-7" would be a confident wrong name
  assert.equal(shortModelLabel("some-custom-model-7"), "some-custom-model-7");
});

test("shortModelLabel: non-Anthropic id shapes are never mangled", () => {
  // regression: the shortener assumed Claude-style hyphenated ids and turned a
  // Bedrock ARN into "Arn:aws:bedrock:us", and "claude-opus-5.1" into "Opus"
  // (version silently dropped).
  assert.equal(isClaudeStyleId("claude-opus-5.1"), true);
  assert.equal(shortModelLabel("claude-opus-5.1"), "Opus 5.1");
  assert.equal(isClaudeStyleId("us.anthropic.claude-3-5-sonnet-20241022-v2:0"), false);
  assert.equal(isClaudeStyleId("my-opus-prod"), false);
  assert.equal(shortModelLabel("my-opus-prod"), "my-opus-prod");
  assert.equal(
    shortModelLabel("arn:aws:bedrock:us-east-1:1:inference-profile/sonnet-prod"),
    "sonnet-prod"
  );
  // a very long unknown id is trimmed to its identifying tail, never invented
  assert.equal(fallbackLabel("x".repeat(40)), "…" + "x".repeat(23));
});

test("isRealModelId: Claude Code's <synthetic> placeholder is not a model", () => {
  assert.equal(isRealModelId("claude-opus-5"), true);
  assert.equal(isRealModelId("<synthetic>"), false);
  assert.equal(isRealModelId(""), false);
  assert.equal(isRealModelId(null), false);
  assert.equal(shortModelLabel("<synthetic>"), null);
});

test("lastAssistantContext: a <synthetic> turn never becomes the model/context", () => {
  const raw = [
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-5", usage: { input_tokens: 10, cache_read_input_tokens: 90_000 } },
    }),
    JSON.stringify({
      type: "assistant",
      message: { model: "<synthetic>", usage: { input_tokens: 0 } },
    }),
  ].join("\n");
  const ctx = lastAssistantContext(raw);
  assert.equal(ctx.modelId, "claude-opus-5");
  assert.equal(ctx.tokens, 90_010);
});

test("parseSettingsModel: trims the pinned value and tolerates junk", () => {
  assert.deepEqual(parseSettingsModel('{"model":"  claude-opus-5[1m] "}'), {
    kind: "pinned",
    value: "claude-opus-5[1m]",
  });
  assert.deepEqual(parseSettingsModel('{"model":""}'), { kind: "absent" });
  assert.deepEqual(parseSettingsModel(""), { kind: "absent" });
});

test("pickPlanned: narrowest layer wins, and env outranks every settings file", () => {
  const pinned = (value: string) => ({ kind: "pinned" as const, value });
  const absent = { kind: "absent" as const };
  assert.deepEqual(
    pickPlanned([
      { scope: "user", value: pinned("claude-opus-5") },
      { scope: "project", value: pinned("claude-sonnet-5") },
      { scope: "local", value: pinned("claude-haiku-4-5-20251001") },
    ]),
    { id: "claude-haiku-4-5-20251001", scope: "local" }
  );
  assert.deepEqual(
    pickPlanned([
      { scope: "env", value: pinned("claude-fable-5") },
      { scope: "local", value: pinned("claude-haiku-4-5-20251001") },
    ]),
    { id: "claude-fable-5", scope: "env" }
  );
  assert.deepEqual(
    pickPlanned([
      { scope: "user", value: pinned("claude-opus-5") },
      { scope: "project", value: absent },
      { scope: "local", value: absent },
    ]),
    { id: "claude-opus-5", scope: "user" }
  );
  assert.deepEqual(pickPlanned([{ scope: "user", value: absent }]), { id: null, scope: null });
});

test("pickPlanned: an explicit \"default\" CLEARS a broader pin, it does not defer", () => {
  // absent means "ask a broader scope"; "default" means "no override at all".
  // Collapsing the two would show the user-level model for a chat that had
  // explicitly cleared it — a confident wrong reading.
  assert.deepEqual(
    pickPlanned([
      { scope: "user", value: { kind: "pinned", value: "claude-opus-5" } },
      { scope: "local", value: { kind: "default" } },
    ]),
    { id: null, scope: "local" }
  );
});

test("parseSettingsModel/Effort: absent, explicit default and pinned stay distinct", () => {
  assert.deepEqual(parseSettingsModel('{"model":"claude-sonnet-5"}'), { kind: "pinned", value: "claude-sonnet-5" });
  assert.deepEqual(parseSettingsModel('{"model":"default"}'), { kind: "default" });
  assert.deepEqual(parseSettingsModel('{"theme":"light"}'), { kind: "absent" });
  assert.deepEqual(parseSettingsModel("not json"), { kind: "absent" });
  assert.deepEqual(parseSettingsEffort('{"effortLevel":"high"}'), { kind: "pinned", value: "high" });
  assert.deepEqual(parseSettingsEffort('{"ultracode":true,"effortLevel":"low"}'), { kind: "pinned", value: "xhigh" });
  assert.deepEqual(parseSettingsEffort('{"effortLevel":"turbo"}'), { kind: "absent" });
});

test("pickOpenChats: a chat with no transcript has never answered", () => {
  const e = (sessionId: string, startedAtMs: number) => ({ pid: 1, sessionId, cwd: "c:/work", startedAtMs });
  const entries = [e("answered", 1000), e("fresh-old", 2000), e("fresh-new", 3000)];
  const open = pickOpenChats(entries, (id) => id === "answered");
  assert.equal(open.liveCount, 3);
  assert.deepEqual(open.unanswered.map((u) => u.sessionId), ["fresh-new", "fresh-old"]);
});

test("pickOpenChats: a RESUMED session is not 'fresh' — its transcript exists", () => {
  // regression: keying freshness on "session started after the newest transcript
  // write" made every resumed chat look brand-new, replacing its CONFIRMED model
  // with a mere expectation.
  const resumed = { pid: 7, sessionId: "resumed", cwd: "c:/work", startedAtMs: 9_999_999 };
  const open = pickOpenChats([resumed], (id) => id === "resumed");
  assert.equal(open.unanswered.length, 0);
  assert.equal(open.liveCount, 1);
});

test("parseSessionEntry: reads Claude Code's live-session registry", () => {
  const e = parseSessionEntry(
    JSON.stringify({
      pid: 12796,
      sessionId: "fea035bb-056b-428b-91cb-d5ee716a7e90",
      cwd: "c:\Users\Honor\Desktop\My_Projects\cc-statusbar",
      startedAt: 1784969996430,
      entrypoint: "claude-vscode",
    })
  );
  assert.equal(e?.pid, 12796);
  assert.equal(e?.startedAtMs, 1784969996430);
  assert.equal(e?.sessionId, "fea035bb-056b-428b-91cb-d5ee716a7e90");
  assert.equal(parseSessionEntry("{}"), null);
  assert.equal(parseSessionEntry("oops"), null);
});

test("buildView (ru): confirmed model leads the bar and names its provenance", () => {
  const now = 1000;
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0 };
  const v = buildView(
    totals,
    W,
    { state: "ok", fiveH: { pct: 24, resetAt: now + WINDOW_5H_SECONDS * 0.5 }, sevenD: null },
    now,
    "ru",
    undefined,
    undefined,
    { label: "Opus 5", state: "actual" }
  );
  assert.match(v.text, /^◆ Opus 5 · 🟢 5ч 24%/);
  assert.match(v.tooltip, /модель: \*\*Opus 5\*\* — подтверждена последним ходом/);
});

test("buildView: a fresh chat shows the PLANNED model, marked as a plan", () => {
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0 };
  const ru = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru", undefined, undefined, {
    label: "Sonnet 5",
    state: "planned",
  });
  assert.match(ru.text, /^◇ Sonnet 5 \(план\) ·/);
  assert.match(ru.tooltip, /модель: \*\*Sonnet 5\*\* — план для этого чата/);

  const en = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en", undefined, undefined, {
    label: null,
    state: "planned-default",
  });
  assert.match(en.text, /^◇ default model ·/);
  assert.match(en.tooltip, /account default/);
});

test("buildView: a model switch shouts in the bar without tinting the item", () => {
  const now = 1000;
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0 };
  const v = buildView(
    totals,
    W,
    { state: "ok", fiveH: { pct: 5, resetAt: now + WINDOW_5H_SECONDS * 0.9 }, sevenD: null },
    now,
    "ru",
    undefined,
    undefined,
    { label: "Opus 5", state: "actual", changedFrom: "Sonnet 5" }
  );
  assert.match(v.text, /^\$\(warning\) Sonnet 5 → Opus 5 ·/);
  assert.match(v.tooltip, /модель сменилась:\*\* Sonnet 5 → Opus 5/);
  // the item background stays a TARIFF signal only — identity never colours it
  assert.equal(v.level, "normal");
});

test("buildView: model segment absent when the feature is off (no view passed)", () => {
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0 };
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru");
  assert.ok(!/◆|◇/.test(v.text), "no model marker when the feature is disabled");
});

test("buildPanelHtml: model line is shown in the panel too", () => {
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0 };
  const html = buildPanelHtml(
    totals,
    W,
    { state: "disabled", fiveH: null, sevenD: null },
    1000,
    "ru",
    undefined,
    undefined,
    { label: "Opus 5", state: "actual" }
  );
  assert.match(html, /модель: Opus 5 — подтверждена последним ходом/);
});

// ── effort level ─────────────────────────────────────────────────────────────

test("lastAssistantContext: reads the turn's effort (top-level field)", () => {
  const raw = [
    JSON.stringify({ type: "assistant", effort: "high", message: { model: "claude-opus-5", usage: { input_tokens: 5 } } }),
    JSON.stringify({ type: "assistant", effort: "xhigh", message: { model: "claude-opus-5", usage: { input_tokens: 7 } } }),
  ].join("\n");
  assert.equal(lastAssistantContext(raw).effort, "xhigh");
  // older transcripts have no effort field at all → null, never invented
  const old = JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8", usage: { input_tokens: 5 } } });
  assert.equal(lastAssistantContext(old).effort, null);
});

test("parseSettingsEffort: case-insensitive level, junk stays unset", () => {
  assert.deepEqual(parseSettingsEffort('{"effortLevel":"XHIGH"}'), { kind: "pinned", value: "xhigh" });
  assert.deepEqual(parseSettingsEffort('{"theme":"light"}'), { kind: "absent" });
  assert.deepEqual(parseSettingsEffort("broken"), { kind: "absent" });
});

test("buildView: effort rides next to the model, in its own words", () => {
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0 };
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru", undefined, undefined, {
    label: "Opus 5",
    state: "actual",
    effort: "high",
  });
  assert.match(v.text, /^◆ Opus 5 · усилие high ·/);
  assert.match(v.tooltip, /усилие: \*\*high\*\* — подтверждено последним ходом/);

  const en = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "en", undefined, undefined, {
    label: "Opus 5",
    state: "actual",
    effort: "xhigh",
  });
  assert.match(en.text, /^◆ Opus 5 · effort xhigh ·/);
});

test("buildView: a planned effort shows in a fresh chat too", () => {
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0 };
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru", undefined, undefined, {
    label: null,
    state: "planned-default",
    effort: "high",
  });
  assert.match(v.text, /^◇ модель по умолчанию · усилие high ·/);
  assert.match(v.tooltip, /усилие: \*\*high\*\* — план \(из настроек Claude Code\)/);
});

test("buildView: an effort switch is flagged like a model switch", () => {
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0 };
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru", undefined, undefined, {
    label: "Opus 5",
    state: "actual",
    effort: "xhigh",
    effortChangedFrom: "high",
  });
  assert.match(v.text, /\$\(warning\) усилие high → xhigh/);
  assert.match(v.tooltip, /усилие сменилось:\*\* high → xhigh/);
  assert.equal(v.level, "normal"); // identity never tints the item
});

// ── subagents (delegated work) ───────────────────────────────────────────────

test("sumTranscript: an AGENT file is all-sidechain — it must still be counted", () => {
  // regression: the isSidechain guard (correct for the MAIN transcript) summed
  // every agent-*.jsonl to zero, hiding all delegated consumption. Measured on a
  // real session: 84% of the effective tokens were invisible.
  const agentRaw = [
    JSON.stringify({
      type: "assistant",
      isSidechain: true,
      requestId: "req_1",
      effort: "xhigh",
      timestamp: "2026-07-25T10:00:00.000Z",
      message: { model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 } },
    }),
    JSON.stringify({
      type: "assistant",
      isSidechain: true,
      requestId: "req_2",
      effort: "xhigh",
      timestamp: "2026-07-25T10:01:00.000Z",
      message: { model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 500 } },
    }),
  ].join("\n");
  assert.equal(sumTranscript(agentRaw).work, 0, "main-transcript mode still skips sidechains");
  const counted = sumTranscript(agentRaw, true);
  assert.equal(counted.work, 180);
  assert.equal(counted.cacheRead, 1000);
  assert.equal(counted.cacheWrite, 500);

  const d = agentDigest(agentRaw);
  assert.equal(d.model, "claude-sonnet-5");
  assert.equal(d.effort, "xhigh");
  assert.equal(d.totals.work, 180);
  assert.equal(d.lastTurnMs, Date.parse("2026-07-25T10:01:00.000Z"));
});

test("subagentGroups: groups by model+effort, biggest spender first", () => {
  const list = [
    { agentType: "general-purpose", description: "a", modelId: null, modelLabel: "Sonnet 5", effort: "xhigh", effective: 100 },
    { agentType: "Explore", description: "b", modelId: null, modelLabel: "Opus 5", effort: "xhigh", effective: 500 },
    { agentType: "general-purpose", description: "c", modelId: null, modelLabel: "Sonnet 5", effort: "xhigh", effective: 300 },
    { agentType: "general-purpose", description: "d", modelId: null, modelLabel: "Sonnet 5", effort: "low", effective: 50 },
  ];
  const g = subagentGroups(list);
  assert.deepEqual(g[0], { modelLabel: "Opus 5", effort: "xhigh", count: 1, effective: 500 });
  assert.deepEqual(g[1], { modelLabel: "Sonnet 5", effort: "xhigh", count: 2, effective: 400 });
  // same model at a DIFFERENT effort is its own group — that difference is the
  // whole point of showing effort per agent
  assert.deepEqual(g[2], { modelLabel: "Sonnet 5", effort: "low", count: 1, effective: 50 });
});

test("buildView: subagents get one compact tooltip line, nothing in the bar", () => {
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0 };
  const subs = [
    { agentType: "general-purpose", description: "research", modelId: null, modelLabel: "Opus 5", effort: "xhigh", effective: 1_500_000 },
    { agentType: "Explore", description: "grep", modelId: null, modelLabel: "Sonnet 5", effort: "xhigh", effective: 800_000 },
  ];
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru", undefined, undefined, undefined, subs);
  assert.match(v.tooltip, /саб-агенты: 2 · ≈2\.3M ток — Opus 5\/xhigh ×1 ≈1\.5M · Sonnet 5\/xhigh ×1 ≈800k/);
  assert.ok(!/саб-агент/.test(v.text), "the bar itself stays clean");
});

test("buildView: no subagents → no line at all (never an empty section)", () => {
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0 };
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru", undefined, undefined, undefined, []);
  assert.ok(!/саб-агент/.test(v.tooltip));
});

test("buildPanelHtml: subagent section names models, effort, spend and share", () => {
  const totals = { input: 0, output: 0, work: 2_000_000, cacheRead: 0, cacheWrite: 0 };
  const subs = [
    { agentType: "general-purpose", description: "Community feedback", modelId: null, modelLabel: "Opus 5", effort: "xhigh", effective: 1_500_000 },
    { agentType: "Explore", description: "Grep mentions", modelId: null, modelLabel: "Sonnet 5", effort: "low", effective: 500_000 },
  ];
  const html = buildPanelHtml(
    totals,
    W,
    { state: "disabled", fiveH: null, sevenD: null },
    1000,
    "ru",
    undefined,
    undefined,
    undefined,
    subs,
    500_000
  );
  assert.match(html, /Делегировано саб-агентам/);
  assert.match(html, /2 саб-агента · ≈ 2M ток — 80% расхода этой сессии/);
  assert.match(html, /Opus 5 · xhigh/);
  assert.match(html, /Explore · Sonnet 5 · low — Grep mentions/);
});

// ── review follow-ups ────────────────────────────────────────────────────────

test("lastAssistantContext: a newer turn without a model RESETS it, never inherits", () => {
  // regression: the model was only overwritten when the newest turn carried one,
  // so an old model could be shown as CONFIRMED beside newer token counts.
  const raw = [
    JSON.stringify({
      type: "assistant",
      message: { id: "m1", model: "claude-opus-5", usage: { input_tokens: 10 } },
    }),
    JSON.stringify({ type: "assistant", message: { id: "m2", usage: { input_tokens: 20 } } }),
  ].join("\n");
  const ctx = lastAssistantContext(raw);
  assert.equal(ctx.modelId, null);
  assert.equal(ctx.tokens, 20);
});

test("lastAssistantContext: turnId identifies the last turn (change notices key on it)", () => {
  const raw = [
    JSON.stringify({ type: "assistant", message: { id: "resp_1", model: "claude-opus-5", usage: { input_tokens: 1 } } }),
    JSON.stringify({ type: "assistant", requestId: "req_2", message: { model: "claude-opus-5", usage: { input_tokens: 2 } } }),
  ].join("\n");
  assert.equal(lastAssistantContext(raw).turnId, "req_2");
});

test("subagentGroups: same short label, DIFFERENT raw id → separate rows", () => {
  // two deployments that render to the same name must not merge, or the panel
  // cannot answer which one actually spent the tokens
  const list = [
    { agentType: "a", description: "x", modelId: "claude-sonnet-5", modelLabel: "Sonnet 5", effort: "high", effective: 100 },
    { agentType: "b", description: "y", modelId: "us.anthropic.claude-sonnet-5-v1:0", modelLabel: "Sonnet 5", effort: "high", effective: 300 },
  ];
  const g = subagentGroups(list);
  assert.equal(g.length, 2);
  assert.equal(g[0].effective, 300);
});

test("buildView: an unanswered chat next door is named only when it differs", () => {
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0 };
  const quiet = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru", undefined, undefined, {
    label: "Opus 5",
    state: "actual",
    pendingLabel: null, // same model → nothing can go wrong → stay silent
  });
  assert.ok(!/новый чат/.test(quiet.text));

  const warned = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru", undefined, undefined, {
    label: "Opus 5",
    state: "actual",
    pendingLabel: "Sonnet 5",
  });
  assert.match(warned.text, /◆ Opus 5 · \$\(warning\) новый чат: Sonnet 5/);
  assert.match(warned.tooltip, /рядом открыт чат без ответов — он стартует на \*\*Sonnet 5\*\*/);
});

test("buildPanelHtml: nested agents are labelled by depth, not attributed to the Lead", () => {
  const totals = { input: 0, output: 0, work: 1_000_000, cacheRead: 0, cacheWrite: 0 };
  const subs = [
    { agentType: "Explore", description: "Grep", modelId: "claude-sonnet-5", modelLabel: "Sonnet 5", effort: "high", spawnDepth: 3, effective: 500_000 },
  ];
  const html = buildPanelHtml(
    totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru",
    undefined, undefined, undefined, subs, 500_000
  );
  assert.match(html, /Explore · Sonnet 5 · high · уровень 3 — Grep/);
  // the note must not claim the Lead chose every model
  assert.ok(!/выбирает лид сам/.test(html));
});

test("buildView: the freshness note is its own line, not glued to a quota bullet", () => {
  const now = 10_000;
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0 };
  const v = buildView(
    totals,
    W,
    {
      state: "ok",
      fiveH: { pct: 29, resetAt: now + 1440 },
      sevenD: { pct: 65, resetAt: now + 3 * 86400 },
      asOfSec: now - 300, // 5 minutes old
    },
    now,
    "ru"
  );
  const lines = v.tooltip.split("\n");
  const note = lines.findIndex((l) => l.includes("Обновлено"));
  assert.ok(note > 0, "freshness note present");
  assert.equal(lines[note - 1], "", "a blank line must separate it from the quota list");
  assert.ok(!/сброс через.*Обновлено/.test(v.tooltip), "must not fold into the 7d bullet");
});

test("buildPanelHtml: the quota heading stays even when the quota is offline", () => {
  const totals = { input: 0, output: 0, work: 1000, cacheRead: 0, cacheWrite: 0 };
  const html = buildPanelHtml(totals, W, { state: "error", fiveH: null, sevenD: null }, 1000, "ru");
  assert.match(html, /<h3>Тариф \(реальный, с сервера\)<\/h3>/);
  assert.match(html, /временно недоступен/);
});

test("panelSubagentsSummary (ru): proper plural forms, not 'саб-агент(ов)'", () => {
  const ru = messages("ru");
  assert.match(ru.panelSubagentsSummary(1, "10k", "5"), /^1 саб-агент /);
  assert.match(ru.panelSubagentsSummary(2, "53k", "1"), /^2 саб-агента /);
  assert.match(ru.panelSubagentsSummary(5, "1M", "40"), /^5 саб-агентов /);
  assert.match(ru.panelSubagentsSummary(11, "1M", "40"), /^11 саб-агентов /);
  assert.match(ru.panelSubagentsSummary(22, "1M", "40"), /^22 саб-агента /);
});

test("buildPanelHtml: subagent value column is wide enough not to wrap", () => {
  const totals = { input: 0, output: 0, work: 1_000_000, cacheRead: 0, cacheWrite: 0 };
  const subs = [
    { agentType: "Explore", description: "x", modelId: "claude-sonnet-5", modelLabel: "Sonnet 5", effort: "xhigh", effective: 27_500 },
  ];
  const html = buildPanelHtml(
    totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru",
    undefined, undefined, undefined, subs, 500_000
  );
  assert.match(html, /<div class="qrow sub">/);
  assert.match(html, /\.qrow\.sub b \{ width:auto; min-width:78px; white-space:nowrap; \}/);
});

test("buildView: the tooltip is split into blocks by a rule", () => {
  const now = 1000;
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0 };
  const v = buildView(
    totals,
    W,
    { state: "ok", fiveH: { pct: 24, resetAt: now + 9000 }, sevenD: null, asOfSec: now },
    now,
    "ru",
    { usedTokens: 400_000, limitTokens: 1_000_000, limitState: "ok" },
    { tier: "1h", hitRatePct: 90 },
    { label: "Opus 5", state: "actual", effort: "high" },
    [{ agentType: "Explore", description: "x", modelId: "claude-sonnet-5", modelLabel: "Sonnet 5", effort: "high", effective: 1000 }]
  );
  const lines = v.tooltip.split("\n");
  const rules = lines.filter((l) => l === "---").length;
  assert.equal(rules, 3, "identity | body | details | actions");
  // identity comes first and is closed by a rule before the numbers start
  assert.ok(lines.indexOf("---") < lines.findIndex((l) => l.includes("токен-эквивалент")));
  // "this session" facts are their own labelled group, not more tariff bullets
  const session = lines.indexOf("**Эта сессия:**");
  assert.ok(session > 0, "session group present");
  assert.ok(lines[session + 1].startsWith("- контекст"));
  assert.ok(lines.slice(session).some((l) => l.includes("саб-агенты")));
  // and the tariff bullets stay ABOVE that label
  assert.ok(lines.findIndex((l) => l.includes("5ч")) < session);
});

test("buildView: a tooltip with nothing session-specific has no empty group", () => {
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0 };
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru");
  assert.ok(!/Эта сессия/.test(v.tooltip));
});

test("buildPanelHtml: sections carry a short left-aligned separator", () => {
  const totals = { input: 0, output: 0, work: 1000, cacheRead: 0, cacheWrite: 0 };
  const html = buildPanelHtml(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru", undefined, undefined, {
    label: "Opus 5",
    state: "actual",
    effort: "high",
  });
  assert.match(html, /h3::before \{ content:""; position:absolute; top:0; left:0; width:44%/);
  // the identity block is closed by the same short rule
  assert.match(html, /<div class="sep"><\/div>/);
});

test("choicesMarkdown: the current choice is marked, the rest stay links", () => {
  // The row must answer "which one is on?" without reading. Colour was tried and
  // does not survive the status-bar tooltip's sanitiser, so the marking must be
  // pure Markdown: a check + bold against blue links.
  const row = choicesMarkdown("Language", "ru", [
    { value: "auto", label: "Auto", command: "ccStatusbar.useLanguageAuto" },
    { value: "ru", label: "RU", command: "ccStatusbar.useLanguageRu" },
    { value: "en", label: "EN", command: "ccStatusbar.useLanguageEn" },
  ]);
  assert.match(row, /✓ \*\*RU\*\*/);
  assert.match(row, /\[Auto\]\(command:ccStatusbar\.useLanguageAuto\)/);
  assert.match(row, /\[EN\]\(command:ccStatusbar\.useLanguageEn\)/);
  // exactly one marked entry, and no raw HTML (the status-bar tooltip strips it)
  assert.equal((row.match(/✓/g) || []).length, 1);
  assert.ok(!/</.test(row.replace(/\[[^\]]*\]\([^)]*\)/g, "")), "no inline markup");
});

test("buildPanelHtml: a small but real delegation share never prints as 0%", () => {
  // 53k of 11.1M is 0.48% — rounding it to "0%" reads as "delegation cost
  // nothing", in the very section about what it cost.
  const totals = { input: 0, output: 0, work: 11_100_000, cacheRead: 0, cacheWrite: 0 };
  const subs = [
    { agentType: "Explore", description: "x", modelId: "claude-sonnet-5", modelLabel: "Sonnet 5", effort: "xhigh", effective: 53_000 },
  ];
  const html = buildPanelHtml(
    totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru",
    undefined, undefined, undefined, subs, 11_100_000
  );
  assert.match(html, /&lt;1% расхода этой сессии/);
  assert.ok(!/— 0% расхода/.test(html));
});
