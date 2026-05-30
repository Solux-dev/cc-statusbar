# Roadmap idea — "Session efficiency" (post-MVP)

Status: **captured, not scheduled.** MVP shipped 2026-05-31 (v0.3.1; 0.4.0 =
context % next). Revisit after real usage / user feedback (GitHub issues).

## The problem with the current numbers

Cost / cache-savings are a one-time "aha" — after 2-3 sessions they're static
and boring. The owner's insight (2026-05-31): the plugin should give **ongoing
feedback**, not just info — a metric that changes per session and tells the user
**how well they worked and where they lost money**.

## The value direction: efficiency + an explanation engine

Don't just show a number that varies — **explain why it varied**. Everything
needed is already in the transcript the plugin reads.

- **Cost per active hour** (cross-session KPI): effective tokens ÷ active work
  time. Comparable across sessions. (Needs an *approximate* active-time
  estimate = wall-clock − idle gaps. This is why "pace" was removed from MVP —
  here we'd build the estimator.)
- **Cache hit rate** (the money indicator): `cache_read / (cache_read +
  fresh_input + cache_creation)`. High = efficient reuse (cheap); low = lots of
  fresh re-reads (expensive). Computable per session.
- **Idle gaps** (the explanation): transcript entries carry `timestamp`. Gaps
  > ~5 min → cache cools down → context re-read → more expensive. The plugin can
  say "25% of this session was idle >5 min, cache likely expired" — i.e. it
  auto-produces the diagnosis the user would otherwise ask a human for.

Combo = "you worked efficiently / here you lost money, and here's why" — stays
useful every session, doesn't go stale.

## Why this matters for PUBLIC users specifically

We (Dashboard methodology) already have this via `session-cost.py` /
`cost-trend.py` / `session-costs.jsonl` / the active-time backlog. But public
users who just install the plugin have none of that tooling — for them the
plugin would be the *only* way to see their own efficiency. That's the real
"useful to others" payoff.

## Cross-session storage — concurrency-safe design (owner concern 2026-05-31)

Cross-session trends need to persist a few numbers per session. Earlier idea (a
single appended `sessions.jsonl`) is **rejected** — it races if two parallel
chats finish at once. Final design:

- **One tiny file per session**, named by **session id** (unique):
  `~/.cc-statusbar/sessions/<sessionId>.json` (~4-5 numbers: date, effective,
  active-min, eff/hour, cache-hit-rate). Two parallel chats = two different
  files → **collision impossible by construction**, no locking needed.
- **Atomic write** (temp file + rename) per file.
- **Keep last N** (e.g. 50-100): prune oldest on write → bounded file count
  (addresses the owner's earlier "files pile up over months" concern).
- Trend view reads the folder and aggregates. Losing one record in the rare
  simultaneous-finish case is acceptable (nice-to-have metric, not critical).
- **NOT** in the user's project repo (no clutter, no git noise) — home dir only.

## MVP boundary

Out of scope for now. Implement only after the context-% (0.4.0) lands and we
have real-world signal on what users actually want.
