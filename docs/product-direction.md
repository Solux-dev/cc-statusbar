# Product direction & next-session notes

Session: 2026-05-31 (after v0.4.0 was committed & pushed; not yet published to
Marketplace — owner publishes manually).

This file is the **resume point** for the next cc-statusbar session. Read it
first.

---

## Decision this session: stop piling features, focus on the real value

After designing a "session-efficiency engine" (cache-hit-rate + idle-gap
diagnosis + cost-per-active-hour + cross-session trend), we stepped back and
concluded we were over-building. The decision:

### 1. The product IS the status bar: **5h/7d quota remaining + context %**

That is the one thing a Claude Code subscriber genuinely can't get as
conveniently elsewhere, shown passively at the right moment with colour coding.
It passes the test "does one useful thing the user can't easily get otherwise."
**It is already shipped (v0.4.0).** We are closer to a clean **v1.0** than to
needing a v0.5.0.

### 2. The internal cost / effective-tokens / cache-savings block is demoted

Reasoning (the key insight): **for a subscriber, "cost" means quota
consumption, not token accounting.** A flat subscription doesn't turn tokens
into dollars, so "effective tokens" and "~6.8× cache savings" are largely a
one-time curiosity — and they were really useful to *the owner's Dashboard
methodology* (which counts tokens via `session-cost.py`), not to a general
user.

- Keep the cost/cache block as a **quiet optional extra** in the tooltip/panel
  (it's already written — don't throw it away).
- Do **not** make it the headline. Consider hiding it behind a setting later.

### 3. The "efficiency engine" is **shelved** (not killed)

Two independent reasons:

- **The metrics are confounded** (established while designing them): a high
  `eff/active-hour` or a low cache-hit-rate can mean *either* "worked hard /
  explored new code" (fine) *or* "wasted money on re-reads" (bad) — the number
  alone can't tell which. Building a "you did well / badly" verdict on an
  ambiguous metric would mislead users.
- **Demand is unvalidated.** Revisit only if real users ask — and a brand-new,
  undiscovered GitHub project may get no signal for months, which is itself a
  reason not to force the feature.

The only *unambiguous* waste signal we found is **idle gap → context re-cache**
(a >5 min pause lets the prompt cache cool, so the next turn re-pays to rebuild
context as cache-write ×1.25 instead of cache-read ×0.1). If we ever revisit,
that is the one signal worth surfacing — but verify the real cache TTL first
(the transcript's `cache_creation` field may show 5m vs 1h ephemeral cache;
don't hardcode "5 minutes").

---

## Next session: research before building anything

Do NOT write code next session until we've answered the research questions
below. The goal is to decide whether there's a *legitimate, broadly useful*
direction — not to ship more internal metrics.

### Research task 1 — what comparable plugins do

Look at existing VS Code / Claude Code / Copilot "usage / status / cost"
extensions and statusline scripts. For each note: what they put front-and-centre
in the README, what single value they sell, what they deliberately leave out,
and where they over-complicated (and apparently regretted it). Goal: confirm or
challenge our "quota + context is the product" thesis with how the field
actually behaves.

### Research task 2 — the cache-coaching angle (owner's idea, worth pursuing)

Owner's insight (2026-05-31): the genuinely useful direction may not be "show me
my efficiency number" but **"teach me how to work with the cache correctly."**
Many users (the owner included, until recently) don't understand how the prompt
cache works or how to avoid paying for it twice. That is education/guidance, and
it's potentially useful to *everyone*, not just the owner's methodology.

The hard question to answer with real data before committing:

> Can we actually surface data from the transcript that **explains to the user
> what they're doing right vs wrong with the cache, and concretely where they
> could have saved tokens** — in a way that's correct, not misleading?

Sub-questions to investigate against real transcripts:

- Is the idle→re-cache event reliably detectable? (Look for cache_read dropping
  + cache_creation spiking after a timestamp gap, across several real sessions.)
- What is the actual cache TTL Claude Code uses? (Inspect `cache_creation`
  ephemeral 5m/1h breakdown — already present in `usage`, unused today.)
- Can we phrase guidance that is *true* and *actionable* ("you lost ~N tokens to
  M idle gaps; compact or wrap up before stepping away") without the confound
  problem? The idle-recache signal may be clean enough; the rate metrics are
  not.
- What other unused `usage` fields exist and could legitimately help:
  `service_tier`, `speed`, `iterations`, `cache_creation` breakdown.

### Decision to make next session (on a fresh head)

1. Is the plugin effectively **done → polish + document → v1.0**? (Harden the
   quota/context features — especially the v0.4.0 context % which depends on the
   Models API — and make the README sell exactly that value.)
2. Or is there a *validated* cache-coaching feature worth building, grounded in
   the research above?

Default leaning: **option 1 (head toward a clean v1.0)** unless research task 2
produces a genuinely correct, actionable, broadly-useful signal.

---

## Release status reminder

- v0.4.0: code committed + pushed to GitHub (`f7f6835`). Marketplace publish =
  owner does it manually (`cc-statusbar-0.4.0.vsix` already built).
- Git tags lag (only `v0.2.0` exists; 0.3.x / 0.4.0 untagged) — optionally tag
  `v0.4.0` for a complete release history.
