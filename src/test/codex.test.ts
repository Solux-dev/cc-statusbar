import { test } from "node:test";
import assert from "node:assert/strict";
import { WINDOW_5H_SECONDS } from "../metrics";
import { buildCodexQuotaView, buildCodexPanelHtml } from "../render";
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

test("a Codex counter that cannot be a count is refused, never printed", () => {
  // The Claude side has sanitised its counters for a while (`tokenCount`); the
  // Codex parsers took whatever number the local file stated. A negative reached
  // the panel with a minus sign in front of it, and a fabricated 1e308 would sum
  // to Infinity two additions later, where the difference of two infinities is
  // NaN and every figure on the page turns to nonsense.
  const usage = (total: Record<string, number>) => ({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "t", turnId: "u",
      tokenUsage: {
        total,
        last: { totalTokens: 10, inputTokens: 6, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1 },
        modelContextWindow: 10_000,
      },
    },
  });
  const good = { totalTokens: 1000, inputTokens: 700, cachedInputTokens: 200, outputTokens: 80, reasoningOutputTokens: 20 };
  assert.equal(parseCodexTokenUsageNotification(usage(good))?.tokenUsage.total.inputTokens, 700);
  assert.equal(parseCodexTokenUsageNotification(usage({ ...good, inputTokens: -700 })), null, "a negative input");
  assert.equal(parseCodexTokenUsageNotification(usage({ ...good, cachedInputTokens: -1 })), null, "a negative cache read");
  assert.equal(parseCodexTokenUsageNotification(usage({ ...good, totalTokens: 1e308 })), null, "a fabricated total");
  // Zero is a real answer — a turn that read nothing from cache states zero, and
  // rejecting it would blank a page that is perfectly correct.
  const zeroed = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  assert.equal(parseCodexTokenUsageNotification(usage(zeroed))?.tokenUsage.total.totalTokens, 0);

  // Same rule down the rollout path, where a corrupt LAST line must not erase a
  // good earlier one: the reader falls back rather than showing nothing.
  const line = (input: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: input, cached_input_tokens: 100, output_tokens: 10, reasoning_output_tokens: 5, total_tokens: input + 15, ...extra },
          last_token_usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 5, reasoning_output_tokens: 1, total_tokens: 56 },
          model_context_window: 10_000,
        },
      },
    });
  const fellBack = parseCodexRolloutTokenUsage([line(1000), line(-2000)].join("\n"));
  assert.equal(fellBack?.total.inputTokens, 1000, "the last good reading stands");

  // The optional write counter keeps its own meaning: a corrupt one is "not
  // stated", which is NOT the same as "stated as zero" — the panel says
  // different things about the two, and the breakdown itself still stands.
  const withBadWrite = parseCodexRolloutTokenUsage(line(1000, { cache_write_input_tokens: -5 }));
  assert.equal(withBadWrite?.total.inputTokens, 1000, "one bad optional field is not a reason to drop the turn");
  assert.equal(withBadWrite?.total.cacheWriteInputTokens, null, "and it reads as unstated, not as zero");
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
  // While Codex has not answered yet there is nothing to compare against, so the
  // line stands alone with a dash. Blank "without cache" / "saved" rows read as
  // zeros — worse than not showing them.
  assert.ok(!/Без кэша было бы|Сэкономлено кэшем/.test(html), "no blank extras while waiting");
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
  // `≥`, not `≈`: no write count is stated and 750 of ordinary input could
  // hold one, which would take the figure to 1.2k. The hover has no ⓘ, so it
  // carries the sign itself.
  assert.match(view.tooltip, /токен-эквивалент с кэшем ≥ \*\*975\*\* · без кэша ≈ \*\*1\.2k\*\*/);
  assert.match(view.tooltip, /ввод из кэша: 25%/);
  const html = buildCodexPanelHtml(quota, now, "ru", details);
  assert.match(html, />Кэш</);
  assert.match(html, /Токен-эквивалент с кэшем/);
  assert.match(html, /≥ 975 ток/);
  assert.match(html, /≈ 1\.2k ток/);
  // The saving is "≤", not "≈": this payload states no cache-write count, so
  // the 750 of ordinary input could hold one. At the far end the saving is 38,
  // not 225 — 225 is its ceiling, and a ceiling rounds up, never down.
  assert.match(html, /≤ 225 ток/);
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
