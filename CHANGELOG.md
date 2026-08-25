# Changelog

All notable changes to **cc-statusbar** are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **What waiting cost each agent, agent by agent.** The delegated-work list now
  ends every row with `idle 31% (≈ 800k)` — the share of *that agent's own*
  spend that went on loading its context again after a pause, and the tokens
  behind the share. The percentage says how bad, the tokens say whether it is
  worth changing anything: 31% of a small agent is a rounding error, 31% of a
  large one is worth looking into. The figure says a pause outlasted the cache;
  it does not say what filled the pause, and the panel does not pretend
  otherwise — on the 503 agent logs measured here, 46% of the tokens counted
  this way came from pauses whose longest silence ran from the agent's own
  `Bash` call to its result, not from an agent sitting idle.
  `0%` means no waiting cost was measured for that agent: every
  pause it took was judged, and none of them priced to anything — an answer, not
  a gap — an agent that never paused reads `0%` for that reason. Where a **pause**
  could not be judged and nothing else priced to anything (no cache lifetime
  stated to measure that pause against, a turn that cannot be placed in time), or
  where the agent has no measurable spend at all (an empty log, a log of
  placeholders, a read that failed), the row shows `—`, because a zero there
  would be an invention: on 500 real agent logs that was 1% of them, and when no
  listed agent can be measured the column is left out altogether. Where part of a log could be measured and part
  could not, the figure is marked `≥` — a floor, never presented as the number,
  and floors are truncated rather than rounded, so `≥` never claims more than
  was actually measured. The summary line
  above the list now carries the same share for all agents together, so a row
  can be read against it. Both figures come from data the extension already
  parsed, so the list costs nothing extra.
- **A way back to the project.** Both hovers and both panels now end with
  **“Report an issue”** (RU: «Сообщить о проблеме»), linking to the GitHub issue
  tracker. Until now the extension pointed nowhere: almost everyone installs it
  from inside the editor and never opens the marketplace page, so a wrong number
  had no route to a bug report. A test keeps the link in step with `bugs.url` in
  `package.json`, so the two cannot drift apart.

### Fixed

- **The hover still said “tier”.** 1.0.24 dropped that word from the panel but
  missed the same line in the hover, so one fact had two names: “Cache stays
  warm — 1 hour idle” in the panel, “1-hour tier” in the hover. Both now read
  the same (RU: «Кэш держится — 1 час простоя»), and a test fails if the word
  comes back on either surface.
- **Codex's cache-write counter was being thrown away.** Codex does state one
  (`cache_write_input_tokens`), and the extension parsed every other counter
  around it while dropping this one — so the Details line said `write n/a` and
  the panel claimed Codex reports no writes at all. It is now read from both the
  app-server and rollout shapes, printed as Codex stated it, and named in the ⓘ
  when it is not zero, and priced in the token-equivalent at the write weight
  (see the entry below on how). A payload
  that states nothing still reads `n/a`, which is not the same as a stated `0`.
  (On this machine 54,873 turns across 1,700 rollouts state the counter, and
  every one of them states `0`. The field appears twice per `token_count`
  event — once in `total_token_usage`, once in `last_token_usage` — so a raw
  occurrence count doubles the sample.)
- **Two English strings survived in the Russian UI.** A Codex model with no
  context window printed “model context window unavailable”, and an agent whose
  type the transcript never named printed “agent”, both in Russian panels. Both
  now follow the interface language.
- **The `idle` column blamed the wrong thing.** Its legend read “a figure above
  zero is not the agent's doing: its cache went cold while it was left open”,
  and the advice line under the list opened “usually an agent left open while
  another one works”. What the extension actually measures is a gap between two
  turns longer than the live cache lifetime — it never looks at what filled the
  gap. Re-measured against 503 agent logs on the author's machine: of the 448
  counted gaps carrying 114.4M tokens, **188 gaps and 52.6M tokens (46%) ran
  from the agent's own `Bash` tool call to its result** — a test suite, a build —
  and 63 of the 193 agents that would show a non-zero figure have it caused
  mostly by their own command. An agent that spends ten minutes running tests
  was being told it had been left idle. Both surfaces now name a pause that
  outlasted the cache, list both possible causes, and attach the “start a fresh
  agent instead” advice only to the one it fits.
- **A Codex cache write was priced as ordinary fresh input.** This is a change
  to the figure, not only to the words around it. OpenAI documents
  `input_tokens_details` as a breakdown of the input count, with
  `ordinary = input − cached − cache_write`, cached reads at 0.1× and writes at
  1.25×; Codex maps its field straight through from there, and its own parse
  test carries `input 100 · cached 40 · write 60 · output 10 · total 110`, where
  the write moves no total. The extension used to subtract only the reads, which
  left every written token priced at 1× — for a payload of 100k input / 40k
  cached / 12k written / 5k output the panel showed **72k** where it used to
  show 69k. The three input buckets are now priced once each, and the write is
  clamped to what the reads leave so a breakdown bigger than the whole can never
  produce a negative bucket. Two earlier statements went with it: the ⓘ no
  longer says the protocol is silent on the relationship (it is not), and the
  panel no longer says the write is left out of the figure (it is not).
- **The Codex panel gained the two hints it could never reach before.** With
  writes priced, the with-cache figure can now be the larger one because of a
  warm-up, not only because of a read weight above 1. Codex states no cache
  lifetime, so it gets its own wording for those two sentences rather than
  Claude's, which names “1-hour ×2.0, 5-minute ×1.25” — tiers this provider does
  not have.
- **“So far” was promised where the arithmetic forbids a turn.** The gap between
  the two figures is the sum of `bucket × (weight − 1)`, so only a bucket priced
  below a fresh token can ever close it. Both panels now drop the hedge when no
  weight is below 1 — on the `about the same` line as well as the `~N× less`
  one. This is not a Codex quirk: set `cacheReadWeight` above 1 on the Claude
  panel and it drops there too.
- **The `≥` marker had no definition on two of the surfaces that print it.** The
  full note hangs off the delegated-work section, which can be absent entirely,
  while the lead's own reloads appear in `Details` regardless and the hover has
  no ⓘ at all. Both now carry the rule in one clause.
- **Two published numbers overstated what was measured.** “Over half of
  everything subagents write to cache” is 48% across the 505 agent logs measured
  here (114.4M reload tokens against 236.8M written); it reaches 54% only once
  each agent's unavoidable first load is set aside, which the sentence did not
  say. And the Codex sample of “109,746 turns” was a count of field
  occurrences — the counter appears twice in every `token_count` event, in
  `total_token_usage` and again in `last_token_usage` — so the real sample is
  54,873 turns. Both figures are stated as measured now, in README, this file
  and the specs under `docs/`.

### Changed

- **What the cache is doing for you is now on the page, not under a hover.** The
  panel shows `without cache ≈ 110.5M tok — ~7.9× more` as a plain line under
  the headline number (RU: «без кэша было бы …»). It is the one figure that says
  what cache reuse is worth, and anyone who never hovers used to miss it
  entirely. Only the derived total (“Cache saved”, what the two figures differ
  by — an exact difference, which rounding can leave larger than two printed
  figures suggest) and the not-a-money-price disclaimer stay in the ⓘ. Same
  change in the Codex panel — switching provider must not move a number the
  reader has learned to look for.
- **The comparison now states the direction it actually measures.** Early in a
  session the cache has *not* saved you anything yet: a 1-hour cache write is
  priced at 2× a fresh input token and nothing has been read back from it, so
  the with-cache figure can legitimately be the larger of the two. Every surface
  used to claim a saving regardless — a wrong-signed statement that had been
  hiding in the hover since the feature shipped, and that this release would
  have put in plain sight. It now reads *“~2× less, so far”* while that is
  true, *“about the same so far”* when the **ratio** rounds to 1×, and it
  drops the multiplier entirely when one side is zero and no ratio exists. The
  ⓘ names the cause the arithmetic actually supports — whichever of cache reads
  or cache writes contributed more to the difference, or *both* where a
  `cacheReadWeight` above 1 makes reads add cost instead of saving it; none at
  all when the cache is genuinely not moving the figure; and, when a real
  difference is smaller
  than anything this page prints (both figures round to the same text *and* the
  ratio rounds to 1×), it says exactly that instead. Naming one of two identical
  numbers the larger contradicts what is on the screen, and calling a hidden 98k
  premium “nothing” contradicts the arithmetic. Codex gets its own wording for
  the two of these that name Claude's cache tiers, because it states none. The
  hover names no cause at all; it has no room for the full
  explanation, and naming the wrong one is worse than naming none.
- **The page no longer hides its own footer behind a long list.** Order is now:
  model → quota + context → what the session cost → the raw figures behind it →
  cache → delegated work. The agent list is the one block that grows with the
  session (up to its cap of 12 rows, with the remainder stated), so it closes
  the page: with a dozen agents open, `Details` used to sit below the fold and
  was never seen.
- **The agent list folds away.** It opens and closes from a link at the foot of
  the section (`Show each agent ▾` / RU «Показать по агентам ▾»), and the choice
  is remembered. What stays visible either way: how much went to agents, to
  which models, and — when it clears the threshold that line has always had —
  what waiting cost them. There is also a command for it —
  *“Claude/Codex Statusbar: Show/hide the agent list in the panel”*. The panel
  still runs **no scripts**: the link runs that one command, and the state lives
  in the extension, because the page itself is re-rendered every few seconds and
  cannot remember anything.
- Marketplace keywords now include `subagents`, `cursor`, `windsurf` and
  `vscodium` — the extension already works in those editors and in any VS Code
  fork with Claude Code or Codex installed.

## [1.0.25] — 2026-08-24

### Changed

- **The panel opens on your quota, not on a raw token count.** Nothing was
  removed and no number changed — only the order of the page. It now answers, in
  this order:

  1. **which model** is running,
  2. **how much you have left** — the 5-hour and 7-day windows, plus the context
     window,
  3. **where it went** — delegated work,
  4. **how well it is spent** — cache,
  5. **the raw number** — token-equivalent, on one line,
  6. **Details**.

  Previously the page opened with four lines and a disclaimer about the
  token-equivalent — the block this extension itself treats as a quiet optional
  extra — and pushed the quota down to third place.

- **"Without cache", "Cache saved" and the pricing disclaimer moved into the
  ⓘ** on the token-equivalent line. They are one hover away, with the same
  numbers and the same wording. Five lines at the top of the page became one at
  the foot of it.

- **The Codex panel was re-ordered the same way**, so switching provider does not
  rearrange the page under you. While Codex has not answered yet, the line shows
  a dash on its own instead of three blank rows that read as zeros.

## [1.0.24] — 2026-08-24

### Changed

- **Your token-equivalent figure goes up after this update — the old one was too
  low.** A cache write was priced at a flat ×1.25, whatever it was. But the price
  depends on how long the cache is kept: a **1-hour** write costs **2.0×** a
  fresh input token, a **5-minute** write **1.25×**. The main session writes
  almost exclusively to the 1-hour tier, so its own spend was understated by
  about 10%. Measured across real sessions, the headline moves **1–9%** — the
  more of the work was delegated to subagents (which run at 5 minutes), the less
  it moves. Nothing about your usage changed; only the arithmetic got right.

  - The tier is **read from the transcript**
    (`cache_creation.ephemeral_{1h,5m}_input_tokens`), never assumed.
  - `ccStatusbar.cacheWriteWeight` still exists and still defaults to 1.25, but
    it now applies **only** to writes whose tier the transcript does not state.
    A tuned setting keeps meaning exactly what it meant.

- **The panel's cache row drops the word "Tier".** It now reads **"Cache stays
  warm — 1 hour idle"** (RU: «Кэш держится — 1 час простоя»). Same footnote,
  same data, one less word to look up.

### Added

- **What waiting costs.** While an agent sits idle its cache goes cold — 5
  minutes for a subagent, 1 hour for the main session. After a long enough pause
  it loads its whole context again and pays for that as a new cache write. That
  spend was invisible, and across the 505 agent logs measured here it is **48%**
  of everything the subagents write to cache — **54%** once each agent's
  unavoidable first load is set aside. The delegated-work section now says
  how much, in one line:

  > of that, ≈ 6M went on reloading context after pauses — an agent's cache
  > stays warm for 5 minutes

  - **Shown only when it is worth your attention:** the reloads must cost at
    least 1M tokens **and** 3% of the session. Below that, nothing appears.
  - **One sentence of guidance** is added when reloads are 20%+ of everything
    the agents wrote to cache — the point where there is something to change.
  - **The main session's own reloads** are reported in **Details**, with no
    advice attached: stepping away from the keyboard is not a defect.
  - **Never coloured.** This is information, not a quota with consequences —
    the same rule the context dot follows.
  - **The status bar is unchanged.** No new segment; it stays quota + context.

### Notes

- Detection looks at a **pair**, never a spike alone: a gap longer than the TTL
  of the cache that was live at that moment, immediately followed by a write.
  The tier is taken **per gap**, not once per file, because a session that
  passes its plan limit switches 1h → 5m mid-run. Turns are deduplicated by
  `message.id` first (without it the figure inflates ~2.5×); a turn whose clock
  cannot be read, or whose clock goes backwards, is a **barrier** — no gap is
  measured across it; and with no stated tier nothing is counted at all, because
  a TTL is never assumed.
- The main transcript is now parsed **once per change** instead of once per
  derived value per tick (cached by mtime+size, like the agent files already
  were), so the new metric costs nothing on an idle session.
- `statusline.py`, the optional zero-request quota bridge the README has always
  referred to, now actually ships in the repository.

## [1.0.23] — 2026-08-09

### Fixed

- **The limits stopped updating the moment you stopped typing — and clicking to
  refresh could not fix it.** Both symptoms came from one gate. Polling was
  allowed only while the session transcript had been touched in the last
  `quota.minPollSeconds`, so after a few idle minutes the 5h/7d numbers froze at
  their last reading and the bar fell back to its neutral offline marker. The
  refresh command zeroed the throttles but **not** that gate, so a click issued
  no request at all — it just repainted the same figures. Which is the worst
  possible pairing: the check you reach for when a number looks stale is the one
  guaranteed to be swallowed, because looking stale *is* being idle.

  The gate was written when the only way to read the limits was a request that
  spent a token, and "don't spend tokens on an idle editor" was right. Since
  1.0.22 the primary source is a plain `GET` that costs nothing — the reason had
  expired, the gate had not. It now applies **only** to the paid header poll:

  - **The free usage route polls on a fixed cadence, idle or not** — once per
    `quota.minPollSeconds` (default 300s). Walk away for two hours and the 5h,
    7d and per-model weekly windows are still current when you glance back,
    which is the whole point during a long autonomous run.
  - **A click overrides every gate** — throttle, activity window and rate-limit
    backoff alike — bounded by a 10-second anti-spam floor.
  - **Open editor windows share one poll** via
    `~/.claude/.cc-statusbar-usage.json`, so N windows still make one request
    per interval rather than N. A window that skips its own request still shows
    the reading the request that *did* run brought home.

- **One 429 no longer takes the whole feature off the air for an hour.** Both
  routes shared a single backoff timer, so a `Retry-After: 3600` from the free
  GET also gagged the independent header poll. They now back off separately, and
  the free route's backoff is **capped at 15 minutes**: the only two 429s ever
  observed on it arrived in the same second as a `401` on the other route —
  i.e. while the on-disk OAuth token was briefly expired — and obeying an hour
  of silence over a token the CLI refreshed 47 seconds later is a cure worse
  than the disease. The paid route still honours `Retry-After` verbatim.

- **A paused poll now says so.** The tooltip and panel state "polling paused by
  the server — resumes in N", instead of leaving a number to age with no stated
  reason. An unexplained stale reading is the one failure nobody can report.

### Notes

- No new token cost: the cadence change applies only to the zero-token route.
- A persistently failing usage route gets 3 quick retries before settling back
  to the normal interval, so an offline machine no longer retries forever now
  that idleness alone does not stop it.
- **Everything remembered is keyed by account.** The shared file's name carries
  a fingerprint of the resolved `credentialsPath`, and so do the persisted
  last-known readings — so switching credential files (even between sessions)
  can no longer put one account's percentages on another's bar. A reading across
  accounts is a *wrong* figure, not a stale one. An answer that arrives after a
  switch is discarded rather than applied.
- **One request per interval per machine, not per window.** Windows take a
  short-lived, expiring claim before polling, so several opening at once do not
  all fetch the same number. The claim expires on its own, and can only be
  released by the window that took it, so neither a crash nor a suspend can
  block the others — and if the claim cannot be written at all (read-only home,
  permissions), every window simply polls, because a coordination file must
  never become a way for the limits to go quiet.
- **A custom `credentialsPath` no longer borrows the default account's files.**
  Claude Code writes its statusLine bridge and `~/.claude.json` cache for
  whoever *it* is signed in as, so on a non-default credentials file those two
  sources are now skipped rather than merged in.
- **`Retry-After` is read in both of its legal forms.** An HTTP-date used to
  parse as `NaN` — i.e. as "the server asked for nothing" — so a route that had
  named an exact time to wait for could be retried early.

## [1.0.22] — 2026-07-26

### Added

- **Per-model weekly limits — starting with Fable.** Fable is capped at a share
  of the weekly allowance, so it runs out at its own pace and the overall `7d`
  number says nothing about it; until now the only way to check was to open
  claude.ai. The tooltip and panel now carry its own row —
  `🔴 Fable (7d) ▓▓▓▓▓▓▓░ 91% over pace · resets in 2d18h` — alongside 5h/7d,
  and a click on the item refreshes it like everything else. The collapsed
  status-bar line is unchanged (tariff only, as before).

  Rows are **server-driven** — no hardcoded model list, so a future scoped
  window appears on its own.

### Changed

- **Quota now comes from the account's usage payload — one request, every
  window, zero tokens.** `GET /api/oauth/usage` (the route Claude Code itself
  calls for `/usage`, same local OAuth token) returns 5h, 7d **and** the
  per-model weekly windows in a single plain read. It replaces the old
  1-token-per-poll message trick in the steady state: same throttle, same
  activity gate, same manual-refresh click — **but it no longer costs tokens and
  it carries strictly more data**.

  Nothing was removed. The header poll stays as the safety net and resumes
  automatically the moment the payload route fails or stops carrying 5h/7d
  (`usageCoversQuota` in `src/quota.ts` is the single, unit-tested condition).
  Below it sit the statusLine bridge and — new — Claude Code's own on-disk copy
  of the payload in `~/.claude.json`, so the numbers survive a dead link and a
  reload alike. The freshest valid reading always wins.

  Freshness is stated, never assumed: a per-model row older than 15 min shows
  its age inline, and one older than 24h is hidden rather than presented as
  current. Undocumented shapes → parsing is isolated in `src/usage.ts` and any
  change degrades to "no row" instead of a wrong number.

## [1.0.21] — 2026-07-25

### Added

- Codex now shows the confirmed lead model and reasoning effort at the start of
  the status-bar line, tooltip, and panel. Both values come from the local
  rollout `turn_context`, so the feature adds no network request or token cost.

### Fixed

- `Auto` could never select Codex: the resolver treated every historical Claude
  transcript as permanently active while hard-coding Codex as inactive until it
  had already been selected manually. Auto now refreshes the matching Codex
  thread through the persistent local app-server connection, treats only the
  last minute as live activity, and keeps the most recently active provider as
  the idle fallback. Two genuinely live providers still produce the explicit
  conflict state.

## [1.0.20] — 2026-07-25

### Added

- **The model you are talking to, right in the status-bar line.** The line now
  starts with e.g. `◆ Opus 5`, so the model is visible passively, where the eyes
  already are — instead of only inside the chat UI's picker. It answers the
  question that costs real quota when it goes unnoticed: *"am I about to type
  'continue' into the wrong model?"*
  - `◆` = **confirmed**: that model ran the last real turn (read from the local
    transcript, zero network, zero token cost).
  - `◇` = **planned**: the chat has not answered yet, so the name comes from
    Claude Code's own settings (`model` key — which its VS Code model picker
    writes, and `/model` writes when saved as the default for new sessions).
    That is what a **new** chat will start on, which is the only truthful answer
    available before the first reply exists. With nothing pinned the line says
    `default model` rather than inventing one.
  - A chat that has never answered is identified through Claude Code's
    live-session registry (`~/.claude/sessions/*.json`, written when the tab
    opens — measured ~146s before the first prompt created the transcript): a
    registered session with no transcript file has never replied. Without this the
    bar would show the **previous** session's model as if it were current, which
    is exactly the mistake the feature exists to prevent. A **resumed** chat keeps
    its confirmed model — its transcript already exists, so a known fact is not
    downgraded to an expectation just because the process restarted.
  - When an unanswered chat is open **beside** an active one, the bar names it
    (`⚠ new chat: Sonnet 5`) rather than guessing which tab has focus — VS Code
    exposes no API for that. Silent when both would run the same model.
  - **A switch is flagged until the next reply**, not for a fixed number of
    seconds: a timer would quietly expire while you are away from the keyboard,
    which is exactly when a switch goes unnoticed. It is not a background colour —
    identity never tints the item (same rule as context: only tariff pace does).
  - **Subagent models never appear here.** A Sonnet helper spawned by an Opus
    lead does not change the line: subagent turns live in separate
    `subagents/agent-*.jsonl` files and additionally carry `isSidechain`, and both
    are excluded.
  - The display name reuses `display_name` from the Models API response the
    extension already fetches for the context-window limit — no extra request.
    Offline the label is derived from the model id for Anthropic's own id shapes,
    so it shows instantly. Ids from other deployments (Bedrock ARNs, Vertex /
    Foundry names, private aliases) are kept as they are, trimmed to their
    identifying tail: a shortener guessing at them would produce a confident wrong
    name.
  - The planned value also honours `ANTHROPIC_MODEL`, and an explicit
    `"model": "default"` in a narrower settings file *clears* a broader pin
    instead of deferring to it.
  - New setting `ccStatusbar.model.enabled` (default `true`).
- **Reasoning effort next to the model** — `◆ Opus 5 · effort high`. Same two
  sources and the same honesty rules as the model: confirmed from the last turn's
  `effort` field, or planned from Claude Code's settings (`effortLevel`, and
  `ultracode: true` which *means* xhigh). A switch is flagged until the next reply
  (`⚠ effort high → xhigh`). Older transcripts have no effort field — then
  nothing is shown rather than a guess. Deliberately worded `effort` / `усилие`,
  not `эфф`: that abbreviation already means *effective tokens* in this UI and
  the two can appear in the same line.
- **Delegated work: which models your subagents actually used.** The hover
  tooltip gains one line — `subagents: 8 · ≈2.3M tok — Opus 5/xhigh ×4 ≈1.5M ·
  Sonnet 5/xhigh ×4 ≈861.8k` — and the panel gains a full section: spend grouped
  by model+effort (with each group's share), then the individual agents, each with
  its type, model, effort, token-equivalent and task description (capped at 12
  with "+N more" stated, never a silent cut). Those models are chosen by the agent
  that spawned each worker, not by you; this is the only place that choice is
  visible, and it is usually where the session's tokens actually went.
  Individual agents are listed **most expensive first** — ordering by recency
  could hide the biggest spender below the cut — and grouping keys on the raw
  model id, so two different deployments of one family never merge into a single
  row. Agents spawned by another agent rather than by the Lead are marked
  `depth N` (nesting reaches depth 5 in practice), so the breakdown says who
  actually chose to spend the tokens.
- New setting `ccStatusbar.subagents.enabled` (default `true`) hides the
  breakdown without affecting the corrected totals.
- Agent transcripts are parsed once and cached by mtime+size of both the log and
  its metadata file, so the new breakdown costs no extra work on the 10s redraw
  tick even in a session with dozens of agents, and a description written after
  the log still appears. Cache entries outside the watched session are dropped.

### Changed

- **The hover is grouped instead of being one long column.** It had grown to
  cover identity, cost, quota, session facts, technical detail and actions with
  nothing separating them. Blocks are now divided by a rule, and the context /
  cache / subagent lines moved out of the quota bullet list into their own
  labelled **This session** group — they answer a different question from the
  subscription tariff and should not read as more of it. The panel gets the same
  treatment with a short left-aligned rule above each section (a Markdown hover
  offers no width or colour control; the panel, where the CSS is ours, does).
- **The context dot warns much earlier: 🟢 <40% · 🟡 40–60% · 🔴 60%+** (was
  <50 / 50–80 / 80+). Filling a 1M window is never the goal — answer quality
  degrades progressively long before the limit, and a fatter context also costs
  more quota per turn. So 🟡 now reads as "start looking for a good place to
  finish, ideally before auto-compaction decides for you" and 🔴 as "wrap up and
  carry the rest into a fresh session". A dot that only turned red at 80% was
  warning after the damage was done. The dot still never tints the whole item —
  only tariff pace does that.
- **The selected provider / language is now visible at a glance.** It used to be
  plain bold text — the same colour as every other word in the hover, while the
  alternatives were blue links — so the current choice could not be told apart
  from ordinary prose. It is now marked `✓` and bold, giving the row three states
  that cannot be confused: blue = clickable · ✓ bold = current · 🟢 = this source
  has data right now (a different question from "selected"). Colour and an
  underline were tried and dropped: the status-bar tooltip strips inline styling
  even though the tag and attribute are in the markdown sanitiser's default
  allowlists — that surface is not the editor's regular markdown hover.

### Fixed

- **A small delegation share printed as "0%"** in the panel — in the very section
  about what delegation cost. A real but sub-percent share now reads `<1%`.
- **The 5h/7d quota could stop arriving for weeks on a perfectly working
  connection.** The poll failed at the CONNECT stage, so the bar showed "quota
  offline" while Claude Code's own usage view showed the numbers fine. Cause:
  `api.anthropic.com` publishes both an A and an AAAA record, and Node's Happy
  Eyeballs gives each address family only **250 ms** to connect. On a link whose
  IPv4 handshake takes 350–550 ms — perfectly normal — Node abandoned the
  *working* IPv4 address, moved on to an IPv6 address with no route, and the
  request died with a connect timeout. Measured on the affected machine: IPv4
  connected in 352 ms, IPv6 timed out, and the identical request from Python
  answered in 1.5 s.
  The transport now uses Node's `https` instead of `fetch`, which allows a
  per-request family budget (2 s — far above any real handshake, still fast to
  give up when a family truly is unreachable), and pins IPv4 on the last of the
  three attempts. Same request on the same machine: **HTTP 200 in 1.8 s**.
  Two bonuses: the context-window limit uses the same transport, so it too stops
  falling back to the built-in table; and `https` honours the proxy support the
  editor patches into Node, which `fetch` never did.
- **Subagent tokens were counted as ZERO — the session cost was massively
  understated.** `sumTranscript` skipped `isSidechain` turns (correct for the
  main transcript, where inlined sidechains would otherwise be double-counted),
  but **every** turn inside an `agent-*.jsonl` is a sidechain by definition, so
  each agent file summed to nothing. Measured on a real 8-subagent session:
  2.32M of 2.75M effective tokens — **84%** — were missing from the headline,
  the panel, and the `eff` fallback in the bar. Agent files are now summed with
  sidechains included; the main transcript still excludes them.

- **A turn without a model no longer inherits the previous one.** The model was
  only overwritten when the newest turn carried one, so an older model could be
  presented as CONFIRMED beside newer token counts. It is now reset per turn —
  fail-visibly rather than fail-confidently.
- **`<synthetic>` placeholder turns no longer affect the context %.** Claude Code
  writes assistant entries with model `<synthetic>` for interrupts/errors; those
  were being treated as a real prompt, so a synthetic turn could reset the shown
  context fill and be used as the key for a context-window lookup. They are now
  skipped.
- **The "updated N ago" note folded into the last quota bullet** in the hover
  (`… resets in 3d0h Updated 5m ago.`) — a Markdown list swallows a following
  line without a blank separator.
- **The panel lost its quota heading when the quota was offline**, so it opened
  with a bare "temporarily unavailable" and no clue what was unavailable.
- **A subagent's token value wrapped onto two lines** in the panel: it was sharing
  the narrow column sized for a bare quota percentage.
- **Russian plural forms** for the subagent count ("2 саб-агента", not
  "2 саб-агент(ов)").
- **README corrected:** the local statusline quota bridge was described as
  covering both terminal and in-editor sessions. It does not — the VS Code /
  Cursor integration runs Claude Code without a status line (as `statusline.py`
  and the 1.0.19 notes already stated), so in the IDE the network poll is what
  keeps the limits current.

## [1.0.19] — 2026-06-22

### Fixed

- **Quota now survives a flaky connection (the main fix).** On an intermittent
  link (e.g. phone tethering) the periodic quota request would time out and the
  extension then waited the FULL poll interval (5 min) before trying again, so
  the limits could stay stale for a long time. After a failed poll it now
  retries quickly (~45s), so a link that works for only short windows is caught
  within a minute or two instead of freezing. The network poll's activity gating
  is otherwise unchanged.
- **The context-window % no longer vanishes on a weak link.** Two fixes: (1) a
  model's window was cached for 24h, and when that expired mid-session a timed-out
  refresh OVERWROTE the good cached value with an error, hiding the context %; a
  model's window never changes, so a known-good value is now kept indefinitely and
  is never overwritten by a failed fetch (failures are just retried; legacy cached
  errors are ignored on start). (2) The extension now ships a built-in table of
  API-confirmed context windows for current Claude models, so the context % shows
  INSTANTLY and fully offline — the live API value still overrides it when
  reachable (and covers future/unknown models).
- **The expandable panel no longer shows a stale quota as if it were live.** It
  now applies the same freshness rule as the status bar: a non-live reading shows
  an offline note plus the exact last-known values as muted text ("Last known:
  5h N%, 7d N% (updated N ago)"), instead of painting old percentages.

### Changed

- **The colored % is now shown ONLY while it's live; stale data is never
  painted.** The bar's whole job is a glanceable color (within limits / tight /
  over), so coloring an out-of-date number is a confident lie. If a reading is
  no longer fresh (the poll has been unable to refresh for more than the poll
  cadence), the bar drops the colored % and shows a neutral, un-colored
  "offline" marker instead — the simple rule becomes "colored % = live, offline
  marker = no live data right now", with no need to read fine print. The exact
  last-known values and their age ("updated N ago") remain in the hover tooltip
  for anyone who wants them.

### Added

- **Optional local, zero-network quota source (advanced/opt-in).** The extension
  now reads `~/.claude/.cc-statusbar-quota.json` if that file exists, using its
  5h/7d values with no network call at all. The displayed value is always the
  *freshest* of this file and the network poll — strictly additive, never a
  regression. Nothing writes this file by default; it's a hook for users whose
  Claude Code status line mirrors the real limits there (Claude Code hands those
  limits to the status-line command on each turn). Note that the VS Code/Cursor
  IDE integration runs Claude Code without a status line, so this path only
  applies to terminal `claude` sessions — in the IDE, the resilient network poll
  above is what keeps the limits current.

## [1.0.18] — 2026-06-22

### Added

- **Visible "quota offline" marker.** When the 5h/7d limits can't be fetched
  (no internet, a slow/unstable link timing the request out, a missing token, or
  a temporary server throttle), the status bar used to silently drop the
  percentages and show only the local token-equivalent — which read as "the
  limits just vanished". It now shows a clear marker naming the reason
  (`☁ quota offline` / `лимиты офлайн`, `quota paused`, `no token`) **next to**
  the local data, so a connectivity blip is obvious and the bar is never blank.
  An intentionally disabled quota poll stays silent (it's a choice, not a
  failure). The marker never tints the item — a network blip isn't an over-pace
  alarm.
- **Quota failures are now written to the diagnostics log** (`CC Statusbar`
  output channel + `cc-statusbar.log`). Previously only Codex errors were
  logged, so a "limits stopped showing" report couldn't be told apart from a
  real break without manual digging.

## [1.0.17] — 2026-06-16

> **Heads-up: your token numbers will look lower after this update — that is the
> fix, not a regression.** Your actual usage did not change. Earlier versions
> were over-counting, so the bar was showing inflated figures. It now shows the
> real numbers.

### Fixed

- **Token counts were inflated ~2.3–3.3×.** Claude Code writes a single model
  reply to its log as several lines (one per part of the answer — reasoning,
  text, each tool call) and repeats the same usage figures on every line. The
  extension was adding those up per line, so one reply was counted 2–4 times.
  This inflated every absolute number: work tokens, cache read/write,
  token-equivalent, and the "N× cheaper" savings. We now count each reply once
  (deduplicated by its response id). The numbers will drop to their true values.

  Unaffected and unchanged: cache hit-rate (%), context-window fill (%), cache
  tier (1h/5m), and the 5h/7d quota bars — those were already correct.

## [1.0.16] — 2026-06-08

### Added

- **Codex provider support.** The status bar can now show Codex 5h/7d quota,
  context, cached-input usage, and token-equivalent details from the local Codex
  app-server and Codex session history.
- **Provider and language controls in the hover.** Switch between `Auto`,
  `Claude Code`, and `Codex`, plus `Auto` / `RU` / `EN`, without opening VS Code
  Settings.
- **Codex panel view.** Codex uses the same information layout as Claude Code:
  token-equivalent, quota, context, cache, and details. Metrics Codex does not
  expose, such as cache tier and cache write, are shown as unavailable instead of
  guessed.

### Changed

- Renamed the extension display name to **Claude/Codex Usage — Quota & Context
  Statusbar** while keeping the same extension ID (`solux-dev.cc-statusbar`).
- Renamed the cache headline for both Claude Code and Codex to
  **token-equivalent**. Raw token counters are real local data; cache savings use
  the extension's configured cache weights and are not presented as billing.
- Hid technical Codex app-server/socket diagnostics from the user-facing
  hover/panel. Diagnostics are logged to the VS Code output channel and extension
  log instead.

### Fixed

- Codex context and cache now read from local Codex `token_count` history when
  available, so long-running Codex sessions show context/cache after a response
  instead of staying at `n/a`.
- Added regression coverage for workspace paths with spaces, dashes, underscores,
  and dots.

## [1.0.4] — 2026-06-02

### Fixed

- **The status bar now appears for projects whose folder name contains a space**
  (or any non-alphanumeric character — dots, parentheses, etc.). The extension
  locates a project's Claude Code session by reconstructing Claude Code's project
  slug from the workspace path, but the slug builder only collapsed `: \ / _` to
  `-` and **left spaces intact** — so for a folder like `Kasta Rico` it looked in
  `…-Kasta Rico` while Claude Code had written the session to `…-Kasta-Rico`. The
  transcript was never found, so the bar showed only an empty fallback and looked
  broken. The slug now collapses **every** non-alphanumeric character to `-`,
  exactly matching Claude Code's own slug. Folders without such characters are
  unaffected. This hit any path with a space — common on Windows
  (`C:\Users\First Last\…`). Added a regression test.

## [1.0.3] — 2026-06-01

### Fixed

- **Quota & context now survive slow, high-latency links** (VPN tunnels,
  remote/cloud-hosted Claude Code, users on the move). The quota and
  context-window requests used a single attempt with undici's ~10s connect
  timeout, so a route to `api.anthropic.com` that answered in, say, 8–15s would
  intermittently time out — making the **5h / 7d tariff blink in and out** while
  the main agent (which tolerates the latency) kept working. Both requests now
  use a **resilient transport**: a few sequential attempts with **escalating
  per-attempt timeouts** (6s → 14s → 22s) so a healthy link still returns fast
  while a slow link succeeds on a later, more patient attempt. The transport
  **adapts** — it remembers the last successful round-trip and pre-sizes the next
  poll's timeouts to the user's real link speed, so a consistently slow channel
  stops failing its early attempts. Only transient failures (timeouts, `5xx`,
  `429`-aside) are retried; auth errors are not. Worst case is bounded (~42s) and
  still costs at most ~1 token per (already throttled) poll.

### Notes

- This covers **tunnel** VPNs (WireGuard/AmneziaWG/OpenVPN) and direct/no-VPN
  setups, which already routed correctly at the OS layer — the fix adds patience
  for their latency. **Proxy-mode** VPNs (a local SOCKS/HTTP proxy) are a separate
  axis: Node's `fetch` does not honour proxy settings, so that case still needs
  explicit proxy support (tracked separately, as it implies a dependency).

## [1.0.2] — 2026-06-01

Docs/release-plumbing only — no extension code changes.

### Changed

- **Refreshed the README screenshots** to the current v1.0.x UI (cache-tier line,
  informational context dot, quota + context). Cache-busted the image URLs so
  GitHub's image proxy serves the new ones.
- First release published through the **automated pipeline** (tag push → tests →
  Open VSX + GitHub Release).
- Added a `.mailmap` so all authorship shows under the single `Solux-dev`
  identity.

## [1.0.1] — 2026-05-31

### Fixed

- **Panel hover footnotes now follow the editor theme.** They used the OS-native
  `title` tooltip, which renders on a light background regardless of theme and
  was hard to read in dark mode. Replaced with a themeable CSS tooltip using VS
  Code's hover-widget colours, so it's dark in dark themes and light in light
  themes.

### Changed

- **Context-limit failures are now diagnosable.** When the context-window limit
  can't be fetched, the tooltip shows the reason (e.g. `limit n/a — http 403`),
  and a failed lookup is retried within ~a minute instead of 10 — so a transient
  first-fetch glitch (common right after install) self-heals quickly.

## [1.0.0] — 2026-05-31

First stable release. The extension now sells exactly what a Claude Code
subscriber can't get conveniently elsewhere — **5h / 7d quota** and **context
window %** — with cache as a quiet, honest extra.

### Added

- **Cache insight (panel + tooltip).** The session's prompt-cache **tier
  (`1-hour` / `5-minute`) is auto-detected** from the transcript's per-turn
  `cache_creation.ephemeral_{1h,5m}` fields — read from the data, never a
  hardcoded TTL assumption, so it stays correct as Anthropic adjusts caching.
  A concise self-explanatory line shows in the hover tooltip; the panel adds a
  **Cache** section with the tier and a descriptive **input-from-cache %**, each
  with a hover footnote (ⓘ) explaining what it means and how to use it.

### Changed

- **Renamed** to *“Claude Code Usage — Quota & Context Statusbar”* with a
  quota/context-first description (the install URL `solux-dev.cc-statusbar` is
  unchanged). “Cost” is demoted to a quiet extra — for a subscriber, cost means
  quota consumption, not token accounting.
- **Context dot is now purely informational** — 🟢 under 50% · 🟡 50–80% ·
  🔴 80%+, always shown, and it **never** recolours the whole status-bar item
  (the whole-item fill stays reserved for the quota pace). Context is a "room for
  the next step" read, not a quota with consequences.

### Fixed

- **Robust cache-token parsing.** Falls back to the nested
  `cache_creation.ephemeral_{5m,1h}` breakdown when the top-level
  `cache_creation_input_tokens` reports 0 (a Claude Code <v2.1.152 quirk).
- **Subagent turns (`isSidechain`) are excluded** from the main session's
  context and cache stats — they have their own window and 5-minute tier and
  would otherwise confound the numbers.

## [0.4.0] — 2026-05-31

### Added

- **Context-window usage %.** Shows how full the model's context window is right
  now — current input ÷ the model's `max_input_tokens` — so you can tell how big
  a next task can be. This is different from the cost metric (which only grows).
  Appears in the collapsed status bar (`· ctx 47%` / `· конт 47%`, after the
  tariff segments) and as a full `context: 47% (468k / 1M)` line in the tooltip
  and panel. Coloured by fill (≥85% yellow, ≥95% red) — a **fixed threshold**,
  deliberately not the time-based tariff pace.
- The window limit is read once per model from the Anthropic **Models API**
  (`max_input_tokens`), using the same local OAuth token as the quota feature,
  cached 24h. **No hardcoded model→window table** — if the limit can't be
  fetched the % is hidden (never guessed), and a fix is an isolated update.
- Setting `ccStatusbar.context.enabled` (default `true`) to turn the lookup off.

### Changed

- **Panel/tooltip lead with the cost answer.** The breakdown now opens with
  *cost (with cache) · without cache · ~N× cheaper* and demotes the raw
  work/cache numbers to a muted **Details** block — so the value of caching is
  obvious without mental math.
- Token figures drop a trailing `.0` (`1M` not `1.0M`, `468k` not `468.0k`).

## [0.3.1] — 2026-05-31

### Changed

- **Clearer cache savings.** Instead of an abstract “saved vs no-cache” line,
  the tooltip and panel now show the two totals side by side — *without caching
  ≈ X* vs *with caching (effective) ≈ Y → saved ≈ Z* — so the benefit of caching
  is obvious at a glance (RU: «без кэша было бы… / с кэшем…»).
- Removed the unimplemented “pace” line that was documented but never shown
  (the extension does not measure active work time).

## [0.3.0] — 2026-05-30

### Added

- **Persistent usage panel.** A “⤢ Open panel” link in the tooltip (and a
  *“Open usage panel”* command) opens a dockable, **live-updating** panel with
  the full breakdown — so you can keep it open and study it, instead of relying
  on the auto-hiding hover tooltip. Clicking the status-bar item still refreshes.

## [0.2.2] — 2026-05-30

### Added

- **Easy language switching:** a “🌐 Change language / Сменить язык” link at the
  bottom of the hover tooltip, and a **“Claude Code Statusbar: Switch language”**
  command — so the language is discoverable without digging into Settings.

### Changed

- Reworded the pace verdicts for clarity and made the per-window verdict match
  the legend. EN: `on track` / `running tight` / `over pace`. RU: `в норме` /
  `близко к лимиту` / `выше нормы`.

## [0.2.1] — 2026-05-30

### Added

- Extension icon (coral tile with a usage-gauge and a green "on-track" dot).
- Screenshots (English + Russian tooltip) in the README.

## [0.2.0] — 2026-05-30

### Added

- **English + Russian localization** of the whole runtime UI (status bar +
  hover tooltip). New setting `ccStatusbar.language`: `auto` (follow the
  editor's display language, default), `en`, or `ru`. Command titles localized
  via `package.nls`.
- **Glossary** ("what you see", EN + RU) in the README, plus plainer
  pace-verdict wording (`on track` / `cutting it close` / `spending faster than
  the limit`; RU `в норме` / `впритык` / `опережение`).

### Changed

- README is now English-first; the Reliability section is in English.
- `fmtRemaining` and `paceLevel` take language into account (pure functions;
  unit-tested in both languages).

## [0.1.0] — 2026-05-30

Initial release.

### Added

- Status-bar item with a **tariff-only collapsed view**: per-window colored dot
  (🟢 в норме / 🟡 впритык / 🔴 опережение) + `5ч` / `7д` usage % + time-to-reset.
- **Real 5h / 7d subscription quota** (Claude.ai Pro/Max/Team) via Anthropic
  rate-limit response headers, throttled (≤ once per `quota.minPollSeconds`,
  default 300s) and activity-gated; can be disabled.
- **Hover tooltip** with the analytical breakdown:
  `работа (вход+выход)` + `на кэш (в эфф.)` = `эффективно`, plus cache
  read/write and estimated savings.
- `effective = work + 0.1·cache_read + 1.25·cache_write` — cache-weighted
  comparable consumption, computed from the local session transcript
  (+ subagents), matching the project's `session-cost.py`.
- Whole-item background turns yellow/red when the burn pace risks exceeding a
  window.
- Settings under `ccStatusbar.*` (refresh interval, weights, quota toggle,
  poll throttle, credentials path, alignment).
- Graceful degradation: if the quota channel fails, local metrics keep working
  and only the tariff line is hidden.

### Notes

- The 5h/7d quota uses an undocumented Anthropic channel — see README
  "Reliability". Local token/effective/cache metrics are unaffected by such
  changes.
