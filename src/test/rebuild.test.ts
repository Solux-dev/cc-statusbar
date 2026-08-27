// What waiting costs: gaps judged against the cache lifetime live at the time,
// the thresholds that decide whether the figure is worth showing, and the
// counter sanitising that keeps a broken log from printing as a number.
//
// Lifted out of logic.test.ts unchanged and in order — no test was renamed,
// reordered, or rewritten in the move.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveTokens,
  sumTranscript,
  lastAssistantContext,
  agentDigest,
  lastCacheTier,
  idleRebuildOf,
  rebuildCost,
  addRebuild,
  cacheWriteSplit,
  cacheWriteTokens,
  tokenCount,
} from "../metrics";
import { buildView, buildPanelHtml } from "../render";
import { rebuildDisplay } from "../panelModel";
import { W, turn, REB, REBUILD_TOTALS, REBUILD_SUBS, REBUILD_LOUD, QUOTA_OFF } from "./fixtures";

// ── idle rebuild: what waiting costs ─────────────────────────────────────────

test("idleRebuildOf: the same 10-minute gap is a rebuild at 5m, but not at 1h", () => {
  // The pair is what makes this signal clean: a gap longer than the TTL of the
  // cache that was live, immediately followed by a write. A spike alone proves
  // nothing.
  const fiveM = [
    turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 1000, tier: "5m" }),
    turn({ id: "b", at: "2026-08-24T10:10:00Z", write: 50_000, tier: "5m" }),
  ].join("\n");
  const r5 = idleRebuildOf(fiveM);
  assert.equal(r5.tokens, 50_000);
  assert.equal(r5.tokens5m, 50_000);
  assert.equal(rebuildCost(r5, W), 62_500, "5-minute writes are priced x1.25");
  assert.equal(r5.streams, 1);
  assert.equal(r5.cacheWrite, 51_000, "the denominator is every write of the stream");

  const oneH = [
    turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 1000, tier: "1h" }),
    turn({ id: "b", at: "2026-08-24T10:10:00Z", write: 50_000, tier: "1h" }),
  ].join("\n");
  const r1 = idleRebuildOf(oneH);
  assert.equal(r1.tokens, 0, "ten minutes is well inside a 1-hour cache");
  assert.equal(r1.streams, 0);
});

test("idleRebuildOf: an hour-long gap does count on the 1-hour tier, at x2.0", () => {
  const raw = [
    turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 1000, tier: "1h" }),
    turn({ id: "b", at: "2026-08-24T11:30:00Z", write: 240_000, tier: "1h" }),
  ].join("\n");
  const r = idleRebuildOf(raw);
  assert.equal(r.tokens, 240_000);
  assert.equal(r.tokens1h, 240_000);
  assert.equal(rebuildCost(r, W), 480_000);
});

test("idleRebuildOf: each gap is judged by the tier live AT THE TIME, not the last one", () => {
  // A session that passes its plan limit switches 1h -> 5m mid-run. Judging the
  // whole file by the tier it ended on invents rebuilds in one direction and
  // loses them in the other.
  const raw = [
    turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 1000, tier: "1h" }),
    // 10 minutes later, while the 1-hour cache is still warm: NOT a rebuild
    turn({ id: "b", at: "2026-08-24T10:10:00Z", write: 2000, tier: "1h" }),
    // the account flips to the 5-minute tier here
    turn({ id: "c", at: "2026-08-24T10:12:00Z", write: 3000, tier: "5m" }),
    // 10 minutes later, now on a 5-minute cache: IS a rebuild
    turn({ id: "d", at: "2026-08-24T10:22:00Z", write: 80_000, tier: "5m" }),
  ].join("\n");
  const r = idleRebuildOf(raw);
  assert.equal(r.tokens, 80_000, "only the gap that outlived its own cache counts");
  assert.equal(r.tokens1h, 0);
  assert.equal(r.tokens5m, 80_000);
});

test("idleRebuildOf: a reload with no stated tier is priced by the setting, not a guess", () => {
  const raw = [
    turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 1000, tier: "5m" }),
    // the reload itself carries no breakdown — its tier is unknown
    turn({ id: "b", at: "2026-08-24T10:10:00Z", write: 40_000 }),
  ].join("\n");
  const r = idleRebuildOf(raw);
  assert.equal(r.tokens, 40_000);
  assert.equal(r.tokensUnknown, 40_000);
  assert.equal(rebuildCost(r, W), 50_000, "the 1.25 setting");
  assert.equal(rebuildCost(r, { cacheRead: 0.1, cacheWrite: 1 }), 40_000, "a tuned setting still governs it");
});

test("idleRebuildOf: dedup by message.id - a doubled transcript gives the same figure", () => {
  // One API response spans several jsonl lines (thinking / text / each tool_use)
  // and repeats its usage block verbatim. Without dedup this inflates ~2.5x.
  const a = turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 1000, tier: "5m" });
  const b = turn({ id: "b", at: "2026-08-24T10:10:00Z", write: 50_000, tier: "5m" });
  assert.deepEqual(idleRebuildOf([a, a, a, b, b].join("\n")), idleRebuildOf([a, b].join("\n")));
});

test("idleRebuildOf: no stated tier anywhere contributes nothing - a TTL is never assumed", () => {
  const raw = [
    turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 1000 }),
    turn({ id: "b", at: "2026-08-24T18:00:00Z", write: 300_000 }),
  ].join("\n");
  const r = idleRebuildOf(raw);
  assert.equal(r.tokens, 0);
  assert.equal(r.streams, 0);
  assert.equal(r.cacheWrite, 301_000, "the writes still exist, they are just not judged");
});

test("idleRebuildOf: a turn with no clock is a barrier, never a bridge", () => {
  // 10:00 -> [undated turn] -> 10:08 on a 5-minute stream. The undated turn
  // happened between them, so the 8-minute span is NOT a proven idle gap.
  const raw = [
    turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 1000, tier: "5m" }),
    turn({ id: "b", at: "", write: 500, tier: "5m" }),
    turn({ id: "c", at: "2026-08-24T10:08:00Z", write: 90_000, tier: "5m" }),
  ].join("\n");
  const r = idleRebuildOf(raw);
  assert.equal(r.tokens, 0, "a gap is never measured across a turn we cannot place");
  assert.equal(r.cacheWrite, 91_500, "but every write still counts toward the total");
});

test("idleRebuildOf: a clock that goes backwards never becomes a rebuild", () => {
  const raw = [
    turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 1000, tier: "5m" }),
    turn({ id: "b", at: "2026-08-24T09:50:00Z", write: 70_000, tier: "5m" }),
    turn({ id: "c", at: "2026-08-24T09:51:00Z", write: 80_000, tier: "5m" }),
  ].join("\n");
  const r = idleRebuildOf(raw);
  assert.equal(r.tokens, 0, "skew is a barrier: neither the jump back nor the minute after it");
  assert.equal(r.cacheWrite, 151_000);
});

test("idleRebuildOf: an agent stream counts only when sidechain turns are included", () => {
  const raw = [
    turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 1000, tier: "5m", sidechain: true }),
    turn({ id: "b", at: "2026-08-24T10:20:00Z", write: 90_000, tier: "5m", sidechain: true }),
  ].join("\n");
  assert.equal(idleRebuildOf(raw).tokens, 0, "read as a MAIN transcript: subagent turns are skipped");
  assert.equal(idleRebuildOf(raw, true).tokens, 90_000);
});

test("lastCacheTier: an agent file reports its own tier only with sidechain included", () => {
  const raw = turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 1000, tier: "5m", sidechain: true });
  assert.equal(lastCacheTier(raw), null);
  assert.equal(lastCacheTier(raw, true), "5m");
});

test("agentDigest: carries the agent's reload tokens (and no tier nobody reads)", () => {
  const raw = [
    turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 2000, tier: "5m", sidechain: true }),
    turn({ id: "b", at: "2026-08-24T10:30:00Z", write: 120_000, tier: "5m", sidechain: true }),
  ].join("\n");
  const d = agentDigest(raw);
  assert.equal(d.rebuild.tokens, 120_000);
  assert.equal(d.rebuild.unjudged, 0, "both gaps were judgeable");
  assert.equal(rebuildCost(d.rebuild, W), 150_000);
  assert.equal(d.totals.cacheWrite5m, 122_000);
});

test("cacheWriteSplit: writes are split by the tier the transcript states", () => {
  const both = { cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 60, ephemeral_5m_input_tokens: 40 } };
  assert.deepEqual(cacheWriteSplit(both), { h1: 60, m5: 40, unknown: 0 });
  // top-level larger than the breakdown: the remainder has no stated tier
  const partial = { cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 60, ephemeral_5m_input_tokens: 0 } };
  assert.deepEqual(cacheWriteSplit(partial), { h1: 60, m5: 0, unknown: 40 });
  // no breakdown at all
  assert.deepEqual(cacheWriteSplit({ cache_creation_input_tokens: 100 }), { h1: 0, m5: 0, unknown: 100 });
  // the fields CONTRADICT each other (nested claims more than the total): the
  // shape is corrupt, so no tier is trusted and the old total is preserved
  const corrupt = { cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 80, ephemeral_5m_input_tokens: 70 } };
  assert.deepEqual(cacheWriteSplit(corrupt), { h1: 0, m5: 0, unknown: 100 });
});

test("sumTranscript: the tier split never changes the cache-write total", () => {
  const raw = [
    turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 1000, tier: "1h" }),
    turn({ id: "b", at: "2026-08-24T10:01:00Z", write: 400, tier: "5m" }),
    turn({ id: "c", at: "2026-08-24T10:02:00Z", write: 700 }),
  ].join("\n");
  const t = sumTranscript(raw);
  assert.equal(t.cacheWrite, 2100, "the total is unchanged");
  assert.equal(t.cacheWrite1h, 1000);
  assert.equal(t.cacheWrite5m, 400);
  assert.equal(t.cacheWriteUnknown, 700, "no stated tier stays unknown - never guessed into a bucket");
  assert.equal(t.cacheWrite1h + t.cacheWrite5m + t.cacheWriteUnknown, t.cacheWrite);
});

test("effectiveTokens: a 1-hour write costs x2.0, a 5-minute one x1.25, unknown uses the setting", () => {
  const base = { input: 0, output: 0, work: 0, cacheRead: 0 };
  const t = (h1: number, m5: number, unk: number) => ({
    ...base,
    cacheWrite: h1 + m5 + unk,
    cacheWrite1h: h1,
    cacheWrite5m: m5,
    cacheWriteUnknown: unk,
  });
  assert.equal(effectiveTokens(t(1000, 0, 0), W), 2000);
  assert.equal(effectiveTokens(t(0, 1000, 0), W), 1250);
  assert.equal(effectiveTokens(t(0, 0, 1000), W), 1250);
  // the setting governs the unknown bucket ONLY, so nobody's config silently
  // changes what a tiered write means
  assert.equal(effectiveTokens(t(1000, 0, 0), { cacheRead: 0.1, cacheWrite: 1 }), 2000);
  assert.equal(effectiveTokens(t(0, 0, 1000), { cacheRead: 0.1, cacheWrite: 1 }), 1000);
});

test("rebuildDisplay: 2.9% of the session stays silent, 3.1% speaks", () => {
  const session = 100_000_000;
  // cost = tokens x 1.25 (5m tier)
  const under = REB({ tokens: 2_320_000, tokens5m: 2_320_000, cacheWrite: 100_000_000, streams: 3 });
  assert.equal(rebuildDisplay(under, session, W).show, false);
  const over = REB({ tokens: 2_480_000, tokens5m: 2_480_000, cacheWrite: 100_000_000, streams: 3 });
  assert.equal(rebuildDisplay(over, session, W).show, true);
});

test("rebuildDisplay: the guidance sentence needs 20% of what the agents wrote", () => {
  // both sit well above the "is it worth a line" bars; only the share of the
  // agents' own writes differs
  const session = 50_000_000;
  const quiet = REB({ tokens: 1_900_000, tokens5m: 1_900_000, cacheWrite: 10_000_000, streams: 2 });
  assert.equal(rebuildDisplay(quiet, session, W).show, true);
  assert.equal(rebuildDisplay(quiet, session, W).advise, false, "19% is below the bar");
  const loud = REB({ tokens: 2_100_000, tokens5m: 2_100_000, cacheWrite: 10_000_000, streams: 2 });
  assert.equal(rebuildDisplay(loud, session, W).advise, true, "21% is above it");
});

test("rebuildDisplay: below the absolute floor nothing is said at all", () => {
  // 90% of everything the agents wrote, but under 1M token-equivalent: real,
  // and not worth a line. Silence is the default.
  const r = REB({ tokens: 700_000, tokens5m: 700_000, cacheWrite: 780_000, streams: 1 });
  assert.deepEqual(rebuildDisplay(r, 2_000_000, W), { show: false, advise: false, cost: 875_000 });
  assert.deepEqual(rebuildDisplay(undefined, 2_000_000, W), { show: false, advise: false, cost: 0 });
});

test("rebuildDisplay: a session total of zero never divides by it", () => {
  const r = REB({ tokens: 5_000_000, tokens5m: 5_000_000, cacheWrite: 6_000_000, streams: 1 });
  assert.equal(rebuildDisplay(r, 0, W).show, false);
});

test("buildPanelHtml (en): the reload line sits under the delegated-work summary", () => {
  const html = buildPanelHtml(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, REBUILD_SUBS, 30_000_000, { subagents: REBUILD_LOUD }
  );
  assert.match(
    html,
    /of that, ≈ 3\.8M \(19% of what the agents spent\) went on reloading context after pauses/,
    "the share is the yardstick a per-agent % is read against"
  );
  assert.match(html, /cache usually stays warm for 5 minutes/, "true of every agent measured here, not guaranteed of all");
  assert.match(html, /While an agent waits, its cache goes cold/, "the footnote is attached");
  assert.match(html, /five minutes for most agents/, "the guidance sentence stays with the number, list open or not");
});

test("buildPanelHtml (ru): the same line and note, in Russian", () => {
  const html = buildPanelHtml(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "ru",
    undefined, undefined, undefined, REBUILD_SUBS, 30_000_000, { subagents: REBUILD_LOUD }
  );
  assert.match(html, /из них ≈ 3\.8M \(19% расхода агентов\) ушло на повторную загрузку контекста после пауз/);
  assert.match(html, /Пока агент ждёт, его кэш остывает/);
  assert.match(html, /у большинства агентов это пять минут/);
});

test("buildPanelHtml: below the threshold the section is exactly as before", () => {
  const quiet = REB({ tokens: 200_000, tokens5m: 200_000, cacheWrite: 6_000_000, streams: 1 });
  const html = buildPanelHtml(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, REBUILD_SUBS, 30_000_000, { subagents: quiet }
  );
  assert.ok(!/reloading context after pauses/.test(html));
  assert.ok(!/Past five minutes of waiting/.test(html));
  assert.match(html, /Delegated work/, "the rest of the section is untouched");
});

test("buildView: the reload fragment reaches the hover, but never the bar", () => {
  const v = buildView(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, REBUILD_SUBS, { subagents: REBUILD_LOUD }
  );
  assert.match(v.tooltip, /3\.8M reloaded after pauses/);
  assert.ok(!/reloaded/.test(v.text), "the collapsed bar gains no new segment");
});

test("buildView: the lead's own reloads are stated in Details, with no advice attached", () => {
  const lead = REB({ tokens: 900_000, tokens1h: 900_000, cacheWrite: 5_000_000, streams: 1 });
  const v = buildView(
    REBUILD_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, undefined, { lead }
  );
  assert.match(v.tooltip, /reloads after pauses 900k/, "RAW tokens, like every other figure on that line");
  assert.ok(!/costs less/.test(v.tooltip), "the owner stepping away is not a defect");
});

test("panel: the cache row drops the word Tier and keeps its footnote (en + ru)", () => {
  const cache = { tier: "1h" as const, hitRatePct: 98 };
  const en = buildPanelHtml(REBUILD_TOTALS, W, QUOTA_OFF, 1000, "en", undefined, cache);
  assert.match(en, /Cache stays warm ⓘ/);
  assert.match(en, /1 hour idle/);
  assert.ok(!/Tier ⓘ/.test(en));
  assert.match(en, /How long your prompt cache stays warm/, "same footnote as before");
  const ru = buildPanelHtml(REBUILD_TOTALS, W, QUOTA_OFF, 1000, "ru", undefined, cache);
  assert.match(ru, /Кэш держится ⓘ/);
  assert.match(ru, /1 час простоя/);
  assert.ok(!/Тир ⓘ/.test(ru));
  assert.match(ru, /Сколько prompt-кэш остаётся/);
});

test("idleRebuildOf: a clock that jumps back poisons the NEXT gap too, not just its own", () => {
  // 10:00 -> 09:50 (jump back) -> 10:10. Measuring 09:50 -> 10:10 as a
  // 20-minute pause uses a clock we have just seen misbehave.
  const raw = [
    turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 1000, tier: "5m" }),
    turn({ id: "b", at: "2026-08-24T09:50:00Z", write: 2000, tier: "5m" }),
    turn({ id: "c", at: "2026-08-24T10:10:00Z", write: 90_000, tier: "5m" }),
  ].join("\n");
  const r = idleRebuildOf(raw);
  assert.equal(r.tokens, 0);
  assert.equal(r.cacheWrite, 93_000, "every write still counts toward the total");
});

test("idleRebuildOf: a tier stated on a skewed turn is still remembered", () => {
  // The skewed turn is a barrier for TIME, not for what it tells us about the
  // cache. Here it is the ONLY turn that states the 5-minute tier: if the skew
  // branch skipped the tier update, the later 14-minute gap would still be
  // judged against the 1-hour cache and counted as no rebuild at all.
  const raw = [
    turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 1000, tier: "1h" }),
    turn({ id: "b", at: "2026-08-24T09:50:00Z", write: 2000, tier: "5m" }),
    turn({ id: "c", at: "2026-08-24T09:51:00Z", write: 3000 }),
    turn({ id: "d", at: "2026-08-24T10:05:00Z", write: 40_000 }),
  ].join("\n");
  const r = idleRebuildOf(raw);
  assert.equal(r.tokens, 40_000, "the first trustworthy gap after the skew is judged by the 5m tier");
  assert.equal(r.tokensUnknown, 40_000, "that reload states no tier of its own, so the setting prices it");
});

test("idleRebuildOf: a placeholder turn with no usage is not a turn at all", () => {
  // An interrupt or error is written as an assistant entry without `usage`.
  // Counting it would advance the clock and hide a real 10-minute pause.
  const placeholder = JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-24T10:08:00Z",
    message: { id: "x", model: "<synthetic>" },
  });
  const raw = [
    turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 1000, tier: "5m" }),
    placeholder,
    turn({ id: "b", at: "2026-08-24T10:10:00Z", write: 90_000, tier: "5m" }),
  ].join("\n");
  const r = idleRebuildOf(raw);
  assert.equal(r.tokens, 90_000, "the gap between the two REAL turns is ten minutes");
});

test("sumTranscript: a broken counter never prints as Infinity, NaN or a negative", () => {
  // 1e309 parses to Infinity out of perfectly valid JSON; a negative count is
  // not a smaller number, it is a broken field. Neither may reach the screen.
  const raw = JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-24T10:00:00Z",
    message: {
      id: "a",
      usage: { input_tokens: 1e309, output_tokens: -50, cache_read_input_tokens: 1e309 },
    },
  });
  const t = sumTranscript(raw);
  for (const [name, v] of Object.entries(t)) {
    assert.ok(Number.isFinite(v) && v >= 0, `${name} must stay a real, non-negative number (got ${v})`);
  }
  const ctx = lastAssistantContext(raw);
  assert.ok(ctx.tokens != null && Number.isFinite(ctx.tokens) && ctx.tokens >= 0);
});

test("tokenCount: a counter so large it would overflow a sum is refused", () => {
  // 1e308 is finite and positive, but two of them add to Infinity, and the
  // difference of two infinities is NaN - one fabricated line would turn every
  // figure on the panel into nonsense.
  assert.equal(tokenCount(1e308), 0);
  assert.equal(tokenCount(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.equal(tokenCount(1000), 1000);
  const raw = JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-24T10:00:00Z",
    message: {
      id: "a",
      usage: {
        input_tokens: 1e308,
        cache_creation: { ephemeral_1h_input_tokens: 1e308, ephemeral_5m_input_tokens: 1e308 },
      },
    },
  });
  const t = sumTranscript(raw);
  for (const [name, v] of Object.entries(t)) {
    assert.ok(Number.isFinite(v) && v >= 0, `${name} must stay a real number (got ${v})`);
  }
});

test("sumTranscript: a no-usage placeholder never consumes a real turn's id", () => {
  // Both entries carry id "b". If the placeholder is deduplicated first, the
  // real turn's tokens vanish from the totals while the reload metric still
  // counts them - and the panel would print a component larger than its total.
  const placeholder = JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-24T10:09:00Z",
    message: { id: "b", model: "<synthetic>" },
  });
  const raw = [
    turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 1000, tier: "5m" }),
    placeholder,
    turn({ id: "b", at: "2026-08-24T10:10:00Z", write: 90_000, tier: "5m" }),
  ].join("\n");
  const t = sumTranscript(raw);
  const r = idleRebuildOf(raw);
  assert.equal(t.cacheWrite, 91_000);
  assert.equal(r.tokens, 90_000);
  assert.ok(r.tokens <= t.cacheWrite, "a reload is always a subset of what was written");
});

test("cacheWriteTokens: a broken counter never subtracts from the session", () => {
  assert.equal(cacheWriteTokens({ cache_creation_input_tokens: -100 }), 0);
  assert.equal(cacheWriteTokens({ cache_creation_input_tokens: NaN }), 0);
  // a broken top-level still falls through to a usable breakdown
  assert.equal(
    cacheWriteTokens({
      cache_creation_input_tokens: -100,
      cache_creation: { ephemeral_1h_input_tokens: 60, ephemeral_5m_input_tokens: 40 },
    }),
    100
  );
  assert.deepEqual(cacheWriteSplit({ cache_creation_input_tokens: -100 }), { h1: 0, m5: 0, unknown: 0 });
});

test("cacheWriteSplit: an impossible breakdown never invents a tier", () => {
  // negative counters: nonsense data, so the whole write is untiered
  const negative = {
    cache_creation_input_tokens: 100,
    cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: -150 },
  };
  assert.deepEqual(cacheWriteSplit(negative), { h1: 0, m5: 0, unknown: 100 });
  // no top-level field at all: the nested pair IS the total (old Claude Code)
  const nestedOnly = { cache_creation: { ephemeral_1h_input_tokens: 60, ephemeral_5m_input_tokens: 40 } };
  assert.deepEqual(cacheWriteSplit(nestedOnly), { h1: 60, m5: 40, unknown: 0 });
  // nothing at all
  assert.deepEqual(cacheWriteSplit({}), { h1: 0, m5: 0, unknown: 0 });
  assert.deepEqual(cacheWriteSplit(undefined), { h1: 0, m5: 0, unknown: 0 });
});

test("lastCacheTier: a breakdown the pricing path rejects is not shown as a tier", () => {
  // top-level 100 but nested claiming 150: the panel must not report "1 hour"
  // from data every other path treats as corrupt.
  const corrupt = JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-24T10:00:00Z",
    message: {
      id: "a",
      usage: {
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_1h_input_tokens: 80, ephemeral_5m_input_tokens: 70 },
      },
    },
  });
  assert.equal(lastCacheTier(corrupt), null);
  // and a good breakdown still reports normally
  assert.equal(lastCacheTier(turn({ id: "a", at: "2026-08-24T10:00:00Z", write: 100, tier: "1h" })), "1h");
});

test("addRebuild: the tier buckets always add up to the total", () => {
  const a = REB({ tokens: 300, tokens1h: 100, tokens5m: 200, cacheWrite: 900, streams: 1 });
  const b = REB({ tokens: 150, tokens5m: 50, tokensUnknown: 100, cacheWrite: 400, streams: 1 });
  const s = addRebuild(a, b);
  assert.equal(s.tokens, 450);
  assert.equal(s.tokens1h + s.tokens5m + s.tokensUnknown, s.tokens);
  assert.equal(s.cacheWrite, 1300);
  assert.equal(s.streams, 2);
});
