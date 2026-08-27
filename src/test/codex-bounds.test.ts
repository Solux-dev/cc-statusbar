import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveTokens } from "../metrics";
import { buildView, buildPanelHtml, buildCodexQuotaView, buildCodexPanelHtml } from "../render";
import { codexTotals } from "../codexProvider";
import { W, QUOTA_OFF, IDLE_TOTALS, WARMUP_TOTALS } from "./fixtures";

test("Codex never claims nothing was WRITTEN to cache — that counter is its own", () => {
  // Round 13/14. Cached input of 0 proves no cached input was READ. Codex keeps
  // a separate cache-write counter, so Claude's "nothing has been read from or
  // written to cache" states a fact this payload does not carry.
  const now = 1000;
  const details = {
    source: "stdio" as const,
    usage: {
      totalTokens: 105_000, lastTokens: 105_000,
      inputTokens: 100_000, cachedInputTokens: 0,
      outputTokens: 5000, reasoningOutputTokens: 0,
    },
  };
  const quota = { state: "ok" as const, fiveH: null, sevenD: { pct: 10, resetAt: now + 86400 } };
  const en = buildCodexPanelHtml(quota, now, "en", details);
  assert.match(en, /Nothing has been read from cache in this session yet/);
  assert.match(en, /Codex keeps its own counter for cache writes/);
  assert.ok(!/read from or written to cache/.test(en), "…Claude's wording, which asserts a write count");
  assert.ok(!/reports no cache writes at all/.test(en), "…and the claim that Codex has no such counter");
  const ru = buildCodexPanelHtml(quota, now, "ru", details);
  assert.match(ru, /из кэша ещё ничего не читалось/);
  assert.ok(!/не читался и не записывался/.test(ru));
});

test("the Russian UI has no English left in it where a fact is missing", () => {
  // Round 14. Both of these are normal states, not transport diagnostics: a
  // Codex model with no stated context window, and an agent whose type the
  // transcript never named. Both used to print English inside a Russian panel.
  const now = 1000;
  const noWindow = buildCodexPanelHtml(
    { state: "ok", fiveH: null, sevenD: null }, now, "ru",
    { source: "stdio", context: { usedTokens: 120_000, limitTokens: null, limitState: "unavailable", limitDetailKey: "codexNoWindow" } }
  );
  assert.match(noWindow, /окно контекста модели недоступно/);
  assert.ok(!/model context window unavailable/.test(noWindow));

  const nameless = [{ agentType: null, description: null, modelId: "claude-opus-5", modelLabel: "Opus 5", effort: "high", effective: 900_000 }];
  const ru = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, now, "ru",
    undefined, undefined, undefined, nameless, 1_000_000, undefined, true
  );
  assert.match(ru, /агент · Opus 5/);
  assert.ok(!/>agent · Opus 5/.test(ru));
});

test("a cache-write count Codex states is shown, not silently dropped", () => {
  // Round 14. The field exists in Codex's protocol (`cache_write_input_tokens`)
  // and is 0 in all 54,873 turns measured on this machine (109,746 was a count
  // of field occurrences: the counter appears twice in every event) — but a stated
  // non-zero must not vanish from a panel about token cost. Round 16 settled how
  // it enters the figure: OpenAI documents `input_tokens_details` as a breakdown
  // of `input_tokens` with `ordinary = input − cached − cache_write`, so a write
  // is priced ONCE, at the write weight, and never as ordinary fresh input.
  const now = 1000;
  const quota = { state: "ok" as const, fiveH: null, sevenD: null };
  const stated = {
    source: "stdio" as const,
    usage: {
      totalTokens: 105_000, lastTokens: 105_000,
      inputTokens: 100_000, cachedInputTokens: 40_000,
      outputTokens: 5000, reasoningOutputTokens: 0,
      cacheWriteInputTokens: 12_000,
    },
  };
  const en = buildCodexPanelHtml(quota, now, "en", stated);
  assert.match(en, /cache: read 40k \/ write 12k/);
  assert.match(en, /12k tok were written to cache/);
  const ru = buildCodexPanelHtml(quota, now, "ru", stated);
  assert.match(ru, /кэш: чтение 40k \/ запись 12k/);
  assert.match(ru, /Из ввода выше 12k ток\. записаны в кэш/);

  // A payload that states nothing still reads "n/a" — and a stated zero prints
  // as a zero, because "not stated" and "stated as none" are different answers.
  const silent = { ...stated, usage: { ...stated.usage, cacheWriteInputTokens: null } };
  assert.match(buildCodexPanelHtml(quota, now, "en", silent), /write n\/a/);
  assert.ok(!/were written to cache/.test(buildCodexPanelHtml(quota, now, "en", silent)));
  const zero = { ...stated, usage: { ...stated.usage, cacheWriteInputTokens: 0 } };
  assert.match(buildCodexPanelHtml(quota, now, "en", zero), /cache: read 40k \/ write 0/);
  assert.ok(!/were written to cache/.test(buildCodexPanelHtml(quota, now, "en", zero)));
});

test("a Codex cache write is priced once, at the write weight, never as fresh input", () => {
  // Round 16. OpenAI documents `input_tokens_details` as a BREAKDOWN of
  // `input_tokens` — "ordinaryInputTokens = inputTokens - cachedTokens -
  // cacheWriteTokens", reads at 0.1x, writes at 1.25x. Pricing a write at 1x
  // inside fresh input (what rounds 14-15 did) understated the figure; adding it
  // on top of the input count would have counted it twice.
  const now = 1000;
  const quota = { state: "ok" as const, fiveH: null, sevenD: null };
  const stated = {
    source: "stdio" as const,
    usage: {
      totalTokens: 105_000, lastTokens: 105_000,
      inputTokens: 100_000, cachedInputTokens: 40_000,
      outputTokens: 5000, reasoningOutputTokens: 0,
      cacheWriteInputTokens: 12_000,
    },
  };
  // 48k ordinary + 5k output + 40k read x 0.1 + 12k write x 1.25 = 72k.
  // The three input buckets sum to exactly the 100k Codex reported.
  const en = buildCodexPanelHtml(quota, now, "en", stated);
  assert.match(en, /≈ 72k/);
  assert.ok(!/≈ 69k/.test(en), "…the old figure, which priced the write as ordinary input");
  assert.match(en, /counted once/);
  assert.ok(!/does not state whether those tokens are already inside/.test(en));
  const ru = buildCodexPanelHtml(quota, now, "ru", stated);
  assert.match(ru, /посчитаны один раз/);
  assert.ok(!/не сказано, входят ли эти/.test(ru));

  // A breakdown bigger than the whole never produces a negative bucket: the
  // write is clamped to what the reads left, so the parts still sum to the input.
  const overlapping = {
    ...stated,
    usage: { ...stated.usage, inputTokens: 4583, cachedInputTokens: 3945, cacheWriteInputTokens: 4580, outputTokens: 0 },
  };
  // 0 ordinary + 3945 x 0.1 + 638 x 1.25 = 1192.
  assert.match(buildCodexPanelHtml(quota, now, "en", overlapping), /≈ 1\.2k/);
});

test("the Codex panel names no cause over a difference it does not print", () => {
  // Round 17. The Claude panel got this in rounds 10 and 12; pricing the Codex
  // write made the same state reachable here for the first time, and the Codex
  // hint chain had no `invisible` branch. `panelCostEvenHint` is not a stand-in:
  // it fires on an exact arithmetic zero, while this is a REAL premium the
  // display rounds away.
  const now = 1000;
  const quota = { state: "ok" as const, fiveH: null, sevenD: null };
  // 1.16M ordinary + 40k written at 1.25 = 1.21M against 1.2M without cache.
  // A 10k premium, and both figures print as "1.2M".
  const hidden = {
    source: "stdio" as const,
    usage: {
      totalTokens: 1_200_000, lastTokens: 1_200_000,
      inputTokens: 1_200_000, cachedInputTokens: 0,
      outputTokens: 0, reasoningOutputTokens: 0,
      cacheWriteInputTokens: 40_000,
    },
  };
  const en = buildCodexPanelHtml(quota, now, "en", hidden);
  assert.match(en, /about the same/);
  assert.match(en, /by too little to change either figure/);
  assert.ok(!/the with-cache figure is the larger of the two/.test(en), "…a cause over an invisible difference");
  assert.ok(!/Both sides of the cache add to this figure here/.test(en));
  assert.match(buildCodexPanelHtml(quota, now, "ru", hidden), /слишком мала/);
});

test("a write count Codex never stated is not read as a zero", () => {
  // Round 17. `?? 0` collapsed two different facts. A payload that states no
  // cache-write count is not a payload stating none were written: everything
  // outside the cached reads is then priced as ordinary input, which is a floor,
  // and the ⓘ has to say so or the figure claims a completeness it lacks.
  const now = 1000;
  const quota = { state: "ok" as const, fiveH: null, sevenD: null };
  const silent = {
    source: "stdio" as const,
    usage: {
      totalTokens: 105_000, lastTokens: 105_000,
      inputTokens: 100_000, cachedInputTokens: 0,
      outputTokens: 5000, reasoningOutputTokens: 0,
      cacheWriteInputTokens: null,
    },
  };
  const en = buildCodexPanelHtml(quota, now, "en", silent);
  assert.match(en, /write n\/a/);
  assert.match(en, /stated no cache-write count for this session/);
  assert.match(en, /the token-equivalent is a floor/);
  assert.ok(!/were written to cache/.test(en), "…the priced sentence, which would claim a measurement");
  assert.match(buildCodexPanelHtml(quota, now, "ru", silent), /Счётчик записи в кэш Codex для этой сессии не сообщил/);

  // A payload that states zero is a measurement, so it gets no floor warning.
  const zero = { ...silent, usage: { ...silent.usage, cacheWriteInputTokens: 0 } };
  assert.ok(!/is a floor/.test(buildCodexPanelHtml(quota, now, "en", zero)));
});

test("a write count too big for the input it breaks down says so, and prices what fits", () => {
  // Round 17. The clamp was silent: with input 4583 / cached 3945 / write 4580
  // only 638 tokens can be priced, but the ⓘ claimed all 4.6k were "counted
  // once". And with no ordinary input at all it claimed to have priced tokens
  // while pricing none.
  const now = 1000;
  const quota = { state: "ok" as const, fiveH: null, sevenD: null };
  const overlapping = {
    source: "stdio" as const,
    usage: {
      totalTokens: 4583, lastTokens: 4583,
      inputTokens: 4583, cachedInputTokens: 3945,
      outputTokens: 0, reasoningOutputTokens: 0,
      cacheWriteInputTokens: 4580,
    },
  };
  const en = buildCodexPanelHtml(quota, now, "en", overlapping);
  assert.match(en, /stated 4\.6k tok written to cache, but only 638 tok/);
  assert.ok(!/4\.6k tok were written to cache/.test(en), "…the claim that all of it was priced");
  assert.match(buildCodexPanelHtml(quota, now, "ru", overlapping), /сообщил 4\.6k ток/);

  // Nothing left to price at all: no sentence may claim otherwise.
  const nothingLeft = {
    ...overlapping,
    usage: { ...overlapping.usage, totalTokens: 0, lastTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 10 },
  };
  const none = buildCodexPanelHtml(quota, now, "en", nothingLeft);
  assert.ok(!/were written to cache/.test(none));
  assert.match(none, /but only 0 tok/);
});

test("the provider snapshot and the panel price the same payload the same way", () => {
  // Round 17. `codexTotals` is the exported abstraction; it kept the old
  // arithmetic while the renderer moved on, so a consumer switching to it would
  // have silently regressed to pricing writes as ordinary input.
  const usage = {
    total: {
      totalTokens: 105_000, inputTokens: 100_000, cachedInputTokens: 40_000,
      outputTokens: 5000, reasoningOutputTokens: 0, cacheWriteInputTokens: 12_000,
    },
    last: null,
    modelContextWindow: null,
  } as any;
  const totals = codexTotals(usage);
  // The three input buckets add up to exactly the 100k Codex reported.
  assert.equal(totals.input + totals.cacheRead + totals.cacheWrite, 100_000);
  assert.equal(totals.cacheWriteUnknown, totals.cacheWrite, "no tier is stated, so the write cannot claim one");
  assert.equal(effectiveTokens(totals, W), 72_000, "the same 72k the panel prints");
});

test("the warm-up hint is Codex's own, because Codex has no cache tiers to name", () => {
  // Round 16. Now that writes are priced here, the Codex panel can reach the
  // warm-up and both-sides states for the first time. Claude's twins of those
  // two sentences name "1-hour x2.0, 5-minute x1.25" — tiers Codex never states.
  const now = 1000;
  const quota = { state: "ok" as const, fiveH: null, sevenD: null };
  const warming = {
    source: "stdio" as const,
    usage: {
      totalTokens: 100_000, lastTokens: 100_000,
      inputTokens: 100_000, cachedInputTokens: 0,
      outputTokens: 0, reasoningOutputTokens: 0,
      cacheWriteInputTokens: 100_000,
    },
  };
  const en = buildCodexPanelHtml(quota, now, "en", warming);
  assert.match(en, /Codex states no cache lifetime/);
  assert.ok(!/1-hour ×2\.0/.test(en), "…Claude's tiers, which Codex does not have");
  // And it is no longer told that nothing was read, which would contradict the
  // 125k against 100k printed right under it.
  assert.ok(!/Nothing has been read from cache in this session yet/.test(en));
  const ru = buildCodexPanelHtml(quota, now, "ru", warming);
  assert.match(ru, /Срок жизни кэша Codex не сообщает/);
  assert.ok(!/часовая ×2\.0/.test(ru));
});

test("the 'so far' is dropped wherever no weight can narrow the gap", () => {
  // Round 16. The gap is the sum of `bucket x (weight - 1)`, so only a bucket
  // priced BELOW a fresh token can ever close it. This is arithmetic, not a
  // property of one provider: with every weight at or above 1 the direction is
  // fixed on the Claude panel too.
  const now = 1000;
  const quota = { state: "ok" as const, fiveH: null, sevenD: null };
  const codex = {
    source: "stdio" as const,
    weights: { cacheRead: 2, cacheWrite: 1.25 },
    usage: {
      totalTokens: 105_000, lastTokens: 105_000,
      inputTokens: 100_000, cachedInputTokens: 40_000,
      // Stated, so the multiplier this test is about actually gets printed:
      // with the count missing the 60k of ordinary input could hold a write, and
      // the ratio moves 1.4× → 1.5× across that interval, so it is dropped.
      outputTokens: 5000, reasoningOutputTokens: 0, cacheWriteInputTokens: 0,
    },
  };
  const locked = buildCodexPanelHtml(quota, now, "en", codex);
  assert.match(locked, /× less/);
  assert.ok(!/less, so far/.test(locked));
  assert.ok(!/пока в ~/.test(buildCodexPanelHtml(quota, now, "ru", codex)));
  // At the default read weight a later read still narrows it, so the hedge is
  // honest again — on the same panel. (A write-only session, so the with-cache
  // figure is the larger one and the "less" branch is the one on screen.)
  const open = {
    source: "stdio" as const,
    weights: { cacheRead: 0.1, cacheWrite: 1.25 },
    usage: {
      totalTokens: 100_000, lastTokens: 100_000,
      inputTokens: 100_000, cachedInputTokens: 0,
      outputTokens: 0, reasoningOutputTokens: 0,
      cacheWriteInputTokens: 100_000,
    },
  };
  assert.match(buildCodexPanelHtml(quota, now, "en", open), /less, so far/);

  // Claude: a write not yet earned back at the default read weight can still
  // reverse…
  const warmup = {
    input: 0, output: 0, work: 0,
    cacheRead: 0, cacheWrite: 100_000,
    cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 100_000,
  };
  assert.match(buildPanelHtml(warmup, W, QUOTA_OFF, 1000, "en"), /less, so far/);
  // …and with every weight at or above 1 it cannot, so the same panel drops it.
  assert.ok(
    !/less, so far/.test(buildPanelHtml(warmup, { cacheRead: 2, cacheWrite: 1.25 }, QUOTA_OFF, 1000, "en"))
  );

  // Round 18. The HOVER is the fourth surface and had the hedge hard-coded: the
  // panel and the Codex hover both dropped it, this one did not, so one tick
  // told the same reader two different things about the same two numbers.
  const locked2 = { cacheRead: 2, cacheWrite: 1.25 };
  const hoverLocked = buildView(WARMUP_TOTALS, locked2, QUOTA_OFF, 1000, "en").tooltip;
  assert.match(hoverLocked, /× less\)/);
  assert.ok(!/less, so far/.test(hoverLocked), "the hover must drop it wherever the panel does");
  assert.ok(!/пока в ~/.test(buildView(WARMUP_TOTALS, locked2, QUOTA_OFF, 1000, "ru").tooltip));
  // At the default weights a read at 0.1 can still narrow it, so the hedge is
  // honest and stays — the same hover, the same numbers, a different setting.
  assert.match(buildView(WARMUP_TOTALS, W, QUOTA_OFF, 1000, "en").tooltip, /less, so far/);
  assert.match(buildView(WARMUP_TOTALS, W, QUOTA_OFF, 1000, "ru").tooltip, /пока в ~/);
});

test("no direction is published where an unstated Codex write count decides it", () => {
  // Round 19. `100k input / 10k cached / write n/a` printed "Cache saved 9k
  // (~1.1× lower)" — while the ⓘ beside it said the 91k was only a floor. If
  // the unstated 90k had in fact been written, the figure is 113.5k and the
  // cache COST 13.5k. The panel was publishing a coin toss as a fact.
  const now = 1000;
  const quota = { state: "ok" as const, fiveH: null, sevenD: null };
  const codex = (usage: Record<string, unknown>) => ({
    source: "stdio" as const,
    weights: { cacheRead: 0.1, cacheWrite: 1.25 },
    usage: { totalTokens: 0, lastTokens: 0, reasoningOutputTokens: 0, ...usage } as never,
  });
  // noCache (100k) falls between the two ends (91k … 113.5k): unknowable.
  const flips = codex({ inputTokens: 100_000, cachedInputTokens: 10_000, outputTokens: 0 });
  const en = buildCodexPanelHtml(quota, now, "en", flips);
  assert.match(en, /the token-equivalent is ≈ 91k; if all of it was, ≈ 113\.5k/);
  assert.match(en, /which of the two is larger cannot be said/);
  assert.ok(!/Cache saved/.test(en), "a saving is a direction, and the direction is what is unknown");
  assert.ok(!/× more|× lower/.test(en), "…and so is a multiplier");
  const ru = buildCodexPanelHtml(quota, now, "ru", flips);
  assert.match(ru, /если записано всё — ≈ 113\.5k/);
  assert.ok(!/Кэш сэкономил|× меньше|× больше/.test(ru));
  // The hover has no ⓘ to carry the caveat, so the line itself carries it.
  assert.match(buildCodexQuotaView(quota, now, "en", flips).tooltip, /which is larger cannot be said/);
  assert.match(buildCodexQuotaView(quota, now, "ru", flips).tooltip, /какое больше — сказать нельзя/);

  // Where the direction holds at BOTH ends, nothing changes: 99k cached leaves
  // 1k that could be a write, and 10.9k … 11.15k is under 100k either way.
  const holds = buildCodexPanelHtml(
    quota, now, "en",
    codex({ inputTokens: 100_000, cachedInputTokens: 99_000, outputTokens: 0 })
  );
  assert.match(holds, /Cache saved/);
  assert.match(holds, /the token-equivalent is a floor/);
  // And a STATED count leaves no interval to be uncertain about.
  const stated = buildCodexPanelHtml(
    quota, now, "en",
    codex({ inputTokens: 100_000, cachedInputTokens: 10_000, outputTokens: 0, cacheWriteInputTokens: 0 })
  );
  assert.match(stated, /Cache saved: ≈ 9k/);
  assert.ok(!/cannot be said/.test(stated));
});

test("a dropped multiplier takes 'about the same' with it", () => {
  // Round 20. A null multiplier means "no magnitude claim is safe here", but the
  // formatters tested `dir === "same"` FIRST, so the one claim the guard exists
  // to kill walked straight past it. Reachable at shipped defaults: 1M of input,
  // nothing cached, no write count stated — equal at the "none" end, 1.25M at
  // the other. The hover has no ⓘ, so the sentence was its whole caveat.
  const now = 1000;
  const quota = { state: "ok" as const, fiveH: null, sevenD: null };
  const codex = {
    source: "stdio" as const,
    weights: { cacheRead: 0.1, cacheWrite: 1.25 },
    usage: {
      totalTokens: 1_000_000, lastTokens: 1_000_000,
      inputTokens: 1_000_000, cachedInputTokens: 0,
      outputTokens: 0, reasoningOutputTokens: 0,
    } as never,
  };
  const hover = buildCodexQuotaView(quota, now, "en", codex).tooltip;
  assert.match(hover, /token-equivalent with cache ≥ \*\*1M\*\* · without cache ≈ \*\*1M\*\*/);
  assert.ok(!/about the same/.test(hover), "a claim about magnitude, on a figure that is a bound");
  const panel = buildCodexPanelHtml(quota, now, "en", codex);
  assert.match(panel, /without cache ≈ 1M tok</);
  assert.ok(!/about the same/.test(panel));
  assert.ok(!/пока примерно столько же/.test(buildCodexQuotaView(quota, now, "ru", codex).tooltip));
});

test("an interval the page cannot print is not announced as an unknowable direction", () => {
  // Round 20. The direction-unknown branch sat ahead of the invisible-difference
  // guard, so a session whose two ends and without-cache figure ALL print `1.7M`
  // got a line saying which is larger cannot be said, over a hint claiming 1.7M
  // "falls between" 1.7M and 1.7M. Rounds 10 and 12 settled this for the cause
  // chain; the same rule reaches here.
  const now = 1000;
  const quota = { state: "ok" as const, fiveH: null, sevenD: null };
  const flat = {
    source: "stdio" as const,
    weights: { cacheRead: 0.1, cacheWrite: 1.25 },
    usage: {
      totalTokens: 0, lastTokens: 0,
      inputTokens: 29_797, cachedInputTokens: 735,
      outputTokens: 1_644_441, reasoningOutputTokens: 0,
    } as never,
  };
  const en = buildCodexPanelHtml(quota, now, "en", flat);
  assert.ok(!/cannot be said/.test(en), "nothing to be uncertain about that the page can show");
  assert.ok(!/falls between those two/.test(en));
  assert.match(en, /Cache saved/);
  assert.ok(!/cannot be said/.test(buildCodexQuotaView(quota, now, "en", flat).tooltip));
});

test("a real remainder never disappears into 100%", () => {
  // Round 20. `<1` had no mirror at the top end: 99.6% rounded to `100%`, which
  // reads as "the main session spent nothing" / "this agent did nothing but
  // reload". Same reasoning as the `<1` guard, same shape.
  const reb = {
    tokens: 200_000, tokens1h: 0, tokens5m: 200_000, tokensUnknown: 0,
    cacheWrite: 200_000, streams: 1, unjudged: 0,
  };
  const subs = [{
    agentType: "explore", description: "d", modelId: "m", modelLabel: "Opus 5",
    effort: "high", effective: 250_250, rebuild: reb,
  }];
  const totals = {
    input: 251_250, output: 0, work: 251_250,
    cacheRead: 0, cacheWrite: 0,
    cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0,
  };
  // lead 1k against 250.25k delegated → 99.6%, and the agent's own 250k of
  // reloads is 99.9% of its 250.25k spend. Neither is all of it.
  const html = buildPanelHtml(totals, W, QUOTA_OFF, 1000, "en", undefined, undefined, undefined, subs, 1_000, { subagents: reb }, true);
  // Scoped to the two sentences, not the whole page: the stylesheet carries a
  // `height:100%` of its own.
  assert.ok(!/— 100% of this session/.test(html), "a lead that spent something is not 0% of it");
  assert.ok(!/after pauses 100%/.test(html), "an agent that did real work did not only reload");
  // `>` is escaped in the panel's HTML, so the marker reads `&gt;99%`.
  assert.match(html, /&gt;99% of this session's consumption/);
  assert.match(html, /after pauses &gt;99%/);
});

test("the two ends of the unstated-write interval are named by meaning, not by size", () => {
  // Round 19, second channel — a defect the FIRST half of round 19 introduced.
  // The ⓘ reads its arguments as "if none was written" then "if all was", but
  // they were handed over as min/max. Below a write weight of 1 the "all
  // written" end is the SMALLER one, so both endpoints landed on the wrong
  // hypothesis and the closing sentence ("the figure above is the none-written
  // end") then contradicted the figure printed above it.
  const now = 1000;
  const quota = { state: "ok" as const, fiveH: null, sevenD: null };
  const below = {
    source: "stdio" as const,
    weights: { cacheRead: 2, cacheWrite: 0.5 },
    usage: {
      totalTokens: 105_000, lastTokens: 105_000,
      inputTokens: 100_000, cachedInputTokens: 10_000,
      outputTokens: 5000, reasoningOutputTokens: 0,
    } as never,
  };
  // none → 90k + 5k + 10k×2 = 115k · all → 115k − 90k×0.5 = 70k · noCache 105k,
  // which is between them, so the direction is unknowable and the ⓘ fires.
  const en = buildCodexPanelHtml(quota, now, "en", below);
  assert.match(en, /≤ 115k tok/, "the none-written end, and a CEILING at a write weight below 1");
  assert.match(en, /was written to cache, the token-equivalent is ≈ 115k; if all of it was, ≈ 70k/);
  const ru = buildCodexPanelHtml(quota, now, "ru", below);
  assert.match(ru, /токен-эквивалент ≈ 115k; если записано всё — ≈ 70k/);
  // Above 1 the ends come out in the other order, and the same sentence still
  // maps them the same way round. (`cacheRead` back at its default, so the
  // without-cache figure still lands between them and the ⓘ still fires.)
  const above = {
    ...below,
    weights: { cacheRead: 0.1, cacheWrite: 1.5 },
    usage: { ...(below.usage as object), outputTokens: 0 } as never,
  };
  // none → 90k + 10k×0.1 = 91k · all → 91k + 90k×0.5 = 136k · noCache 100k.
  assert.match(
    buildCodexPanelHtml(quota, now, "en", above),
    /was written to cache, the token-equivalent is ≈ 91k; if all of it was, ≈ 136k/
  );
});

test("the footnotes drop their own hedge wherever the line above them drops it", () => {
  // Round 19. Round 18 gated the four visible cost lines and left the ⓘ under
  // them promising "so far" / "yet" — a footnote is a statement too. Both
  // hints that carry one are gated on the same condition now.
  const locked = { cacheRead: 1, cacheWrite: 1.25 };
  // Read weight exactly 1 (readDelta 0) with a write premium: the warm-up
  // branch, and nothing below 1 to earn it back.
  const warmup = {
    input: 0, output: 0, work: 0,
    cacheRead: 10_000, cacheWrite: 100_000,
    cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 100_000,
  };
  const en = buildPanelHtml(warmup, locked, QUOTA_OFF, 1000, "en");
  assert.match(en, /The cache has not earned back what it cost\./);
  assert.ok(!/earned back what it cost yet/.test(en), "nothing below 1 can earn it back");
  assert.match(en, /no later read can earn it back/);
  const ru = buildPanelHtml(warmup, locked, QUOTA_OFF, 1000, "ru");
  assert.ok(!/Кэш пока не вернул/.test(ru));
  assert.match(ru, /разрыв может только вырасти/);
  // At the default weights the promise is honest and stays.
  assert.match(buildPanelHtml(warmup, W, QUOTA_OFF, 1000, "en"), /earned back what it cost yet/);
  assert.match(buildPanelHtml(warmup, W, QUOTA_OFF, 1000, "ru"), /Кэш пока не вернул/);
});

test("an unstated Codex write count bounds the figure the way the WEIGHT says, not always downward", () => {
  // Round 18. "The figure above is a floor" was stated unconditionally, but the
  // bound belongs to `cacheWriteWeight`, which `package.json` allows from 0:
  // above 1 the unstated write would raise the figure, below 1 it would lower
  // it, and at exactly 1 it cannot move it at all. Naming the wrong side is
  // worse than naming none.
  const now = 1000;
  const quota = { state: "ok" as const, fiveH: null, sevenD: null };
  // No write counter stated, and ordinary input left for one to have hidden in.
  const usage = {
    totalTokens: 105_000, lastTokens: 105_000,
    inputTokens: 100_000, cachedInputTokens: 40_000,
    outputTokens: 5000, reasoningOutputTokens: 0,
  };
  const at = (cacheWrite: number, lang: "en" | "ru") =>
    buildCodexPanelHtml(quota, now, lang, { source: "stdio" as const, weights: { cacheRead: 0.1, cacheWrite }, usage });

  // Round 19: the referent is NAMED. This sentence follows a saving on one
  // branch and the token-equivalent on another, and those two are bounded in
  // opposite directions — "the figure above" pointed at the wrong one half the
  // time.
  assert.match(at(1.25, "en"), /the token-equivalent is a floor: your `ccStatusbar\.cacheWriteWeight` \(1\.25\)/);
  assert.match(at(1.25, "ru"), /токен-эквивалент — нижняя граница: ваш параметр `ccStatusbar\.cacheWriteWeight` \(1\.25\)/);

  const ceiling = at(0.5, "en");
  assert.match(ceiling, /the token-equivalent is a ceiling: your `ccStatusbar\.cacheWriteWeight` \(0\.5\)/);
  assert.ok(!/is a floor/.test(ceiling), "a write priced below fresh input makes the same figure a ceiling");
  assert.match(at(0.5, "ru"), /токен-эквивалент — верхняя граница/);

  const exact = at(1, "en");
  assert.match(exact, /the token-equivalent does not move/);
  assert.ok(!/floor|ceiling/.test(exact), "at 1 a write is priced as ordinary input, so there is no bound");
  assert.match(at(1, "ru"), /токен-эквивалент не изменится/);
});

test("a negative Codex write count is not a count, and never becomes a stated zero", () => {
  // Round 18. `clampWrite` said in its own comment that a negative "is not a
  // count at all", then returned `Math.max(0, n)` — which put a corrupt field in
  // the one bucket that SILENCES the uncertainty note. -1 must read exactly as
  // "the payload said nothing", not as "the payload said zero".
  const now = 1000;
  const quota = { state: "ok" as const, fiveH: null, sevenD: null };
  const base = {
    totalTokens: 105_000, lastTokens: 105_000,
    inputTokens: 100_000, cachedInputTokens: 40_000,
    outputTokens: 5000, reasoningOutputTokens: 0,
  };
  const panel = (cacheWriteInputTokens: number | null) =>
    buildCodexPanelHtml(quota, now, "en", {
      source: "stdio" as const,
      weights: { cacheRead: 0.1, cacheWrite: 1.25 },
      usage: { ...base, cacheWriteInputTokens },
    });
  const negative = panel(-1);
  assert.match(negative, /Codex stated no cache-write count for this session/);
  assert.equal(negative, panel(null), "a negative and a missing field are the same answer");
  // A stated zero is a different answer: the count IS known, so the note that
  // exists to flag the unknown must not appear.
  const zero = panel(0);
  assert.ok(!/Codex stated no cache-write count/.test(zero), "a stated zero is a measurement, not a silence");
  assert.notEqual(zero, negative);
});

test("a reload share below 1% with unjudged gaps states the tokens, never a ceiling beside a floor", () => {
  // Round 18. The summary printed "≥ 1M (<1%)": the tokens a FLOOR, the share a
  // CEILING, two opposite bounds on one measurement — while `agentIdle` had
  // already settled the rule for the per-agent cells by dropping the share.
  // Reachable only by calling the renderer directly (`rebuildDisplay` gates on
  // 3% of the SESSION, and the agents are a subset of it), which is why it is
  // pinned here rather than through a transcript fixture.
  const totals = {
    input: 30_000_000, output: 0, work: 30_000_000,
    cacheRead: 0, cacheWrite: 0,
    cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0,
  };
  // 800k five-minute tokens x 1.25 = exactly the 1M the row needs, and 1M is
  // 3.33% of the 30M session — but only 0.5% of the 200M the agents spent.
  const reb = {
    tokens: 800_000, tokens1h: 0, tokens5m: 800_000, tokensUnknown: 0,
    cacheWrite: 5_000_000, streams: 1, unjudged: 1,
  };
  const subs = [{
    agentType: "explore", description: "d", modelId: "m", modelLabel: "Opus 5",
    effort: "high", effective: 200_000_000, rebuild: reb,
  }];
  const en = buildPanelHtml(totals, W, QUOTA_OFF, 1000, "en", undefined, undefined, undefined, subs, 0, { subagents: reb }, false);
  assert.match(en, /of that, ≥ 1M went on reloading context after pauses/);
  assert.ok(!/&lt;1%/.test(en), "a ceiling must not be printed beside the floor it contradicts");
  const ru = buildPanelHtml(totals, W, QUOTA_OFF, 1000, "ru", undefined, undefined, undefined, subs, 0, { subagents: reb }, false);
  assert.match(ru, /из них ≥ 1M ушло на повторную загрузку/);
  assert.ok(!/&lt;1%/.test(ru));
  // The per-agent cell is the same shape and the same rule, and the legend in
  // the cell's own ⓘ describes it — it used to explain three shapes (`0%`, a
  // dash, a percentage) and leave this fourth one unexplained. The cell lives
  // inside the fold, so this half is asserted with the list open. The ⓘ right
  // after the tokens is what pins "no percentage beside them".
  const open = buildPanelHtml(totals, W, QUOTA_OFF, 1000, "en", undefined, undefined, undefined, subs, 0, { subagents: reb }, true);
  assert.match(open, /after pauses ≥ 1M ⓘ/);
  assert.match(open, /a token figure with no percentage beside it/);
  const openRu = buildPanelHtml(totals, W, QUOTA_OFF, 1000, "ru", undefined, undefined, undefined, subs, 0, { subagents: reb }, true);
  assert.match(openRu, /цифра токенов без процента рядом/);
});

test("an arithmetic zero is a zero, not a premium of 0.0000000000146 tokens", () => {
  // Round 11. −10k from reads at 0.9 and +10k from writes at 1.1 cancel exactly,
  // but in floating point they land at ~1.5e-11. Without a tolerance the page
  // reports a cache that "cost slightly more" when it cost exactly the same.
  const totals = {
    input: 0, output: 0, work: 0,
    cacheRead: 100_000, cacheWrite: 100_000,
    cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 100_000,
  };
  const cancelling = { cacheRead: 0.9, cacheWrite: 1.1 };
  assert.equal(effectiveTokens(totals, cancelling), 200_000);
  const en = buildPanelHtml(totals, cancelling, QUOTA_OFF, 1000, "en");
  assert.match(en, /it is not moving this figure either way/);
  assert.ok(!/cost slightly more than it has saved/.test(en));
  const ru = buildPanelHtml(totals, cancelling, QUOTA_OFF, 1000, "ru");
  assert.match(ru, /не меняет ни в одну сторону/);
  assert.ok(!/стоил чуть больше/.test(ru));
});
