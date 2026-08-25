# Design spec — idle rebuild (what waiting costs) + panel re-order

Status: **IMPLEMENTED** in 1.0.24 — everything except the panel re-order, which
stays proposed and ships separately (see "Decisions taken", point 1).
Written 2026-08-24. Grounded in a measurement over a real 8-day
sample of Claude Code transcripts, deduplicated by `message.id` (the 1.0.17
rule). Extends [`cache-tier-spec.md`](cache-tier-spec.md) — read that first.

## Goal (one sentence)

Show **what waiting costs**: when an agent sits idle longer than its cache
lives, it reloads its whole context and pays for it again — today that spend is
invisible, and it is over half of everything our subagents write to cache.

## Why this, now — the measurement

Run over `~/.claude/projects/**` for one active user, 8 days, dedup by
`message.id`. Ratios and per-turn figures are what matter here; absolute
consumption is that user's private data and is deliberately not reproduced.

| | Lead session | Subagents |
|---|---|---|
| cache TTL of that stream | 1 hour | 5 minutes |
| pauses longer than that TTL | 30 | 136 |
| median pause | 89 min | 10.3 min |
| cache write on a normal turn | 3k | 3k |
| cache write on the turn **after** a pause | 239k | **268k** |
| share of all cache writes spent on reloads | 19% | **53%** |

Cost of those reloads, in token-equivalent: **≈9% of everything the sample
spent** — the subagents' share carried at the 5m write weight, the lead's at the
1h weight.

Two more numbers that decide the guidance we give:

- A **fresh** agent's first turn writes a median of **60k**.
- A **resumed** agent's turn after a pause writes a median of **269k**.
- After resuming, an agent runs a median of **23 more turns**.

So keeping an agent open across a long pause is **not** the cheap option it
looks like. The real lever is the length of the pause, not whether the agent is
reused.

## Why this signal is clean (and the old one was not)

[`research-2026-05-31-findings.md`](research-2026-05-31-findings.md) rejected
idle→re-cache coaching as confounded: a `cache_creation` spike has ≥8 non-idle
causes (model switch, `/compact`, MCP change, effort change…).

That verdict stands for a spike seen **alone**. This spec does not look at
spikes. It looks at a **pair**: a gap longer than *that stream's known TTL*,
immediately followed by a write. And for subagents the confounders are absent
by construction — a subagent does not switch model mid-run, is not compacted,
and gains no MCP servers. The 89× difference between a normal turn (3k) and a
post-pause turn (268k) is not a subtle statistical claim.

For the **lead**, confounders remain real (the owner may switch model during a
long break). Therefore the lead's figure is reported, but the actionable
sentence is only ever shown for subagents.

## What we show, and where

The measured screens (2026-08-24) drive one decision: **the agents' cache
numbers belong in the `Delegated work` section, not in `Cache`.** Today `Cache`
silently describes the main session only, and the reader has no way to know
that. Putting the agents' figures where the reader is already thinking about
agents costs **one line** and needs no new section.

### Panel — `Cache` section: rename the jargon, no new rows

```
Cache
  Cache stays warm ⓘ      1 hour idle
  Input from cache ⓘ      98%
```
```
Кэш
  Кэш держится ⓘ          1 час простоя
  Ввод из кэша ⓘ          98%
```

`Tier` / `Тир` is jargon and goes. The hover tooltip already says it well
(*"Кэш: часовой тир — живёт ~1ч простоя"*) — the panel simply says the same
thing without the word.

### Panel — `Delegated work`: one new line under the existing summary

```
Delegated work (subagents)
  12 subagents · ≈ 40M tok — 48% of this session's consumption
  of that, ≈ 6M went on reloading context after pauses — an agent's cache
  stays warm for 5 minutes
  [group rows, agent list — unchanged]
  A pause past the agent's cache lifetime… …existing note…
```
```
Делегированная работа (субагенты)
  12 субагентов · ≈ 40M ток — 48% расхода сессии
  из них ≈ 6M ушло на повторную загрузку контекста после пауз — кэш агента
  держится 5 минут
  [строки по моделям, список агентов — без изменений]
  Пауза дольше срока жизни кэша… …примечание…
```

One muted line, in the same style as the summary above it, carrying three
facts: **how much**, **why**, and **how long their cache lives**. It appears
only above the threshold; below it the section is exactly as today.

The guidance sentence is appended to the section's existing closing note — no
new paragraph.

### Panel — the lead's own idle time

Reported in `Details` only, as a muted fragment, with no advice attached:
`… · after-idle reloads 900k`. The owner stepping away is not a defect, and
the confounders there are real.

### Tooltip (hover) — one fragment, high bar

The hover is already dense. Extend the existing subagents line **only** above
the act-on-it threshold:

```
subagents: 8 · ≈2.3M tok — Opus 5/xhigh ×4 · 340k reloaded after pauses
```

Below the threshold the hover is unchanged.

### Status bar — unchanged

No new segment. The bar stays quota + context.

## Wording rules (the "report to a director" register)

Every string in this feature obeys all five:

1. **Name the thing, not the mechanism.** "Rebuilt after idle", not
   "cache_creation after TTL expiry".
2. **A number is followed by its meaning.** `≈6M tok · 7% of session` — the
   absolute figure alone means nothing to a first-time reader.
3. **State only the cause the data carries, and never a verdict.** The
   measurement is a gap longer than the cache's life — it does not say what
   filled the gap. Measured on 503 agent logs here, 46% of the tokens counted
   this way were spent inside the agent's own `Bash` call (a test run, a build),
   not with the agent left idle, so a single named cause would be wrong about
   half the time. Name both, mark which one the advice applies to. Never "you
   wasted", never a score, never a grade.
4. **No jargon without its plain-words twin in the same line.** The `ⓘ`
   footnote carries the full explanation; the visible line must be readable
   without opening it.
5. **Silence is the default.** Below threshold we show nothing. An advisory
   line that is always present is noise, and noise is what gets ignored.

Footnote text (EN, panel):

> While an agent waits, its cache goes cold — 5 minutes for subagents, 1 hour
> for the main session. After a long enough pause it loads its whole context
> again and pays for that as a new cache write. This is how many tokens went
> into such reloads. A pause is sometimes unavoidable, but it is paid for all
> the same — which is why the figure is shown as it is.

Russian:

> Пока агент ждёт, его кэш остывает — 5 минут у субагентов, 1 час у основной
> сессии. После долгой паузы он загружает весь свой контекст заново и платит за
> это как за новую запись. Здесь показано, сколько токенов ушло на такие
> повторные загрузки. Пауза бывает вынужденной, но оплачена она в любом
> случае — поэтому цифра показана как есть.

## Detection & data (everything needed is already parsed)

Per stream (main transcript, and each `subagents/agent-*.jsonl` separately):

- **Turn list** = assistant turns **that carry a `usage` object**, in
  **transcript order** (never re-sorted), **deduplicated by `message.id`**
  (without dedup the figure inflates ~2.5×; this is the 1.0.17 rule and it must
  not be re-broken here). A placeholder without `usage` — an interrupt, an
  error — is not a turn: counting it would advance the clock and hide a real
  pause behind it.
- **TTL in force** = from the most recent write whose tier the transcript
  states: `1h` → 3600s, `5m` → 300s. Taken **per gap, not per file**: a session
  that passes its plan limit switches 1h → 5m mid-run, and judging an old gap by
  the tier the session ended on invents rebuilds in one direction and loses them
  in the other. Until some write has stated a tier, nothing is counted — never
  assume a TTL (the standing rule of `cache-tier-spec.md`).
- **Idle rebuild** = for consecutive turns `i-1`, `i`: if
  `t(i) - t(i-1) > TTL`, then turn `i`'s cache write counts as a rebuild,
  keeping its own tier split.
- **Cost** = the rebuild's own tiered split at the same weights the session
  headline uses (`1h` ×2.0, `5m` ×1.25, unstated → the setting), so the figure
  is always a true subset of the number printed beside it.
- **Share** = rebuild cost ÷ session token-equivalent, rounded to a whole
  percent; `<1` rather than `0` when non-zero (the existing rule from the
  subagents section).
- **Agents touched** = how many subagent streams contain at least one rebuild.

Edge cases:

- No tier ever stated → nothing is counted, and the line says nothing about it.
- Fewer than 2 turns → no gaps, contributes 0.
- Missing/unparseable `timestamp` → that turn is a **barrier**: its tokens still
  count in the totals, but no gap is measured across it. Bridging over it would
  invent a pause that the skipped turn disproves.
- Clock skew (a timestamp at or before the previous one) → also a barrier, and
  it poisons the **following** interval too: the next gap would otherwise be
  measured against a clock we have just seen misbehave. The tier such a turn
  states is still remembered — the skew makes its *time* untrustworthy, not its
  statement about which cache was written.
- A `cache_creation` breakdown that contradicts the top-level total, or carries
  a negative/non-finite count → the write keeps its total but is treated as
  **untiered**, and cannot report a tier anywhere in the UI.

## Thresholds — when each thing appears

| Element | Appears when |
|---|---|
| The reload line under the subagents summary | reload cost ≥ 1M tok **and** ≥ 3% of session |
| The guidance sentence in the closing note | reload ≥ **20%** of all subagent cache writes |
| The tooltip fragment | same as the guidance sentence |
| The lead's fragment in `Details` | always, when non-zero (no advice attached) |

Rationale: below 3% the number is real but not worth a director's attention;
the 20% bar is where the measured sample sat (53%), i.e. where there
is genuinely something to change.

**Refinement made during implementation (1.0.24):** the guidance sentence and
the tooltip fragment are additionally gated on the reload *line* being visible.
A sentence advising about reloads with no figure above it is precisely the
always-on advisory that wording rule 5 forbids. In practice the two conditions
almost always coincide; when they do not, silence wins.

Never coloured red or yellow. This is information, not a quota with
consequences — the same rule the context dot already follows.

## Weight fix (must ship with this, or the numbers stay wrong)

`cacheWriteWeight` is a single `1.25` for everything
([package.json](../package.json)). But a 1-hour cache write costs **2.0×** a
fresh input token and a 5-minute write **1.25×**. The lead writes exclusively to
the 1-hour tier (measured: every lead write landed in 1h, none in 5m), so **we currently understate
the lead's spend by ~10%** of its total.

- Weight becomes tier-dependent: `1h → 2.0`, `5m → 1.25`, tier unknown → keep
  `1.25` (the conservative option — never inflate a number we cannot ground).
- `cacheWriteWeight` stays a setting, and stays the value used when the tier is
  unknown, so nobody's configuration silently changes meaning.
- **CHANGELOG must say the figure grows and why.** A user who sees their
  token-equivalent jump after an update, with no explanation, will read it as a
  bug.

## Panel re-order — **shipped in 1.0.25** (release B)

Built as specified below, with two additions decided during the work:

- The **Codex panel** was re-ordered identically. It is a second page in the same
  extension; leaving it on the old order would rearrange the page under a user
  who switches provider. Its cost line gained the same ⓘ, and the shared
  `hintSpan` / hover CSS moved to module scope so both panels hover alike.
- **Nothing is shown blank.** While Codex has not answered yet there is no
  comparison to draw, so the cost line stands alone with a dash instead of three
  empty rows — blank "without cache" / "saved" rows read as zeros.

Order locked by tests (`the page reads left → where → how well → raw number`,
plus the Codex twin and a check that the ⓘ still carries every moved figure).



Measured against the real screens: the panel opens with **four lines and a
disclaimer** about the token-equivalent — the block that
[`product-direction.md`](product-direction.md) itself demoted to "a quiet
optional extra". The reader's first question is "how much have I got left", and
today that is the third thing on the page.

| Now | Proposed |
|---|---|
| Identity | Identity |
| Token-equivalent · without cache · saved (+ 2-line note) | **Quota + context** |
| Quota + context | **Delegated work** (where it went) |
| Cache | **Cache** (how well it is spent) |
| Delegated work | Token-equivalent — **one line**; "without cache", "saved" and the disclaimer move into its `ⓘ` |
| Details | Details |

Net effect: five lines at the top of the page become one, and the page answers
*how much is left → where it went → how well it is being spent → raw numbers*.
Nothing is deleted; two curiosity figures and a disclaimer move into a footnote
that is one hover away.

**Cost of doing it:** the README and both marketplace listings carry panel
screenshots that would need retaking. That is the argument for shipping the
re-order separately from the numbers change — see open question 1.

## Non-goals

- No score, grade, or efficiency verdict. (Standing decision.)
- No status-bar change.
- No per-pause list ("agent X idled 12 min ×4") — that is a wall of text for a
  number the user can act on in aggregate.
- No history/persistence. Still shelved.
- No guidance for the lead's own idle time: the owner stepping away is not a
  defect, and the confounders there are real.

## Test plan (pure logic, mirroring the existing suite)

1. Gap detection honours the stream's own TTL: same 10-minute gap counts as a
   rebuild for a `5m` stream, not for a `1h` one.
2. Dedup by `message.id` before gap analysis; a doubled transcript yields the
   same figure as a clean one.
3. Tier unknown → stream excluded entirely; no crash, no assumed TTL.
4. Thresholds: 2.9% → row hidden; 3.1% → row shown, sentence hidden; 21% of
   writes → sentence shown.
5. `<1%` prints as `<1`, never `0`, when the cost is non-zero.
6. Weight: a 1h-tier write scores 2.0×, a 5m write 1.25×, unknown 1.25×.
7. Render: line present in panel and (above threshold) tooltip, EN and RU;
   bar unchanged.
8. The `Tier` → `Cache stays warm` / `Тир` → `Кэш держится` rename keeps the
   same `ⓘ` footnote and the same value strings; existing render tests updated,
   not deleted.

## Decisions taken (owner, 2026-08-24)

1. **Two releases, split by content vs form.** Release A = the weight fix, the
   reload line, and the `Tier` rename — everything that changes *what the
   numbers say*, inside today's layout. Release B = the panel re-order.
   Rationale: a user who sees a figure grow **and** the page rearranged in one
   update reads it as breakage, not as an improvement.
2. **The long wording wins** (owner delegated the choice): *"of that, ≈6M went
   on reloading context after pauses — an agent's cache stays warm for 5
   minutes"*. It satisfies wording rule 4 — the visible line must be readable
   without opening the `ⓘ` — and the panel is wide enough in practice (measured
   on the reference screenshots).

3. **One trigger, not two.** The guidance sentence fires on a single condition:
   reloads are **20%+ of everything the subagents wrote to cache**. The
   two-condition fallback (also requiring 3+ separate pauses) is **rejected**.

   Owner's reasoning, and it is right: a single long pause is not a false
   positive. The tokens were spent either way. A justified wait is still a paid
   wait, so reporting it is not misleading the user — it is telling them what
   this session cost. Building a second condition to suppress a true number
   would be complexity bought with accuracy.

   The nuance — that a pause can be unavoidable — belongs in the `ⓘ` footnote,
   never in the visible line. Everything we explain inline is another brick in
   the wall of text we are trying not to build.
