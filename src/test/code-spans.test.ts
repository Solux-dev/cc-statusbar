// Setting names inside the UI strings: markdown in the hover, real markup in
// the panel, and nowhere a backtick a reader can see.
//
// Reported by @VedantMadane — issue #1 and PR #4. The PR removed the backticks
// from the two quota strings, which fixed the panel and broke the hover; these
// tests pin both surfaces at once so neither fix can be made alone again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildView, buildPanelHtml, buildCodexPanelHtml } from "../render";
import { W, ctxTotals, QUOTA_OFF, ORDER_CODEX_USAGE } from "./fixtures";

/** Both sides of the cache add cost — the one Claude footnote that names two
 *  settings, so a single render covers both spans. */
const BOTH_TOTALS = {
  input: 500, output: 500, work: 1000,
  cacheRead: 100_000, cacheWrite: 100_000,
  cacheWrite1h: 100_000, cacheWrite5m: 0, cacheWriteUnknown: 0,
};
const READS_COST = { cacheRead: 2, cacheWrite: 1.25 };

test("the panel draws a setting name as code, the hover leaves it markdown (en)", () => {
  const panel = buildCodexPanelHtml(QUOTA_OFF, 1000, "en");
  assert.match(panel, /<code>ccStatusbar\.quota\.enabled<\/code>/);
  // The hover is a VS Code MarkdownString: it renders the backticks itself, and
  // handing it <code> would print the tags.
  const hover = buildView(ctxTotals, W, QUOTA_OFF, 1000, "en").tooltip;
  assert.match(hover, /`ccStatusbar\.quota\.enabled`/);
  assert.ok(!/<code>/.test(hover), "the hover takes markdown, not markup");
});

test("the panel draws a setting name as code, the hover leaves it markdown (ru)", () => {
  const panel = buildCodexPanelHtml(QUOTA_OFF, 1000, "ru");
  assert.match(panel, /<code>ccStatusbar\.quota\.enabled<\/code>/);
  const hover = buildView(ctxTotals, W, QUOTA_OFF, 1000, "ru").tooltip;
  assert.match(hover, /`ccStatusbar\.quota\.enabled`/);
  assert.ok(!/<code>/.test(hover), "the hover takes markdown, not markup");
});

test("a footnote naming two settings gets a code span for each, both languages", () => {
  for (const lang of ["en", "ru"] as const) {
    const html = buildPanelHtml(BOTH_TOTALS, READS_COST, QUOTA_OFF, 1000, lang);
    assert.match(html, /<code>ccStatusbar\.cacheWriteWeight<\/code>/, lang);
    assert.match(html, /<code>ccStatusbar\.cacheReadWeight<\/code>/, lang);
  }
});

test("no panel prints a backtick, whatever state it is in", () => {
  // The defect was never one string: six or so footnotes carried the same
  // markdown. This sweep is the guard for the ones nobody thought of.
  const pages = [
    buildPanelHtml(BOTH_TOTALS, READS_COST, QUOTA_OFF, 1000, "en"),
    buildPanelHtml(BOTH_TOTALS, READS_COST, QUOTA_OFF, 1000, "ru"),
    buildPanelHtml(ctxTotals, W, { state: "no-credentials", fiveH: null, sevenD: null }, 1000, "en"),
    buildPanelHtml(ctxTotals, W, { state: "no-credentials", fiveH: null, sevenD: null }, 1000, "ru"),
    buildCodexPanelHtml(QUOTA_OFF, 1000, "en"),
    buildCodexPanelHtml(QUOTA_OFF, 1000, "ru"),
    buildCodexPanelHtml({ state: "ok", fiveH: null, sevenD: null }, 1000, "en", {
      source: "stdio", usage: ORDER_CODEX_USAGE, weights: READS_COST,
    }),
    buildCodexPanelHtml({ state: "ok", fiveH: null, sevenD: null }, 1000, "ru", {
      source: "stdio", usage: ORDER_CODEX_USAGE, weights: READS_COST,
    }),
  ];
  for (const [i, html] of pages.entries()) {
    assert.ok(!html.includes("`"), `page ${i} still shows a backtick`);
  }
});

test("escaping runs before the code span — transcript text cannot inject markup", () => {
  const html = buildPanelHtml(ctxTotals, W, QUOTA_OFF, 1000, "en", undefined, undefined, undefined, [
    {
      agentType: "Explore",
      description: "<script>alert(1)</script> and a `span`",
      modelId: "claude-sonnet-5",
      modelLabel: "Sonnet 5",
      effort: "high",
      effective: 1_000_000,
    },
  ], 1_000_000, undefined, true);
  assert.ok(!/<script>/.test(html), "an agent description is data, never markup");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  // The span still forms: the content inside it was made inert first.
  assert.match(html, /<code>span<\/code>/);
});

test("a title attribute never carries markup", () => {
  // An attribute holds no elements, so the code span must not be drawn there.
  // Today's only hinted row states no setting; this is the guard for the day
  // one of them does.
  const html = buildPanelHtml(ctxTotals, W, {
    state: "ok",
    fiveH: { pct: 10, resetAt: 1000 + 3600 },
    sevenD: { pct: 20, resetAt: 1000 + 86_400 },
    scoped: [{ label: "Fable", pct: 30, resetAt: 1000 + 86_400 }],
    scopedAsOfSec: 1000,
  } as any, 1000, "en");
  const titles = [...html.matchAll(/title="([^"]*)"/g)].map((mm) => mm[1]);
  assert.ok(titles.length > 0, "the scoped row must carry its footnote");
  for (const t of titles) {
    assert.ok(!/[<>`]/.test(t), `title attribute carries markup: ${t}`);
  }
});
