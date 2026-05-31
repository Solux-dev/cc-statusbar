# Design spec — honest cache insight (cache tier + hit rate)

Status: **IMPLEMENTED** (2026-05-31), shipping as part of v1.0. Verified
end-to-end against the owner's real transcript (tier `1h`, hit-rate `95%`).
Grounded in
[`research-2026-05-31-findings.md`](research-2026-05-31-findings.md) — read its
ADDENDUM first; this spec assumes those verified facts.

## Goal (one sentence)

Surface the **one cache signal that is both honest and broadly useful** —
*which cache tier this session is actually on (1-hour vs 5-minute) and how much
of the input is being served from cache* — so a user understands their real
idle-tolerance and whether caching is working, without us inventing a score.

## Why this and not the rest

The research killed the tempting-but-wrong options and left a narrow honest core:

- ✅ **Cache tier (auto-detected per turn).** Directly answers the most
  differentiated, least-understood pain (the Mar–May 2026 1h→5m regression
  anxiety: *"am I silently on 5-minute cache?"*). We read it from the data, so
  it's always correct — no hardcoded assumption to be wrong about. **Nobody else
  surfaces this in a VS Code status bar.**
- ✅ **Cache hit rate**, framed *descriptively* ("82% of input served from
  cache"), weight-free. Honest "is caching working" glance.
- ❌ **NOT** an efficiency score, "you wasted cache" warning, or idle→re-cache
  coaching — all confounded (a low ratio is normal early in a session; a
  cache_creation spike has ≥8 non-idle causes). The research is explicit.
- ❌ **NOT** promoted to the collapsed status bar. The bar stays the universal
  headline = **quota + context %**. Cache lives in the **tooltip/panel** as a
  quiet extra, consistent with the existing cost-block demotion.

## What we show, and where

**Collapsed status bar:** unchanged (quota dots + context %). No cache.

**Tooltip + panel — extend the existing cache/cost block** with two lines:

```
Cache: 1-hour tier · 82% of input from cache
```
ru:
```
Кэш: часовой тир · 82% ввода из кэша
```

- **Tier label:** `1-hour` / `5-minute`, from auto-detection (below). When it
  can't be determined (no cache-write turn yet), show nothing for tier — never
  guess.
- **Hit-rate:** descriptive percentage; phrase is "of input from cache", never
  "savings" or a grade.

Optional (behind the same quiet block, only if the tier is **5-minute**): a
single neutral, factual note — *"short breaks (>5 min) will rebuild the cache."*
No blame, no "you wasted" language. This is the only borderline-coaching line and
it is **factual** (the 5m TTL is real), not a verdict. Owner may cut it.

## Data & detection (all fields already verified present)

Per main-session assistant turn (exclude `isSidechain` — already done):

- **Tier of a turn** = whichever of `usage.cache_creation.ephemeral_1h_input_tokens`
  / `ephemeral_5m_input_tokens` is non-zero (confirmed: only one is non-zero per
  write turn). Turns with no cache write contribute no tier signal.
- **Session current tier** = the tier of the **most recent** main turn that had a
  cache write. Rationale: a session can legitimately change tier mid-way (within
  allowance = 1h → cross into overage = 5m), and "what am I on *now*" is the
  useful answer. If the last N write-turns disagree, current-tier still wins
  (simple, truthful); we may add a "(was 1h earlier)" note later only if real use
  shows it matters — not now.
- **Hit rate** = `cacheRead / (cacheRead + cacheWrite + input)` over the session
  (main only), using the robust `cacheWriteTokens()` for the write term. Range
  0–100%. Label descriptively.

Edge cases:
- Nested object missing (very old transcript) → tier unknown, hit-rate still
  computable from top-level fields.
- `input` term uses raw `input_tokens`; acceptable for a ratio (placeholder-0
  issue not reproduced in our data — see research §ADDENDUM #3).
- Division by zero (no tokens yet) → hide the cache block entirely.

## Non-goals (explicit, to prevent scope creep)

- No persistence / cross-session trend (stays opt-in/shelved per existing
  roadmap).
- No idle-gap detection or per-active-hour (needs timestamps; out of scope here).
- No change to the cost/`effective`/`N× cheaper` block — it stays as the
  methodology-specific quiet extra it already is.
- No collapsed-bar change.

## Test plan

Pure-logic unit tests (mirroring the existing suite):
1. Tier detection: last write-turn 1h → "1-hour"; last write-turn 5m →
   "5-minute"; mixed (1h then 5m) → "5-minute"; no write turn → unknown.
2. `isSidechain` write-turns ignored for tier + hit-rate.
3. Hit-rate formula incl. nested-fallback write term; zero-token → block hidden.
4. Render: tier + hit-rate line present in tooltip & panel, both en/ru; absent
   when unknown. Bar unchanged (regression check on existing bar tests).

## Open questions for the owner

1. Keep or cut the optional "short breaks rebuild the cache" note for the 5m
   tier? (Factual, but it's the one line that edges toward guidance.)
2. Hit-rate: show always, or only in the panel (not the hover tooltip) to keep
   the tooltip minimal?
3. Ship as **v0.5.0** (a feature bump) or fold into the **v1.0** polish pass
   together with the context-warning + reset-countdown items the competitive
   research flagged?
