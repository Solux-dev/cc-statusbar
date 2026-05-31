# Research findings — 2026-05-31

Four parallel research agents ran against: (1) comparable plugins, (2) community
pain points, (3) prompt-cache technical ground truth, (4) audit of the data we
already collect. This file is the consolidated, citeable result. Read together
with [`product-direction.md`](product-direction.md) (the resume note that
commissioned this research).

---

## TL;DR

- **Our core thesis holds.** "Quota remaining + context %" is exactly what the
  field sells and what users beg for. The competitive gap is real: almost **no
  VS Code extension combines both well** — quota-only extensions skip context%,
  and the context%-rich tools are terminal statusline scripts, not VS Code
  extensions. We sit in that gap.
- **Two cheap, high-value polish items we may be missing:** (a) color-coded
  threshold warning on context% *before* auto-compact (the single most-praised
  feature in the whole field), and (b) reset countdown next to quota. Verify our
  current build against these.
- **"Efficiency scoring" has no organic demand.** Every "rate my habits" result
  was vendor marketing. What users actually want is **prediction** ("how far
  will I get before the limit?"), which lives under quota, not a report card.
- **Cache-coaching as *advice* is not honestly shippable** from our data. The
  one honest cache number is a descriptive **cache-hit-rate** ("78% of input
  came from cache"). "You wasted cache / re-cached after idle" is confounded.
- **TTL correction (important):** subscription (Pro/Max) Claude Code uses the
  **1-hour** cache TTL automatically; only API-key usage defaults to 5 minutes.
  Our earlier "pause >5 min cools the cache" note was wrong for our actual
  audience (subscribers). See §3.

---

## 1. Competitive landscape — CONFIRMS the thesis

Surveyed ~14 tools (Claude Code statuslines, VS Code Marketplace extensions,
Copilot/Cursor usage trackers).

**Patterns:**
- **Quota-remaining is the most-sold headline** across the whole field
  (ClaudeProUsage, Claude Usage Bar, Claude Code Usage Status, Copilot Usage
  Tracker all lead with it).
- **Context % is the most-*praised* feature** — every serious Claude statusline
  shows it (daniel3303 512★, Claudemeter 2.6k installs, ohugonnot, claudeline).
  The "warn me before auto-compact" behavior is the emotional hook.
- **Cost is sold loudly but bundled/secondary, and it's the fragile axis.**
  `cursor-stats` (264★) was **archived** explicitly because pricing churn made
  cost-tracking unmaintainable. → Validates our decision to keep the
  cost/cache block quiet and optional.
- **Scope discipline is valued.** The disciplined tools (daniel3303 explicitly
  excludes cost; claudeline = "minimalistic") out-traction the kitchen-sink
  ones (Clusage 6-section dashboard; rajbos adds CO₂/water "fluency").

**Gap we should close (verify against current build):**
1. **Color-coded escalating warning on context% near the compact threshold
   (~80–85%)** — not just a flat number. Highest-value, lowest-risk item found.
2. **Reset countdown next to quota** (`🕐1h23m`) — near-universal; users want
   "when does it reset," not only "% used."

Native VS Code status-bar usage is an explicitly requested, under-served niche
(Claude Code issue #33819, #38791).

## 2. Community pain — what's real and broad

Ranked by signal strength (GitHub issues + Hacker News carried the strongest,
datable quotes; Reddit under-indexed by the search engine).

| Pain | Real? | Broad/niche | Served by |
|---|---|---|---|
| #1 Quota opacity — "no idea how much is left / where it went" | strong | **broad** | quota (A) |
| #2 Context fills silently → surprise auto-compact | strong | **broad** | context% (A) |
| #3 Idle → cache evaporates → quota/cost spike | strong, recent | felt broadly, **understood by almost no one** | cache (B) — our sharpest wedge |
| #4 "Want this *in VS Code*" | real | broad (our exact audience) | form factor |
| #5 Caching "am I paying twice?" | partly | niche/educational | cache (B) |
| Efficiency scoring / "rate my habits" | **not a felt pain** | niche, manager-facing | — don't lead with it |

Notable extra pains we likely **cannot** serve from local transcripts alone, and
must not over-claim: authoritative quota % (Anthropic's accounting is opaque and
lags — label estimates as estimates), phantom/zombie-token usage (#41084,
server-side), and cross-machine/web usage (local files under-count).

Standout quote for #3: a 45-min pause on a ~900k-token Opus context consumed
~20% of the 5-hour window for a single small prompt vs <1% during continuous
activity (issue #51218). This is the costly, invisible, almost-nobody-gets-it
pain — but see §3 for why coaching on it is hard.

## 3. Prompt-cache ground truth (technically verified)

Sources: official Anthropic platform docs + Claude Code prompt-caching docs.

- **TTL:** two ephemeral lifetimes — **5 min** (API default) and **1 hour**
  (opt-in). **Claude Code on a Pro/Max subscription requests the 1-hour TTL
  automatically** (costs nothing extra under a subscription). API-key/Bedrock/
  Vertex usage defaults to 5 min. Subagents always use 5 min. Each cache hit
  *resets* the TTL (it's an idle tolerance, not an absolute lifetime).
  → **Correction to the prior note:** for our audience (subscribers) the idle
  threshold is ~1h, not 5 min.
- **Pricing multipliers (confirmed):** fresh input ×1.0; cache *write* ×1.25
  (5m) / ×2.0 (1h); cache *read* ×0.1. 5m write pays off after 1 read, 1h write
  after 2 reads.
- **Idle→re-cache is REAL but heavily CONFOUNDED.** A `cache_creation` spike
  also occurs with **no idle at all** from: switching model (incl. opusplan
  Opus↔Sonnet), changing effort, MCP connect/disconnect (often automatic, not
  the user's fault), denying a tool, `/compact`, Claude Code upgrade, and just
  normal context growth (every healthy turn writes the new exchange). So a spike
  ≠ "you idled and wasted money."
- **Honest signal requires all three at once:** (a) `cache_read` collapses vs
  recent baseline, (b) `cache_creation` spikes above per-turn norm, (c) a
  wall-clock gap precedes the turn — and even then phrase it as "cache likely
  expired (TTL-dependent), or you changed model/effort/MCP," never as blame.
- **Best practices we *can* honestly teach:** stable content first / volatile
  last; pick model + effort + MCP servers at the top of a session; save
  `/compact` for task boundaries; minimum cacheable prefix ≈4,096 tokens
  (Opus/Haiku 4.5) — below it nothing caches.

## 4. Audit of data we already collect

(Full inventory in the agent's notes; key conclusions here.)

**Universal bedrock (good for everyone):** 5h/7d quota % + reset, context window
%, and the **raw** `input` / `output` / `cache_read` / `cache_write` token
counts.

**Methodology-specific (owner's accounting, not portable):** the weighted
`effective` number and everything derived from it — `noCache`, `saved`,
"N× cheaper." The weights (×0.1 / ×1.25) are the owner's `session-cost.py`
convention, **not** Anthropic's real prices; a general user can't verify
"6.8× cheaper" against a bill. Keep quiet/optional, do not promote as universal.

**We do NOT currently parse per-message `timestamp`** — only the transcript file
mtime (one global "last active" instant). Any idle-gap feature needs us to start
reading `obj.timestamp`.

**Derived insights, ranked:**

- TIER 1 — correct, broadly useful, needs **no** new data:
  1. **Cache-hit-rate** = `cacheRead / (cacheRead + cacheWrite + input)` —
     descriptive "share of input served from cache," weight-free, honest.
     (Don't call it "savings %".)
  2. **Context headroom** — "320k free / 1M" instead of only "% full."
  3. **Context-near-full nudge** — reuse existing ≥85/≥95 thresholds as an
     explicit "consider /compact" hint.
- TIER 2 — useful but needs new data:
  4. Idle-gap detection — needs per-message timestamps; present descriptively,
     **not** as coaching.
  5. Usage-per-active-hour — needs timestamps; use raw `work`, not `effective`.
  6. Session-to-session comparison — needs an opt-in persistence layer (already
     flagged opt-in/default-off in commit `d4b70dc`); compare normalized %, not
     absolute tokens.
- TIER 3 — REJECTED as confounded/misleading:
  7. "Cache underused" warning — a low read/write ratio is *normal* early in a
     session; can't distinguish waste from warm-up. Reject.
  8. "N× cheaper" as a headline cost figure — arbitrary weights, not real prices.
  9. Per-message effort/thinking breakdown — not recorded in the transcript.

**Cache-coaching verdict:** "you re-cached after idle" is only *partially*
detectable (even with timestamps added) and stays confounded; "cache not fully
used" has no honest denominator. The shippable, honest cache feature is the
**descriptive cache-hit-rate (#1)**, not advice.

---

## Recommendation for the decision

Lean **option 1 (head to a clean v1.0)**, but fold in the validated, honest,
broadly-useful items the research surfaced — none of which require the shelved
"efficiency engine":

1. **Context%: escalating color warning + reset countdown** — close the
   competitive gap; highest praise / lowest risk. *(Verify what we already do.)*
2. **Cache-hit-rate as a quiet, honest panel stat** — one weight-free number.
3. **Re-frame quota toward prediction** ("~Xh of work left at this pace") — this
   is the demand the pain research actually found, and it's under quota, not a
   report card.

Explicitly **do not** build: efficiency scoring, "cache underused" warnings, or
idle→re-cache *coaching* (confounded). Idle-gap, per-active-hour, and
cross-session trend stay shelved/opt-in as before.

---

## ADDENDUM — deep cache-TTL verification (triangulated, owner-requested)

A second research round (4 agents + a local check on the owner's real
transcripts) was run because building on a single-source TTL claim was a risk.
Result: the claim is **directionally correct but needed three corrections**, and
the safe engineering conclusion is to **stop assuming TTL and read it from the
data**.

### Verified facts (multi-source)

- **TTL is keyed on billing state, not plan name.** Official Claude Code docs:
  on a subscription with usage *included in the plan*, Claude Code requests the
  **1-hour** TTL automatically; on API key / Bedrock / Vertex / Foundry (paid
  per-token) it stays at **5-minute** default. (One page,
  code.claude.com/docs/en/prompt-caching, is the sole authority; corroborated by
  pricing docs + support articles.)
- **Pro, Max = 1h (CONFIRMED). API/Bedrock/Vertex/Foundry = 5m (CONFIRMED).**
  Team (Premium seats) & seat-based Enterprise = 1h (INFERRED — billing is
  "included"). **Usage-based / self-serve Enterprise bills at API rates → likely
  5m, UNCONFIRMED.** Subagents = always 5m (CONFIRMED). Spillover into Extra
  Usage credits → drops to 5m (CONFIRMED).
- **Correction 1 — overage gate (Anthropic statement, May 8 2026):** 1h on the
  main loop applies **only while the seat is within its included allowance**.
  Cross into Extra Usage → the client deliberately picks 5m across the board. So
  "subscription = 1h" is *false* in overage. Design, not bug.
- **Correction 2 — there was a real regression.** From ~Mar 6 to early May 2026,
  the 1h TTL was silently downgraded to 5m. Corroborated by 4 independent
  transcript datasets (119k calls; 95-day scan; 1,140 sessions; ccusage ~40k
  records) **and** officially fixed: Claude Code changelog **v2.1.129 (May 6
  2026): "Fixed 1-hour prompt cache TTL being silently downgraded to 5 minutes."**
  This resolves the issue #51218 "45-min pause cost 20%" contradiction — it
  happened *during* the 5m-regression window (× 1M-context premium), so it was
  evidence *for* the regression, not against 1h.
- **Correction 3 — reporting bug.** Changelog **v2.1.152 (May 27 2026)** fixed
  `cache_creation_input_tokens` (the top-level field **we currently read**)
  reporting **0** when the API only populates the nested `cache_creation`
  breakdown. → We must read the **nested** `ephemeral_5m/1h` fields, not the
  top-level sum.

### Local ground truth (owner's own transcript, 2026-05-31, v2.1.158)

Verified directly, post-fix:
- `cache_creation: { ephemeral_1h_input_tokens: 4812, ephemeral_5m_input_tokens: 0 }`
  → **this subscription is writing to the 1-hour tier right now.** First-hand
  post-fix confirmation (which no public source had).
- `service_tier: "standard"`, `isSidechain` (bool), `timestamp` (ISO),
  `version`, `iterations[]`, `speed`, `server_tool_use` — **all present** in real
  data. (Previously UNCONFIRMED.)

### Decisive engineering conclusion

**Do NOT hardcode any "subscription = 1h" assumption.** Read the per-turn nested
`cache_creation.ephemeral_5m_input_tokens` vs `ephemeral_1h_input_tokens` and let
the transcript tell us the actual tier. This is volatility-proof: it is correct
across the regression, the overage→5m drop, plan ambiguity, and subagents — no
assumption to be wrong about. (This is exactly what the best community tool,
claude-code-usage-bar, does.)

### Latent issues — verified against real data (owner's transcript) and resolved

All three were checked empirically before touching code (53 assistant turns,
v2.1.158). The check **downgraded all three from "active bug" to "2 defensive
hardenings + 1 non-issue"** — verifying first paid off.

1. **Top-level `cache_creation_input_tokens` could be 0 on <v2.1.152.** Not
   present in current data (0/53), but real for older/other-user transcripts.
   **FIXED defensively:** added `cacheWriteTokens()` helper that falls back to
   the nested `ephemeral_5m+1h` sum when the top-level field is 0; used in both
   `sumTranscript` and `lastAssistantContext`. (`metrics.ts`)
2. **`isSidechain` not filtered.** Not manifesting in our version (subagents
   live in a separate `subagents/agent-*.jsonl` dir, so the main file has 0
   sidechain lines), but a silent Claude Code change could inline them.
   **FIXED defensively:** `if (obj.isSidechain) continue;` guard added to both
   functions — makes the "main-only context" invariant explicit instead of
   relying on the separate-file assumption. (`metrics.ts`)
3. **`input_tokens` allegedly ~75% placeholder 0/1 (ccusage #866).** **NOT
   reproduced** — 0/53 lines had a 0/1 placeholder; all carried real values.
   **No code change** — fixing on an unverified external claim would have been
   wrong. (Re-check only if a future version regresses.)

Coverage: 4 unit tests added for the two fixes; full suite 35/35 green.

### Decision on further research

**Stopped here deliberately.** The TTL question has converged across official
docs + changelog + 4 independent transcript datasets + Anthropic engineer
statements + first-hand local verification. More agents would be re-confirmation,
not new signal. The remaining UNCONFIRMED item (usage-based Enterprise TTL) is
un-testable without an enterprise credential and is moot under the auto-detect
design.
