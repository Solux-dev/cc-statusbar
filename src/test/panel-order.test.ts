// The order the panel answers in, the way back to the project, and the agent
// list that folds away.
//
// Lifted out of logic.test.ts unchanged and in order — no test was renamed,
// reordered, or rewritten in the move.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WINDOW_5H_SECONDS } from "../metrics";
import {
  buildView,
  buildPanelHtml,
  buildCodexQuotaView,
  buildCodexPanelHtml,
  DELEGATED_TOGGLE_COMMAND,
  ISSUES_URL,
} from "../render";
import { agentIdle } from "../panelModel";
import { W, REB, QUOTA_OFF, ORDER_CODEX_USAGE, IDLE_AGENT, PATIENT_AGENT, IDLE_TOTALS } from "./fixtures";

// ---------------------------------------------------------------------------
// Release B — panel re-order. Both panels, both languages, must answer in this
// order: how much is left → where it went → how well it is spent → the raw
// number. The matrix is parameterised so a regression cannot hide in the
// language or the provider that happens not to be spot-checked.
// ---------------------------------------------------------------------------

const ORDER_TOTALS = {
  input: 50_000, output: 150_000, work: 200_000,
  cacheRead: 10_000_000, cacheWrite: 1_000_000,
  cacheWrite1h: 0, cacheWrite5m: 1_000_000, cacheWriteUnknown: 0,
};
const ORDER_SUBS = [
  { agentType: "Explore", description: "map the repo", modelId: "claude-sonnet-5", modelLabel: "Sonnet 5", effort: "high", effective: 300_000 },
];
const ORDER_CTX = { usedTokens: 468_000, limitTokens: 1_000_000, limitState: "ok" as const };

/** Position of `needle`, asserting it is present at all. */
function posIn(html: string, needle: string, where: string): number {
  const i = html.indexOf(needle);
  assert.ok(i >= 0, `${where}: missing from the panel — ${needle}`);
  return i;
}

/** The page with every ⓘ footnote removed: what the reader sees without hovering.
 *  Sound because `esc()` never emits a raw `<` inside a footnote. */
function withoutFootnotes(html: string): string {
  return html.replace(/<span class="tip">[^<]*<\/span>/g, "");
}

const CLAUDE_ORDER = [
  { lang: "en" as const, quota: "Subscription quota", context: "context: 47%", delegated: "Delegated work", cache: "<h3>Cache</h3>", cost: "Token-equivalent with cache", details: "<h3>Details</h3>", compare: "without cache ≈ 11.2M tok — ~4.6× more", hidden: "Cache saved", note: "not a money price" },
  { lang: "ru" as const, quota: "Тариф", context: "контекст: 47%", delegated: "Делегировано саб-агентам", cache: "<h3>Кэш</h3>", cost: "Токен-эквивалент с кэшем", details: "<h3>Детали</h3>", compare: "без кэша было бы ≈ 11.2M ток — в ~4.6× больше", hidden: "Сэкономлено кэшем", note: "не денежная цена" },
];

for (const c of CLAUDE_ORDER) {
  test(`buildPanelHtml (${c.lang}): left → what it cost → the raw figures → cache → the long list`, () => {
    const now = 1000;
    const q = {
      state: "ok" as const,
      fiveH: { pct: 24, resetAt: now + WINDOW_5H_SECONDS * 0.5 },
      sevenD: { pct: 41, resetAt: now + 7 * 86400 * 0.4 },
    };
    const html = buildPanelHtml(
      ORDER_TOTALS, W, q, now, c.lang, ORDER_CTX, { tier: "5m", hitRatePct: 82 },
      undefined, ORDER_SUBS, 2_000_000
    );
    const at = (n: string): number => posIn(html, n, c.lang);
    assert.ok(at(c.quota) < at(c.context), "the context line travels with the quota");
    assert.ok(at(c.context) < at(c.cost), "quota + context still open the page");
    assert.ok(at(c.cost) < at(c.details), "the number, then the raw figures behind it");
    assert.ok(at(c.details) < at(c.cache), "…then how the cache is doing");
    // The agent list is the only block whose length is unbounded, so it closes
    // the page: nothing a reader needs can be pushed below the fold by it.
    assert.ok(at(c.cache) < at(c.delegated), "the variable-length block comes last");
  });

  test(`buildPanelHtml (${c.lang}): the comparison is visible, only the derived total hides in the ⓘ`, () => {
    const now = 1000;
    const q = { state: "ok" as const, fiveH: { pct: 24, resetAt: now + 100 }, sevenD: { pct: 41, resetAt: now + 100 } };
    const html = buildPanelHtml(ORDER_TOTALS, W, q, now, c.lang);
    const visible = withoutFootnotes(html);
    assert.ok(visible.includes(c.cost), "the headline label stays visible");
    // This is the figure the extension exists to show: a hover is the wrong
    // place for it, and anyone who never hovers used to miss it entirely.
    assert.ok(visible.includes(c.compare), `read without hovering: ${c.compare}`);
    assert.ok(!visible.includes(c.hidden), "the derived total (= the difference) stays in the footnote");
    assert.ok(!visible.includes(c.note), "so does the disclaimer");
    const tip = new RegExp(`${c.hidden}[^<]*`).exec(html)?.[0] ?? "";
    assert.ok(tip.includes(c.note), "one footnote carries both");
    // and the visible line still carries the headline number
    assert.match(visible, /2\.5M/);
  });
}

const CODEX_ORDER = [
  // No `~3.2×` here on purpose. This payload states no cache-write count, and
  // the 20k of ordinary input left could hold one: the ratio is 3.2× if it held
  // none and 2.8× if it held all of it. A multiplier has no room for a marker,
  // so it is dropped rather than printed at the flattering end. The two absolute
  // figures — the point of the line — are unaffected.
  { lang: "en" as const, quota: "Subscription quota", context: "context: 14%", cache: ">Cache<", cost: "Token-equivalent with cache", details: ">Details<", compare: "without cache ≈ 105k tok", hidden: "Cache saved", value: "≥ 33k tok" },
  { lang: "ru" as const, quota: "Тариф", context: "контекст: 14%", cache: ">Кэш<", cost: "Токен-эквивалент с кэшем", details: ">Детали<", compare: "без кэша было бы ≈ 105k ток", hidden: "Сэкономлено кэшем", value: "≥ 33k ток" },
];

for (const c of CODEX_ORDER) {
  test(`buildCodexPanelHtml (${c.lang}): the Codex page follows the same order as the Claude one`, () => {
    const now = 1000;
    const html = buildCodexPanelHtml(
      { state: "ok", fiveH: { pct: 10, resetAt: now + WINDOW_5H_SECONDS }, sevenD: null },
      now,
      c.lang,
      { source: "stdio", context: { usedTokens: 14_000, limitTokens: 100_000, limitState: "ok" }, usage: ORDER_CODEX_USAGE }
    );
    const at = (n: string): number => posIn(html, n, c.lang);
    assert.ok(at(c.quota) < at(c.context), "quota, then context");
    assert.ok(at(c.context) < at(c.cost), "context above what it cost");
    assert.ok(at(c.cost) < at(c.details), "the number, then the raw figures behind it");
    assert.ok(at(c.details) < at(c.cache), "…then how the cache is doing");
    // the same split as the Claude panel: comparison visible, the rest in the ⓘ
    const visible = withoutFootnotes(html);
    assert.ok(visible.includes(c.compare), `read without hovering: ${c.compare}`);
    assert.ok(!visible.includes(c.hidden), "the derived total stays in the footnote");
    // real arithmetic, not a placeholder: 20k fresh + 5k out + 80k×0.1 = 33k
    assert.ok(visible.includes(c.value), `headline value: ${c.value}`);
    assert.doesNotMatch(html, /NaN/);
  });
}

test("panel footnotes stay inside a narrow docked panel, same size in a wide one", () => {
  // The panel can be docked into a side column. width:max-content with a flat
  // 300px cap let the longest footnote (the RU cost line) push the page into
  // horizontal scrolling; the cap is now viewport-aware and includes padding.
  // 322px, not 300px: with border-box the number is the OUTER width, so 322
  // draws exactly the box the old content cap drew — capping the viewport must
  // not silently narrow every footnote in a wide panel.
  const now = 1000;
  const q = { state: "ok" as const, fiveH: { pct: 24, resetAt: now + 100 }, sevenD: null };
  for (const html of [
    buildPanelHtml(ORDER_TOTALS, W, q, now, "ru"),
    buildCodexPanelHtml(q, now, "ru", { source: "stdio", usage: ORDER_CODEX_USAGE }),
  ]) {
    assert.match(html, /box-sizing:border-box/);
    assert.match(html, /max-width:322px; max-width:min\(322px, calc\(100vw - 36px\)\)/,
      "the plain cap stays as a fallback for a renderer without CSS min()");
  }
});

// ---------------------------------------------------------------------------
// The way back to the project. 895 installs against 133 marketplace-page views
// means people install from inside the editor and never see that page — so the
// only route from a wrong number to a bug report is a link the extension itself
// shows. It must be in every surface, in both languages, for both providers.
// ---------------------------------------------------------------------------

test("the issue link is offered in every hover and both panels, both languages", () => {
  const now = 1000;
  const totals = { input: 0, output: 0, work: 1000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };
  const q = { state: "disabled" as const, fiveH: null, sevenD: null };
  const labels = { en: "Report an issue", ru: "Сообщить о проблеме" };
  for (const lang of ["en", "ru"] as const) {
    const label = labels[lang];
    // The WHOLE link, not the label and the URL separately: an edit that drops
    // the href, a bracket or the <a> leaves both fragments in place while the
    // text stops being clickable — the one failure this test exists to catch.
    const asMarkdown = `[${label}](${ISSUES_URL})`;
    const asHtml = `<a href="${ISSUES_URL}">${label}</a>`;
    const surfaces: Array<[string, string, string]> = [
      ["Claude hover", buildView(totals, W, q, now, lang).tooltip, asMarkdown],
      ["Codex hover", buildCodexQuotaView(q, now, lang, { source: "stdio" }).tooltip, asMarkdown],
      ["Claude panel", buildPanelHtml(totals, W, q, now, lang), asHtml],
      ["Codex panel", buildCodexPanelHtml(q, now, lang, { source: "stdio" }), asHtml],
    ];
    for (const [name, surface, link] of surfaces) {
      assert.ok(surface.includes(link), `${lang} · ${name}: no clickable link — expected ${link}`);
    }
  }
});

test("the issue link cannot drift from package.json's bugs.url", () => {
  // Two hard-coded copies of the same URL is exactly how a dead link is born:
  // one gets updated, the other does not.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require("../../package.json") as { bugs?: { url?: string } };
  assert.equal(ISSUES_URL, pkg.bugs?.url);
});

// ---------------------------------------------------------------------------
// What waiting cost EACH agent, and the list that folds away.
//
// A single total for all agents cannot say which one to stop leaving open, and
// a bare percentage cannot say whether it is worth acting on — so the row
// carries both, and the share is of that agent's OWN spend: a one-turn agent
// then reads 0% (it really did waste nothing) instead of being scored low for
// having had nothing to reuse yet.
// ---------------------------------------------------------------------------

test("agentIdle: the share is of the agent's own spend, priced with the session's weights", () => {
  const idle = agentIdle(IDLE_AGENT, W);
  assert.equal(idle.known, true);
  assert.equal(idle.cost, 500_000, "400k on the 5-minute tier = 500k token-equivalent");
  assert.equal(idle.pctText, "25");
});

test("agentIdle: an agent that never waited reads 0 — that is an answer, not a gap", () => {
  const idle = agentIdle(PATIENT_AGENT, W);
  assert.equal(idle.known, true);
  assert.equal(idle.cost, 0);
  assert.equal(idle.pctText, "0");
});

test("agentIdle: an unjudged gap claims nothing, not even a zero", () => {
  // A cache lifetime is what decides whether a pause was long enough to kill the
  // cache. Where the log never stated one, the gap is unjudgeable and lands in
  // `unjudged` — and "0%" there would be an invention.
  const blind = agentIdle({ ...PATIENT_AGENT, rebuild: REB({ cacheWrite: 900_000, unjudged: 1 }) }, W);
  assert.equal(blind.known, false);
});

test("agentIdle: a one-turn agent has no gap to judge, so 0% is the truth", () => {
  // Regression: keying on "was a tier read" instead of "was a gap unjudged" made
  // this agent unknown, although a stream with no gaps has nothing to judge.
  const single = agentIdle({ ...PATIENT_AGENT, rebuild: REB({ cacheWrite: 120_000 }) }, W);
  assert.deepEqual(single, { known: true, cost: 0, pctText: "0", atLeast: false });
});

test("agentIdle: a real loss never prints as 0% — it prints as <1", () => {
  const tiny = agentIdle({ ...IDLE_AGENT, rebuild: REB({ tokens: 3_000, tokens5m: 3_000, cacheWrite: 900_000, streams: 1 }) }, W);
  assert.equal(tiny.pctText, "<1", "in a cell about what waiting cost, 0% reads as 'it cost nothing'");
});

test("buildPanelHtml: the agent list folds away; the summary and the link never do", () => {
  const subs = [IDLE_AGENT, PATIENT_AGENT];
  const collapsed = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "ru",
    undefined, undefined, undefined, subs, 1_000_000, undefined, false
  );
  assert.match(collapsed, /Делегировано саб-агентам/, "the heading stays");
  assert.match(collapsed, /2 саб-агента · ≈ 3M ток/, "so does how much was delegated");
  assert.match(collapsed, /Opus 5 · xhigh/, "and to which models");
  assert.ok(!/Fix round R3/.test(collapsed), "the per-agent rows are what folds");
  assert.match(collapsed, /Показать по агентам/);
  // The page runs no scripts and is replaced on every tick, so the only way to
  // open the list is a command the extension itself handles.
  assert.match(collapsed, new RegExp(`href="command:${DELEGATED_TOGGLE_COMMAND}"`));

  const open = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "ru",
    undefined, undefined, undefined, subs, 1_000_000, undefined, true
  );
  assert.match(open, /implementer · Opus 5 · xhigh — Fix round R3/);
  assert.match(open, /после пауз 25% \(≈ 500k\)/, "the percentage AND the tokens: 25% of a small agent is not worth acting on");
  assert.match(open, /после пауз 0%/, "an agent that never waited says so");
  assert.match(open, /Свернуть список агентов/);
  // The definition of the column lives in the cell's own ⓘ. It is read once and
  // never again, so as a paragraph under the list it was longer than every row
  // it explained; the guidance sentence about who picks the model is the one
  // thing that stays as visible text, because it is acted on, not just read.
  assert.match(
    open,
    /class="idle"><span class="hint"[^>]*>после пауз 25% \(≈ 500k\) ⓘ<span class="tip">после пауз — доля расхода самого агента/,
    "the legend hangs off the cell it defines"
  );
  assert.ok(
    !/<div class="sub">после пауз — доля/.test(open),
    "and no longer stands as a wall of text under the list"
  );
  assert.match(open, /<div class="sub">Модель выбирает тот, кто запустил агента/);
});

test("a footnote never hangs under an element that dims itself with opacity", () => {
  // Opacity multiplies through the whole subtree, so a muted container took its
  // ⓘ panel down with it and the page read straight through the box — worst on
  // the `.sub` line, dimmed to .6 before the hint dimmed it again. Containers
  // that carry a footnote mute themselves with colour instead. Asserted on the
  // stylesheet because that is where the rule can silently come undone.
  const reb = REB({ tokens: 800_000, tokens5m: 800_000, cacheWrite: 5_000_000, streams: 1 });
  const html = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, [IDLE_AGENT], 1_000_000, { subagents: reb }, true
  );
  const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  assert.ok(!/\.hint \{[^}]*opacity:\s*\.\d/.test(style), "the hint itself must not dim");
  assert.ok(/\.arow \.idle \{[^}]*opacity:1/.test(style), "nor the agent's idle cell");
  assert.ok(/\.sub\.solid \{[^}]*opacity:1/.test(style), "nor a .sub line that carries one");
  assert.match(html, /<div class="sub solid">/, "and that line asks for the undimmed variant");
  // The Codex page shares the helper, so it shares the rule.
  const codex = buildCodexPanelHtml(
    { state: "ok", fiveH: { pct: 12, resetAt: 2000 }, sevenD: { pct: 4, resetAt: 90_000 } },
    1000,
    "en"
  );
  assert.ok(/\.row \.hint \{[^}]*opacity:1/.test(codex), "on both pages");
});

test("buildPanelHtml (en): the same list, the same two figures, in English", () => {
  const open = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "en",
    undefined, undefined, undefined, [IDLE_AGENT], 1_000_000, undefined, true
  );
  assert.match(open, /after pauses 25% \(≈ 500k\)/);
  assert.match(open, /Hide the agent list/);
  assert.match(open, /after pauses — the share of that agent's own spend/);
});

test("buildPanelHtml: with no readable cache lifetime the idle column is not drawn at all", () => {
  // A column of "—" teaches nothing and costs every row its width.
  const blind = [
    { ...IDLE_AGENT, rebuild: REB({ cacheWrite: 900_000, unjudged: 2 }) },
    { ...PATIENT_AGENT, rebuild: REB({ cacheWrite: 800_000, unjudged: 1 }) },
  ];
  const html = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "ru",
    undefined, undefined, undefined, blind, 1_000_000, undefined, true
  );
  assert.match(html, /Fix round R3/, "the rows are still there");
  assert.ok(!/простой/.test(html), "but nothing pretends to know what waiting cost them");
});

test("buildPanelHtml: one unreadable agent among readable ones gets a dash, never a zero", () => {
  const mixed = [IDLE_AGENT, { ...PATIENT_AGENT, rebuild: REB({ cacheWrite: 800_000, unjudged: 1 }) }];
  const html = buildPanelHtml(
    IDLE_TOTALS, W, QUOTA_OFF, 1000, "ru",
    undefined, undefined, undefined, mixed, 1_000_000, undefined, true
  );
  assert.match(html, /после пауз 25% \(≈ 500k\)/);
  assert.match(html, /после пауз —/);
});

test("the panel's only command link cannot drift from package.json", () => {
  // Same failure mode as the issue URL: the link stays in the page, the command
  // it names quietly stops existing, and the list can never be opened again.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require("../../package.json") as { contributes?: { commands?: Array<{ command: string }> } };
  const declared = (pkg.contributes?.commands ?? []).map((c) => c.command);
  assert.ok(declared.includes(DELEGATED_TOGGLE_COMMAND), `not contributed: ${DELEGATED_TOGGLE_COMMAND}`);
});
