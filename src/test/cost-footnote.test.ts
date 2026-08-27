// The footnote under the token-equivalent: which cause it may name, when a
// difference is too small to name at all, and the floors that mark a figure
// measured only in part.
//
// Lifted out of logic.test.ts unchanged and in order — no test was renamed,
// reordered, or rewritten in the move.

import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveTokens, fmtTokens, idleRebuildOf, costDirection, addRebuild } from "../metrics";
import { buildView, buildPanelHtml, buildCodexPanelHtml, DELEGATED_TOGGLE_COMMAND } from "../render";
import { agentIdle } from "../panelModel";
import { W, turn, REB, REBUILD_TOTALS, REBUILD_SUBS, REBUILD_LOUD, QUOTA_OFF, ORDER_CODEX_USAGE, IDLE_BASE, IDLE_AGENT, PATIENT_AGENT, IDLE_TOTALS, WARMUP_TOTALS } from "./fixtures";

// ---------------------------------------------------------------------------
// Round 2 — two defects the external review found in the work above.
//
// 1. The comparison stated its direction unconditionally ("N× more"), which is
//    false on a turn that has WRITTEN a cache and read nothing back: a 1-hour
//    write is priced at 2× a fresh token, so with-cache is then the LARGER
//    number. It used to be wrong only inside a hover; this round put it on the
//    page, where wrong is much more expensive.
// 2. `idle 0%` was rendered whenever the agent's tier was known, but a tier
//    stated at the END of a log says nothing about earlier gaps. A zero there
//    is an invented fact.
// ---------------------------------------------------------------------------

test("costDirection: the cache has not always saved you something", () => {
  // work 1k + a 1-hour write of 100k: with cache 201k, without cache 101k.
  assert.deepEqual(costDirection(201_000, 101_000), { dir: "less", mult: "2" });
  assert.deepEqual(costDirection(2_450_000, 11_200_000), { dir: "more", mult: "4.6" });
  assert.equal(costDirection(1000, 1000).dir, "same");
  // anything that ROUNDS to 1× is "same" too — "~1× more" is not a statement
  assert.equal(costDirection(1000, 1020).dir, "same");
  assert.equal(costDirection(0, 0).dir, "same", "an empty session claims nothing");
});

test("buildPanelHtml: a first turn that only writes a cache does not claim a saving", () => {
  // 1k + 2.0×100k = 201k with cache; 1k + 100k = 101k without. Saying
  // "without cache would be 2× more" here is the opposite of the arithmetic.
  const en = buildPanelHtml(WARMUP_TOTALS, W, QUOTA_OFF, 1000, "en");
  assert.match(en, /without cache ≈ 101k tok — ~2× less, so far/);
  assert.ok(!/101k tok — ~2× more/.test(en));
  assert.match(en, /The cache has not earned back what it cost yet/, "the ⓘ explains it instead of claiming a saving");
  assert.match(en, /A cache write is charged at more than a fresh input token/, "and names the cause that applies: this session HAS written to cache");
  assert.ok(!/Cache saved/.test(en), "a saving of zero is not a saving");

  const ru = buildPanelHtml(WARMUP_TOTALS, W, QUOTA_OFF, 1000, "ru");
  assert.match(ru, /без кэша было бы ≈ 101k ток — пока в ~2× меньше/);
  assert.match(ru, /Кэш пока не вернул того, что стоил/);
  assert.ok(!/Сэкономлено кэшем/.test(ru));
});

test("buildView: the hover says the same thing, and never the reverse", () => {
  const en = buildView(WARMUP_TOTALS, W, QUOTA_OFF, 1000, "en").tooltip;
  // The hover names no cause at all: it has no room for the three-way
  // explanation the panel's ⓘ carries, and naming the wrong one is worse.
  assert.match(en, /without cache ≈ \*\*101k\*\* \(~2× less, so far\)/);
  assert.ok(!/has not earned back/.test(en));
  const ru = buildView(WARMUP_TOTALS, W, QUOTA_OFF, 1000, "ru").tooltip;
  assert.match(ru, /без кэша ≈ \*\*101k\*\* \(пока в ~2× меньше\)/);
});

test("buildCodexPanelHtml: a cacheReadWeight above 1 inverts Codex too — and is stated honestly", () => {
  // The setting allows up to 100. At 2.0 a cached token is priced above a fresh
  // one, so the with-cache figure overtakes the without-cache one.
  const html = buildCodexPanelHtml(
    { state: "ok", fiveH: null, sevenD: null }, 1000, "en",
    { source: "stdio", usage: ORDER_CODEX_USAGE, weights: { cacheRead: 2, cacheWrite: 1.25 } }
  );
  // fresh 20k + out 5k + 80k×2 = 185k with cache; 100k + 5k = 105k without.
  assert.match(html, /≥ 185k tok/);
  assert.match(html, /without cache ≈ 105k tok — ~1\.8× less/);
  assert.ok(!/Cache saved/.test(html));
  // This payload states no write count, so nothing here can be blamed on a
  // warm-up: the read weight is the only thing that inverted it. (Codex DOES
  // carry a write counter and a stated one IS priced — see the warm-up test.)
  assert.match(html, /Cached input is priced above fresh input here/);
  assert.ok(!/A cache write is charged at more than a fresh input token/.test(html));
});

test("idleRebuildOf: a gap before any tier is stated is recorded as unjudged, not as zero", () => {
  const raw = [
    turn({ id: "a", at: "2026-08-25T10:00:00Z", write: 1000 }), // no tier stated
    turn({ id: "b", at: "2026-08-25T10:30:00Z", write: 50_000 }), // 30 min later
    turn({ id: "c", at: "2026-08-25T10:31:00Z", write: 2000, tier: "5m" }),
  ].join("\n");
  const r = idleRebuildOf(raw);
  assert.equal(r.tokens, 0, "with no stated TTL nothing can be counted — unchanged");
  assert.ok(r.unjudged >= 1, "but the 30-minute gap is remembered as unmeasured");
});

test("idleRebuildOf: a broken clock is unjudged too, and a clean log has none", () => {
  const skewed = [
    turn({ id: "a", at: "2026-08-25T10:00:00Z", write: 1000, tier: "5m" }),
    turn({ id: "b", at: "2026-08-25T09:50:00Z", write: 2000, tier: "5m" }),
  ].join("\n");
  assert.ok(idleRebuildOf(skewed).unjudged >= 1);
  const clean = [
    turn({ id: "a", at: "2026-08-25T10:00:00Z", write: 1000, tier: "5m" }),
    turn({ id: "b", at: "2026-08-25T10:01:00Z", write: 2000, tier: "5m" }),
  ].join("\n");
  assert.equal(idleRebuildOf(clean).unjudged, 0, "a log with nothing to hide reports nothing");
});

test("buildPanelHtml: a zero built on an unjudged gap is a dash, not a 0%", () => {
  // absence of evidence is not evidence of absence — and the row says so, in
  // both directions of the same session
  const html = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "ru",
    undefined, undefined, undefined,
    [IDLE_AGENT, { ...PATIENT_AGENT, rebuild: REB({ cacheWrite: 800_000, unjudged: 1 }) }],
    1_000_000, undefined, true
  );
  assert.match(html, /после пауз 25% \(≈ 500k\)/);
  assert.match(html, /после пауз —/);
  assert.ok(!/после пауз 0%/.test(html));
});

test("addRebuild: the unjudged count survives being summed across agents", () => {
  const a = REB({ tokens: 100, tokens5m: 100, cacheWrite: 500, streams: 1, unjudged: 2 });
  const b = REB({ cacheWrite: 700, unjudged: 3 });
  assert.equal(addRebuild(a, b).unjudged, 5);
});

// ---------------------------------------------------------------------------
// Round 3 — five edge cases the second review found in the round-2 fixes.
// Every one of them is a statement the UI could make that the numbers do not
// support, which is the only kind of defect that matters in a tool whose whole
// claim is that its numbers can be trusted.
// ---------------------------------------------------------------------------

test("the ⓘ follows the exact numbers, not the rounded direction", () => {
  // 100k work + 5k cache read: with cache 100.5k, without 105k. That rounds to
  // "1×", so the visible line says "about the same" — but the cache HAS saved
  // 4.5k, and the footnote must not tell the reader it has not paid off yet.
  const totals = {
    input: 50_000, output: 50_000, work: 100_000,
    cacheRead: 5_000, cacheWrite: 0,
    cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0,
  };
  const en = buildPanelHtml(totals, W, QUOTA_OFF, 1000, "en");
  assert.match(en, /without cache ≈ 105k tok — about the same so far/, "presentation rounds");
  assert.match(en, /Cache saved: ≈ 4\.5k tok/, "the footnote does not round the sign away");
  assert.ok(!/has not earned back what it cost/.test(en));
});

test("with nothing written to cache, the inversion is blamed on the weight, not on a write", () => {
  // cacheReadWeight 2.0 (the setting allows up to 100) and no writes at all:
  // the with-cache figure is larger, but no cache write caused that.
  const heavy = { cacheRead: 2, cacheWrite: 1.25 };
  const totals = {
    input: 500, output: 500, work: 1000,
    cacheRead: 100_000, cacheWrite: 0,
    cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0,
  };
  const en = buildPanelHtml(totals, heavy, QUOTA_OFF, 1000, "en");
  assert.match(en, /≈ 201k tok/);
  assert.match(en, /Cached input is priced above fresh input here/);
  assert.ok(!/A cache write is charged at more/.test(en), "no write happened — naming one invents a cause");
});

test("a comparison against zero states the direction and skips the ratio", () => {
  // cacheReadWeight 0 is explicitly allowed: with only cached input, the
  // with-cache figure is 0. "About the same as 100k" would be nonsense, and so
  // would a multiplier — there is nothing to divide by.
  const free = { cacheRead: 0, cacheWrite: 1.25 };
  const totals = {
    input: 0, output: 0, work: 0,
    cacheRead: 100_000, cacheWrite: 0,
    cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0,
  };
  assert.deepEqual(costDirection(0, 100_000), { dir: "more", mult: null });
  const en = buildPanelHtml(totals, free, QUOTA_OFF, 1000, "en");
  assert.match(en, /without cache ≈ 100k tok(?!.*×)/, "the figure, no invented ratio");
  assert.ok(!/about the same/.test(en));
  assert.match(en, /Cache saved: ≈ 100k tok\./, "and the saving is still stated, without a multiplier");
});

test("a measured-in-part idle figure is marked as a floor, never as the number", () => {
  const partial = {
    ...IDLE_AGENT,
    rebuild: REB({ tokens: 400_000, tokens5m: 400_000, cacheWrite: 900_000, streams: 1, unjudged: 1 }),
  };
  const idle = agentIdle(partial, W);
  assert.equal(idle.atLeast, true);
  const ru = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "ru",
    undefined, undefined, undefined, [partial], 1_000_000, undefined, true
  );
  assert.match(ru, /после пауз ≥ 25% \(≥ 500k\)/, "the real figure can only be higher, so the row says so");
  const en = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, [partial], 1_000_000, undefined, true
  );
  assert.match(en, /after pauses ≥ 25% \(≥ 500k\)/);
  assert.match(en, /≥ marks a figure measured from part of the log only/, "the marker is explained where it appears");
  // …and the explanation is not shown when nothing carries the marker
  const exact = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, [IDLE_AGENT], 1_000_000, undefined, true
  );
  assert.ok(!/≥ marks a figure/.test(exact));
});

test("the section total is marked as a floor on the same rule", () => {
  const partial = REB({ tokens: 3_000_000, tokens5m: 3_000_000, cacheWrite: 6_000_000, streams: 2, unjudged: 4 });
  const html = buildPanelHtml(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, REBUILD_SUBS, 30_000_000, { subagents: partial }
  );
  // 3M five-minute tokens cost 3.75M: a FLOOR must show 3.7M, never 3.8M —
  // rounding a lower bound upward claims more than was measured.
  assert.match(html, /of that, ≥ 3\.7M \(≥18% of what the agents spent\)/);
  // and stays an "≈" when everything was measured
  const full = REB({ tokens: 3_000_000, tokens5m: 3_000_000, cacheWrite: 6_000_000, streams: 2 });
  const clean = buildPanelHtml(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, REBUILD_SUBS, 30_000_000, { subagents: full }
  );
  assert.match(clean, /of that, ≈ 3\.8M \(19% of what the agents spent\)/);
});

// ---------------------------------------------------------------------------
// Round 4 — the third review's findings. Same theme throughout: a statement the
// numbers do not support, in a tool whose entire claim is that its numbers can
// be trusted.
// ---------------------------------------------------------------------------

test("agentIdle: an agent that spent nothing has no share to state", () => {
  // 0/0 is not a zero. An empty log, a log of placeholders, or a read that
  // failed all arrive here as effective 0 — none of them is "it never waited".
  const empty = agentIdle({ ...PATIENT_AGENT, effective: 0, rebuild: REB({}) }, W);
  assert.equal(empty.known, false);
  const html = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "ru",
    undefined, undefined, undefined,
    [IDLE_AGENT, { ...PATIENT_AGENT, effective: 0, rebuild: REB({}) }],
    1_000_000, undefined, true
  );
  assert.match(html, /после пауз —/);
  assert.ok(!/после пауз 0%/.test(html));
});

test("agentIdle: a sub-1% share with unjudged gaps states the tokens, not a bound both ways", () => {
  // "<1%" is an upper bound on what WAS measured; the unjudged part makes the
  // real figure a floor. Saying both at once ("≥ <1%") is not a statement, so
  // the share is left out and the tokens carry the ≥.
  const partial = {
    ...IDLE_AGENT,
    rebuild: REB({ tokens: 3_000, tokens5m: 3_000, cacheWrite: 900_000, streams: 1, unjudged: 1 }),
  };
  const idle = agentIdle(partial, W);
  assert.equal(idle.pctText, null);
  assert.equal(idle.atLeast, true);
  const ru = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "ru",
    undefined, undefined, undefined, [partial], 1_000_000, undefined, true
  );
  assert.match(ru, /после пауз ≥ 3\.7k/, "3.75k floored, not rounded up");
  assert.ok(!/<1%/.test(ru));
});

test("the lead's own reloads carry the same floor marker as the panel rows", () => {
  const partial = REB({ tokens: 900_000, tokens1h: 900_000, cacheWrite: 5_000_000, streams: 1, unjudged: 2 });
  const marked = buildView(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, undefined, { lead: partial }
  );
  assert.match(marked.tooltip, /reloads after pauses ≥ 900k/, "a quieter line is still a claim");
  const full = REB({ tokens: 900_000, tokens1h: 900_000, cacheWrite: 5_000_000, streams: 1 });
  const exact = buildView(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, undefined, { lead: full }
  );
  assert.match(exact.tooltip, /reloads after pauses 900k/);
  assert.ok(!/≥/.test(exact.tooltip));
});

test("the hover's subagent fragment is marked too, on the same rule", () => {
  const partial = REB({ tokens: 3_000_000, tokens5m: 3_000_000, cacheWrite: 6_000_000, streams: 2, unjudged: 3 });
  const v = buildView(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, REBUILD_SUBS, { subagents: partial }
  );
  assert.match(v.tooltip, /≥ 3\.7M reloaded after pauses/);
});

test("with no cache activity at all, the ⓘ says exactly that", () => {
  // work only: the two figures are the same number, and neither a warm-up write
  // nor a read weight has anything to do with it.
  const bare = {
    input: 60_000, output: 40_000, work: 100_000,
    cacheRead: 0, cacheWrite: 0,
    cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0,
  };
  const en = buildPanelHtml(bare, W, QUOTA_OFF, 1000, "en");
  assert.match(en, /Nothing has been read from or written to cache in this session yet/);
  assert.ok(!/Cached input is priced above fresh input/.test(en));
  assert.ok(!/A cache write is charged at more/.test(en));
  const ru = buildPanelHtml(bare, W, QUOTA_OFF, 1000, "ru");
  assert.match(ru, /кэш ещё не читался и не записывался/);

  // Codex, the same case but NOT the same sentence: it reports cached input
  // only, so "nothing has been written to cache" is a fact it cannot give us.
  const codex = buildCodexPanelHtml(
    { state: "ok", fiveH: null, sevenD: null }, 1000, "en",
    { source: "stdio", usage: { totalTokens: 105_000, lastTokens: 0, inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 5_000, reasoningOutputTokens: 0 } }
  );
  assert.match(codex, /Nothing has been read from cache in this session yet/);
  assert.ok(!/read from or written to cache/.test(codex));
});

test("a saving the display rounds to 1× is stated without a contradictory multiplier", () => {
  const totals = {
    input: 50_000, output: 50_000, work: 100_000,
    cacheRead: 5_000, cacheWrite: 0,
    cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0,
  };
  const en = buildPanelHtml(totals, W, QUOTA_OFF, 1000, "en");
  assert.match(en, /Cache saved: ≈ 4\.5k tok\./);
  assert.ok(!/~1× lower/.test(en), "the line above already called the two the same");
});

test("agent-written text is escaped, tags and all", () => {
  // A task description is written by a model, not by us. The panel renders it
  // inside a webview: an unescaped one is a script-injection hole, and the
  // previous "escapes nothing dangerous" test never passed a hostile string.
  const hostile = {
    ...IDLE_BASE,
    agentType: '<img src=x onerror="alert(1)">',
    description: '</span><script>alert(2)</script>',
    modelLabel: "Opus 5 <b>",
    effective: 1_000_000,
    rebuild: REB({ cacheWrite: 100_000 }),
  };
  const html = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, [hostile], 1_000_000, undefined, true
  );
  assert.ok(!/<script>/.test(html), "no raw script tag reaches the page");
  assert.ok(!/<img src=x/.test(html), "nor a raw img tag");
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /&lt;script&gt;/);
});

test("the toggle stays wired: registered, allow-listed, and rendered from one constant", () => {
  // The rendered href and the package contribution are already pinned. This
  // closes the third hole: the command URI is inert unless the panel is created
  // with the allow-list AND the command is registered.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require("path") as typeof import("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "extension.ts"), "utf-8");
  assert.match(src, /registerCommand\(DELEGATED_TOGGLE_COMMAND/, "the command must exist to be clickable");
  assert.match(src, /enableCommandUris: \[DELEGATED_TOGGLE_COMMAND\]/, "and the webview must allow exactly it");
  assert.match(src, /globalState\.update\(DELEGATED_STATE_KEY/, "and the choice must survive a reload");
});

// ---------------------------------------------------------------------------
// Round 5 — the fourth review. A lower bound that rounds UP is not a lower
// bound, and a cause is not established by the mere existence of the thing that
// could have caused it.
// ---------------------------------------------------------------------------

test("fmtTokens: a floor truncates the decimal, an ordinary figure rounds it", () => {
  assert.equal(fmtTokens(3_750_000), "3.8M");
  assert.equal(fmtTokens(3_750_000, true), "3.7M", "≥ 3.8M would claim more than was measured");
  assert.equal(fmtTokens(3_990), "4k");
  assert.equal(fmtTokens(3_990, true), "3.9k");
});

test("agentIdle: a floored share never rounds up past what was measured", () => {
  // 25.6k five-minute tokens = 32k token-equivalent = 1.6% of a 2M agent.
  const partial = {
    ...IDLE_AGENT,
    rebuild: REB({ tokens: 25_600, tokens5m: 25_600, cacheWrite: 900_000, streams: 1, unjudged: 1 }),
  };
  assert.equal(agentIdle(partial, W).pctText, "1", "1.6% floored — ≥ 2% would be false");
  // the same agent WITHOUT unjudged gaps is an exact figure, so it rounds
  const exact = { ...IDLE_AGENT, rebuild: REB({ tokens: 25_600, tokens5m: 25_600, cacheWrite: 900_000, streams: 1 }) };
  assert.equal(agentIdle(exact, W).pctText, "2");
});

test("the cause is the side that actually moved the number, not the side that exists", () => {
  // Reads at weight 2 push the figure up by 100k; the one write, at weight 0.5,
  // pulls it DOWN by 5k. A classifier keying on "is there a write" blames the
  // write — the wrong half of the arithmetic.
  const mixed = {
    input: 500, output: 500, work: 1000,
    cacheRead: 100_000, cacheWrite: 10_000,
    cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 10_000,
  };
  const html = buildPanelHtml(mixed, { cacheRead: 2, cacheWrite: 0.5 }, QUOTA_OFF, 1000, "en");
  assert.match(html, /Cached input is priced above fresh input here/);
  assert.ok(!/A cache write is charged at more/.test(html));
});

test("a working cache that changes nothing is not called a saving, a warm-up, or a weight", () => {
  // cacheReadWeight exactly 1: cached input is priced the SAME as fresh, so the
  // two figures match. Saying it is priced "above" fresh input is simply false.
  const totals = {
    input: 100, output: 0, work: 100,
    cacheRead: 100, cacheWrite: 0,
    cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0,
  };
  const en = buildPanelHtml(totals, { cacheRead: 1, cacheWrite: 1.25 }, QUOTA_OFF, 1000, "en");
  assert.match(en, /it is not moving this figure either way/);
  assert.ok(!/priced above fresh input/.test(en));
  // …and it claims no exact cancellation either: display rounding can hide a
  // saving too small to change the figure, so "saves exactly what it costs"
  // would be a claim about numbers nobody can see.
  assert.ok(!/exactly what it costs/.test(en));
  assert.ok(!/Nothing has been read from or written to cache/.test(en), "the cache IS being used");
  const ru = buildPanelHtml(totals, { cacheRead: 1, cacheWrite: 1.25 }, QUOTA_OFF, 1000, "ru");
  assert.match(ru, /не меняет ни в одну сторону/);

  // Codex reaches the same state through its own weight setting.
  const codex = buildCodexPanelHtml(
    { state: "ok", fiveH: null, sevenD: null }, 1000, "en",
    {
      source: "stdio",
      weights: { cacheRead: 1, cacheWrite: 1.25 },
      usage: { totalTokens: 105_000, lastTokens: 0, inputTokens: 100_000, cachedInputTokens: 80_000, outputTokens: 5_000, reasoningOutputTokens: 0 },
    }
  );
  assert.match(codex, /it is not moving this figure either way/);
});

test("the lead's floored reload figure reads the same in Russian", () => {
  const partial = REB({ tokens: 3_750_000, tokens1h: 3_750_000, cacheWrite: 9_000_000, streams: 1, unjudged: 1 });
  const ru = buildView(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "ru",
    undefined, undefined, undefined, undefined, { lead: partial }
  );
  assert.match(ru.tooltip, /повторные загрузки после пауз ≥ 3\.7M/);
});

test("the ≥ carries its own definition where nothing else on the surface gives one", () => {
  // Round 16. `panelAtLeastNote` hangs off the delegated section, which can be
  // absent entirely — the LEAD's own reloads do not depend on any agent being
  // listed, and the hover has no ⓘ at all. A marker with no definition in view
  // is a figure the reader cannot interpret.
  const partial = REB({ tokens: 3_750_000, tokens1h: 3_750_000, cacheWrite: 9_000_000, streams: 1, unjudged: 1 });
  const en = buildView(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, undefined, { lead: partial }
  );
  assert.match(en.tooltip, /the real figure can be higher, never lower/);
  const enPanel = buildPanelHtml(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, undefined, undefined, { lead: partial }
  );
  assert.match(enPanel, /the real figure can be higher, never lower/);
  const ruPanel = buildPanelHtml(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "ru",
    undefined, undefined, undefined, undefined, undefined, { lead: partial }
  );
  assert.match(ruPanel, /настоящее число может быть больше, но не меньше/);

  // A complete measurement prints no marker, so it needs no explanation either.
  const whole = REB({ tokens: 3_750_000, tokens1h: 3_750_000, cacheWrite: 9_000_000, streams: 1 });
  const clean = buildPanelHtml(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, undefined, undefined, { lead: whole }
  );
  assert.ok(!/≥ = measured from part of the log/.test(clean));
});

// ---------------------------------------------------------------------------
// Round 6 — the fifth review. Two of these are the same lesson twice: a rule
// applied to most of the places it belongs is not applied.
// ---------------------------------------------------------------------------

test("fmtTokens: floor mode floors below 1k too, not only in k and M", () => {
  assert.equal(fmtTokens(999.5, true), "999", "≥ 1000 for a measured 999.5 is a false floor");
  assert.equal(fmtTokens(999.5), "1000", "an ordinary figure still rounds");
  assert.equal(fmtTokens(0.6, true), "0");
});

test("costCauseHint: components that cancel out are not a warm-up", () => {
  // read 100 at weight .75 saves 25; one unknown-tier write of 100 at 1.25
  // costs 25. Net zero: the cache has earned back exactly what it cost, and
  // "has not earned back what it cost yet" would be false.
  const totals = {
    input: 100, output: 0, work: 100,
    cacheRead: 100, cacheWrite: 100,
    cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 100,
  };
  const weights = { cacheRead: 0.75, cacheWrite: 1.25 };
  assert.equal(effectiveTokens(totals, weights), 300);
  const en = buildPanelHtml(totals, weights, QUOTA_OFF, 1000, "en");
  assert.match(en, /it is not moving this figure either way/);
  assert.ok(!/has not earned back what it cost/.test(en));
});

test("no surface asserts a cache lifetime the transcript has not stated", () => {
  // The detector reads each stream's own TTL. Any text that states one as a
  // universal fact can contradict the very number printed beside it.
  const html = buildPanelHtml(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, REBUILD_SUBS, 30_000_000, { subagents: REBUILD_LOUD }, true
  );
  assert.ok(!/5 minutes for subagents/.test(html));
  assert.ok(!/\(5 minutes for an agent\)/.test(html));
  assert.ok(!/cache stays warm for 5 minutes/.test(html), "…the unqualified form of the summary line");
  assert.match(html, /usually stays warm for 5 minutes/);
  const ru = buildPanelHtml(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "ru",
    undefined, undefined, undefined, REBUILD_SUBS, 30_000_000, { subagents: REBUILD_LOUD }, true
  );
  assert.ok(!/5 минут у субагентов/.test(ru));
  assert.match(ru, /обычно держится 5 минут/);
});

// ---------------------------------------------------------------------------
// Round 7 — the sixth review. Every one of these is a sentence that promises
// more than the numbers behind it can deliver.
// ---------------------------------------------------------------------------

test("the warm-up footnote does not promise a payback the settings can forbid", () => {
  // With cacheReadWeight above 1, later reads make the figure LARGER. Saying a
  // write "earns that back on the reads that follow" is then simply false, so
  // the promise is scoped to the default weight instead of stated as a rule.
  const en = buildPanelHtml(WARMUP_TOTALS, W, QUOTA_OFF, 1000, "en");
  assert.match(en, /At the default read weight \(0\.1\) each later read on the same cache narrows that gap/);
  assert.ok(!/and earns that back on the reads that follow/.test(en));
  // …and the rule itself is about the PREMIUM, not about raw token counts: a
  // session can write more than it reads and still show the smaller figure.
  assert.match(en, /While the premium those writes pay is bigger than anything read back from the cache has saved/);
  assert.ok(!/written more than it has read back/.test(en));
});

test("the cache footnote does not put every subagent in the 5-minute tier", () => {
  const en = buildPanelHtml(REBUILD_TOTALS, W, QUOTA_OFF, 1000, "en", undefined, { tier: "5m", hitRatePct: 82 });
  assert.match(en, /\(usually\) a subagent/);
  assert.ok(!/limit, or subagents —/.test(en));
});

test("a zero idle share claims a measured cost of nothing, not an absence of pauses", () => {
  // A reload priced to zero (cacheWriteWeight 0 is a legal setting) is still a
  // pause that outlived the cache: the legend must not deny that it happened.
  const en = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, [PATIENT_AGENT], 1_000_000, undefined, true
  );
  assert.match(en, /0% means no waiting cost was measured for it/);
  assert.ok(!/none outlived its cache/.test(en));
});

test("the reload advice describes what the waiting agent pays, not a fresh agent's bill", () => {
  // The counterfactual is never computed, so it cannot be promised.
  const en = buildPanelHtml(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, REBUILD_SUBS, 30_000_000, { subagents: REBUILD_LOUD }
  );
  assert.match(en, /starting a fresh agent with a smaller prompt is often cheaper/);
  assert.ok(!/a fresh agent costs less than the one that waited/.test(en));
});

// ---------------------------------------------------------------------------
// Round 15 — the fifteenth review. The advice used to open by naming ONE cause
// ("usually an agent left open while another one works"). Re-measured on 507
// agent logs here: 188 of the 448 counted gaps, carrying 46% of the tokens, run
// from the agent's own Bash tool_use to its tool_result — a test suite, a build.
// The measurement is a gap longer than the cache's life and nothing more; it
// never looks inside the gap, so it cannot pick between the two causes.
// ---------------------------------------------------------------------------

test("the reload advice names both causes of a pause, not just the one it can act on", () => {
  const en = buildPanelHtml(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, REBUILD_SUBS, 30_000_000, { subagents: REBUILD_LOUD }
  );
  // The agent's own long command is named…
  assert.match(en, /own command running long/);
  // …and the "close it instead" advice is scoped to the case it fits, never
  // offered as the explanation of every figure.
  assert.match(en, /Where it is the first/);
  assert.ok(!/Usually an agent left open while another one works/.test(en));
  const ru = buildPanelHtml(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "ru",
    undefined, undefined, undefined, REBUILD_SUBS, 30_000_000, { subagents: REBUILD_LOUD }
  );
  assert.match(ru, /собственная долгая команда/);
  assert.match(ru, /В первом случае/);
  assert.ok(!/Обычно это агент, оставленный открытым/.test(ru));
});

// ---------------------------------------------------------------------------
// Round 8 — the seventh review. Both of these are the same defect in different
// clothes: a sentence that is true of one row applied to every row.
// ---------------------------------------------------------------------------

test("the idle legend blames a cold cache only where a cost was measured", () => {
  // `0%` can be a one-turn agent that never paused, and `—` means "we cannot
  // tell". Neither observation supports "the cache went cold": that sentence
  // belongs to the rows that carry a figure above zero.
  const en = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, [PATIENT_AGENT], 1_000_000, undefined, true
  );
  assert.match(en, /A figure above zero means one of its pauses outlasted its cache/);
  assert.ok(!/not the agent&#39;s doing either way/.test(en), "…the form that covered 0% and — as well");
  assert.ok(!/It is not the agent/.test(en));
  const ru = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "ru",
    undefined, undefined, undefined, [PATIENT_AGENT], 1_000_000, undefined, true
  );
  assert.match(ru, /Цифра больше нуля значит, что одна из пауз пережила его кэш/);
  assert.ok(!/И в том, и в другом случае/.test(ru));
});

test("the idle legend states a pause, never what the measurement did not look at", () => {
  // Round 15. `idleRebuildOf` compares two timestamps against the live cache
  // lifetime and never reads what lies between them, so "its cache went cold
  // while it was left open" asserted a cause the measurement cannot see — and
  // on this machine's 507 agent logs it is the wrong cause for 46% of the
  // tokens it counts.
  const en = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, [PATIENT_AGENT], 1_000_000, undefined, true
  );
  // Round 16 sharpened this: the tool call IS in the transcript, so "not in the
  // log" was itself a claim the data contradicts. What is true is narrower —
  // this measurement never looks.
  assert.match(en, /This measurement does not look at what filled the pause/);
  assert.ok(!/What filled that pause is not in the log/.test(en));
  assert.match(en, /its own\s+command may have run long/);
  assert.ok(!/is not the agent&#39;s doing: its cache went cold while it was left open/.test(en));
  const ru = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "ru",
    undefined, undefined, undefined, [PATIENT_AGENT], 1_000_000, undefined, true
  );
  assert.match(ru, /Чем была занята пауза, этот замер не смотрит/);
  assert.match(ru, /его собственная\s+команда/);
  assert.ok(!/не вина агента: его кэш остыл/.test(ru));
});

test("a premium too small to change either figure is not announced as one", () => {
  // 5,005 read at 0.1 saves 4,504.5; 18,019 written on the 5-minute tier costs
  // 4,504.75. The with-cache figure really is larger — by a quarter of a token,
  // so both print as the same 23k and the line above says "about the same". A
  // footnote naming one of them the larger contradicts what the reader sees.
  const totals = {
    input: 0, output: 0, work: 0,
    cacheRead: 5005, cacheWrite: 18019,
    cacheWrite1h: 0, cacheWrite5m: 18019, cacheWriteUnknown: 0,
  };
  // The exact premium is +0.25, so the displayed figures are the same number
  // while the arithmetic behind the hint still points one way.
  assert.equal(effectiveTokens(totals, W), 18019 + 5005);
  const en = buildPanelHtml(totals, W, QUOTA_OFF, 1000, "en");
  assert.match(en, /about the same so far/);
  // …but not "the cache moves nothing" either: the premium is real, it is just
  // smaller than anything this page prints.
  assert.match(en, /by too little to change either figure/);
  assert.ok(!/the with-cache figure is the larger of the two/.test(en));
  assert.ok(!/it is not moving this figure either way/.test(en));
  const ru = buildPanelHtml(totals, W, QUOTA_OFF, 1000, "ru");
  assert.match(ru, /пока примерно столько же/);
  assert.match(ru, /слишком мала, чтобы изменить хоть одну/);
  assert.ok(!/число с кэшем оказывается больше/.test(ru));
  assert.ok(!/не меняет ни в одну сторону/.test(ru));
  // …and a premium the display CAN show still names its cause.
  const visible = buildPanelHtml(WARMUP_TOTALS, W, QUOTA_OFF, 1000, "en");
  assert.match(visible, /the with-cache figure is the larger of the two/);
});

test("a visible difference keeps its cause even when the RATIO rounds to 1x", () => {
  // Round 9 caught the first fix suppressing a real cause: "about the same" is
  // a rounded RATIO (1.04× here), not two equal figures. 1k of work plus a
  // 5-minute write of 200 shows 1.3k against 1.2k — different numbers on the
  // screen, so the premium that separates them must still be named.
  const totals = {
    input: 500, output: 500, work: 1000,
    cacheRead: 0, cacheWrite: 200,
    cacheWrite1h: 0, cacheWrite5m: 200, cacheWriteUnknown: 0,
  };
  assert.equal(fmtTokens(effectiveTokens(totals, W)), "1.3k");
  assert.equal(fmtTokens(1200), "1.2k");
  assert.equal(costDirection(effectiveTokens(totals, W), 1200).dir, "same", "the ratio rounds to 1×");
  const en = buildPanelHtml(totals, W, QUOTA_OFF, 1000, "en");
  assert.match(en, /the with-cache figure is the larger of the two/);
  assert.ok(!/it is not moving this figure either way/.test(en));
  const ru = buildPanelHtml(totals, W, QUOTA_OFF, 1000, "ru");
  assert.match(ru, /число с кэшем оказывается больше/);
  assert.ok(!/не меняет ни в одну сторону/.test(ru));
});

test("a difference the FIGURES hide is still named when the multiplier shows it", () => {
  // Round 10 caught the second fix over-reaching in the other direction: both
  // figures print "1.2M" here, but the line beside them says "~1.1× less, so
  // far". 1.249M against 1.151M — a 98k premium the page DOES state, so a
  // footnote calling the difference invisible would contradict it.
  const totals = {
    input: 400_000, output: 359_000, work: 759_000,
    cacheRead: 0, cacheWrite: 392_000,
    cacheWrite1h: 0, cacheWrite5m: 392_000, cacheWriteUnknown: 0,
  };
  assert.equal(effectiveTokens(totals, W), 1_249_000);
  assert.equal(fmtTokens(1_249_000), fmtTokens(1_151_000), "the two figures print the same text");
  assert.equal(costDirection(1_249_000, 1_151_000).mult, "1.1", "…and the multiplier does not");
  const en = buildPanelHtml(totals, W, QUOTA_OFF, 1000, "en");
  assert.match(en, /the with-cache figure is the larger of the two/);
  assert.ok(!/by too little to change either figure/.test(en));
  const ru = buildPanelHtml(totals, W, QUOTA_OFF, 1000, "ru");
  assert.match(ru, /число с кэшем оказывается больше/);
  assert.ok(!/слишком мала, чтобы изменить хоть одну/.test(ru));
});

test("when BOTH sides add, neither single-cause sentence is told", () => {
  // Round 11. `cacheReadWeight` above 1 makes reads add cost instead of saving
  // it. "The write premium is bigger than what the reads save" is then false
  // however the two compare — the reads save nothing at all.
  const totals = {
    input: 500, output: 500, work: 1000,
    cacheRead: 100_000, cacheWrite: 100_000,
    cacheWrite1h: 100_000, cacheWrite5m: 0, cacheWriteUnknown: 0,
  };
  const readsCost = { cacheRead: 2, cacheWrite: 1.25 };
  assert.equal(effectiveTokens(totals, readsCost), 401_000, "both contributions are +100k");
  const en = buildPanelHtml(totals, readsCost, QUOTA_OFF, 1000, "en");
  assert.match(en, /Both sides of the cache add to this figure here/);
  assert.ok(!/While the premium those writes pay is bigger than anything read back from the cache has saved/.test(en));
  assert.ok(!/Cached input is priced above fresh input here/.test(en));
  const ru = buildPanelHtml(totals, readsCost, QUOTA_OFF, 1000, "ru");
  assert.match(ru, /обе стороны кэша только увеличивают это число/);
  assert.ok(!/эта надбавка за записи больше/.test(ru));
  assert.ok(!/Ввод из кэша здесь оценён дороже свежего/.test(ru));
});

test("an invisible difference stays invisible even when both sides add", () => {
  // Round 12. Order matters: naming a cause the reader cannot find on the page
  // is the same defect whether the cause is one side or both. Premium 0.35, and
  // both figures print 1k.
  const totals = {
    input: 500, output: 500, work: 1000,
    cacheRead: 1, cacheWrite: 1,
    cacheWrite1h: 0, cacheWrite5m: 1, cacheWriteUnknown: 0,
  };
  const readsCost = { cacheRead: 1.1, cacheWrite: 1.25 };
  assert.equal(effectiveTokens(totals, readsCost), 1002);
  const en = buildPanelHtml(totals, readsCost, QUOTA_OFF, 1000, "en");
  assert.match(en, /by too little to change either figure/);
  assert.ok(!/Both sides of the cache add to this figure here/.test(en));
  const ru = buildPanelHtml(totals, readsCost, QUOTA_OFF, 1000, "ru");
  assert.match(ru, /слишком мала, чтобы изменить хоть одну/);
  assert.ok(!/обе стороны кэша только увеличивают это число/.test(ru));
});

test("no hint promises what the DEFAULT weights would do to this session", () => {
  // Round 12. Both promises were false in states that reach their own hint: a
  // write-only session at cacheWriteWeight 1 is level here and dearer at the
  // defaults, and at the defaults cacheRead=5 with an unknown-tier write of 18
  // cancels exactly — so "a difference appears as soon as the cache is used"
  // is disproved by the default weights themselves.
  const writeOnly = {
    input: 100, output: 0, work: 100,
    cacheRead: 0, cacheWrite: 100,
    cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 100,
  };
  const level = { cacheRead: 0.1, cacheWrite: 1 };
  const en = buildPanelHtml(writeOnly, level, QUOTA_OFF, 1000, "en");
  assert.match(en, /it is not moving this figure either way/);
  assert.ok(!/make reuse cheaper/.test(en), "…which it would not: at 1.25 this session is dearer");
  const ru = buildPanelHtml(writeOnly, level, QUOTA_OFF, 1000, "ru");
  assert.ok(!/переиспользование дешевле/.test(ru));
  // …and the no-cache hint promises no difference it cannot guarantee: at the
  // default weights, 5 read against an unknown-tier write of 18 cancels out.
  const cancels = {
    input: 0, output: 0, work: 0,
    cacheRead: 5, cacheWrite: 18,
    cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 18,
  };
  assert.equal(effectiveTokens(cancels, W), 5 + 18, "the default weights cancel exactly here");
  const untouched = {
    input: 600, output: 400, work: 1000,
    cacheRead: 0, cacheWrite: 0,
    cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0,
  };
  const noCacheEn = buildPanelHtml(untouched, W, QUOTA_OFF, 1000, "en");
  assert.ok(!/a difference appears as soon as the cache is used/.test(noCacheEn));
  assert.match(noCacheEn, /the weights in your settings decide whether they part company/);
  const noCacheRu = buildPanelHtml(untouched, W, QUOTA_OFF, 1000, "ru");
  assert.ok(!/разница появится, как только/.test(noCacheRu));
});
