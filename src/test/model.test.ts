// Which model and effort a session runs on, how a planned one differs from a
// confirmed one, and the delegated-work section that names them.
//
// Lifted out of logic.test.ts unchanged and in order — no test was renamed,
// reordered, or rewritten in the move.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sumTranscript, lastAssistantContext, agentDigest, WINDOW_5H_SECONDS } from "../metrics";
import { buildView, buildPanelHtml, choicesMarkdown } from "../render";
import { subagentGroups } from "../panelModel";
import { messages } from "../i18n";
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
import { W, turn } from "./fixtures";

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
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
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
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
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
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
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
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru");
  assert.ok(!/◆|◇/.test(v.text), "no model marker when the feature is disabled");
});

test("buildPanelHtml: model line is shown in the panel too", () => {
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
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
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
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
  const totals = { input: 0, output: 0, work: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru", undefined, undefined, {
    label: null,
    state: "planned-default",
    effort: "high",
  });
  assert.match(v.text, /^◇ модель по умолчанию · усилие high ·/);
  assert.match(v.tooltip, /усилие: \*\*high\*\* — план \(из настроек Claude Code\)/);
});

test("buildView: an effort switch is flagged like a model switch", () => {
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
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
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const subs = [
    { agentType: "general-purpose", description: "research", modelId: null, modelLabel: "Opus 5", effort: "xhigh", effective: 1_500_000 },
    { agentType: "Explore", description: "grep", modelId: null, modelLabel: "Sonnet 5", effort: "xhigh", effective: 800_000 },
  ];
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru", undefined, undefined, undefined, subs);
  assert.match(v.tooltip, /саб-агенты: 2 · ≈2\.3M ток — Opus 5\/xhigh ×1 ≈1\.5M · Sonnet 5\/xhigh ×1 ≈800k/);
  assert.ok(!/саб-агент/.test(v.text), "the bar itself stays clean");
});

test("buildView: no subagents → no line at all (never an empty section)", () => {
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru", undefined, undefined, undefined, []);
  assert.ok(!/саб-агент/.test(v.tooltip));
});

test("buildPanelHtml: subagent section names models, effort, spend and share", () => {
  const totals = { input: 0, output: 0, work: 2_000_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
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
    500_000,
    undefined,
    true // list open: the per-agent rows are what this test is about
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
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
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
  const totals = { input: 0, output: 0, work: 1_000_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const subs = [
    { agentType: "Explore", description: "Grep", modelId: "claude-sonnet-5", modelLabel: "Sonnet 5", effort: "high", spawnDepth: 3, effective: 500_000 },
  ];
  const html = buildPanelHtml(
    totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru",
    undefined, undefined, undefined, subs, 500_000, undefined, true
  );
  assert.match(html, /Explore · Sonnet 5 · high · уровень 3 — Grep/);
  // the note must not claim the Lead chose every model
  assert.ok(!/выбирает лид сам/.test(html));
});

test("buildView: the freshness note is its own line, not glued to a quota bullet", () => {
  const now = 10_000;
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
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
  const totals = { input: 0, output: 0, work: 1000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
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
  const totals = { input: 0, output: 0, work: 1_000_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
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
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
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
  const totals = { input: 1000, output: 2000, work: 3000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const v = buildView(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru");
  assert.ok(!/Эта сессия/.test(v.tooltip));
});

test("buildPanelHtml: sections carry a short left-aligned separator", () => {
  const totals = { input: 0, output: 0, work: 1000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const html = buildPanelHtml(totals, W, { state: "disabled", fiveH: null, sevenD: null }, 1000, "ru", undefined, undefined, {
    label: "Opus 5",
    state: "actual",
    effort: "high",
  });
  assert.match(html, /h3::before \{ content:""; position:absolute; top:0; left:0; width:44%/);
  // The token-equivalent line at the foot of the page has no <h3> of its own —
  // it is set off by the same short rule instead.
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
  const totals = { input: 0, output: 0, work: 11_100_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
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

