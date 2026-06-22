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
import { buildView, buildPanelHtml, buildCodexQuotaView, buildCodexPanelHtml } from "../render";
import { resolveLang, messages } from "../i18n";
import { attemptTimeoutsMs, isRetryableStatus } from "../quota";
import { projectSlug } from "../transcript";
import { buildCodexSnapshot, codexContext, codexWindowLabel } from "../codexProvider";
import { CODEX_NOT_CONNECTED_DETAIL, providerActivity, resolveProvider } from "../providerResolver";
import {
  buildCodexRequest,
  codexErrorDetail,
  isCodexResponseForId,
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
