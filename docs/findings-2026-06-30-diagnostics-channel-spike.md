# Findings — `diagnostics_channel` quota interception spike (2026-06-30)

**Verdict: NO-GO.** Do not adopt the competitor's `diagnostics_channel` approach
to read 5h/7d quota. Keep our existing two-source design
([`src/quota.ts`](../src/quota.ts) network poll + [`src/localQuota.ts`](../src/localQuota.ts)
passive statusLine bridge).

## Context

A competitor — **Claude Usage Bar** (HarshAgarwal1012, marketplace v0.3.5,
macOS-only, closed source) — markets a "zero network footprint" quota reader.
Per its marketplace page it uses **three** mechanisms:

1. **Primary** — Node.js `diagnostics_channel` to passively observe HTTP traffic
   and read the response when Claude Code itself calls `/api/oauth/usage`.
2. **Bootstrap** — a one-shot API call on activation, OAuth token from the
   **macOS Keychain** (this is the macOS lock, not `diagnostics_channel`).
3. **Fallback** — a `statusLine` script writes quota to
   `~/.claude/usage-bar-data.json`, which the extension watches. (This is the
   same idea as our [`src/localQuota.ts`](../src/localQuota.ts) bridge.)

An external review (Gemini) read **our public repo**, did not find any mention of
our passive zero-network source (it was undocumented at the time — fixed in
commit that documents dual-source quota), and concluded the competitor was
"better" at quota. Root cause was a **documentation gap**, not a product gap.
The remaining open question was whether the competitor's *primary* mechanism
(`diagnostics_channel`) was worth adopting as an **additional** source.

## What the spike checked

Whether our VS Code extension could, in the shared extension-host process,
passively read the official Claude Code extension's quota via
`diagnostics_channel` — **on Windows** (the competitor is macOS-only).

Method: static analysis of the **installed** official extension bundle
`~/.vscode/extensions/anthropic.claude-code-2.1.195-win32-x64/extension.js`
(2.2 MB, minified), cross-checked against Node/undici diagnostics_channel docs.

## Evidence (verified)

1. **The usage request is made in-process** (extension host), not in a child
   process — so it is architecturally observable:
   ```js
   let n = `${BASE_API_URL}/api/oauth/usage`;          // BASE_API_URL = https://api.anthropic.com
   let s = await eo.get(n, { headers: {...}, timeout: 5000 });
   return $Ze(s.data);
   ```
   (The agent **conversation** is spawned as a child process —
   `spawn(executable, ... pathToClaudeCodeExecutable)` — and is NOT observable,
   but it is irrelevant to quota.)

2. **The HTTP client is axios** (`eo = sn`, with `sn.HttpStatusCode`,
   `sn.default = sn` — axios signature). The bundle has **0** occurrences of
   `undici`, `node:http`, or `diagnostics_channel`. axios's Node adapter uses the
   core `http`/`https` modules.

3. **Quota is read from the response BODY** (`$Ze(s.data)`), not from headers.

4. **Node core `http`/`https` exposes only two diagnostics channels** —
   `http.client.request.start` and `http.client.response.finish` — and **neither
   exposes the response body**. Rich body channels
   (`undici:request:bodyChunkReceived`, `undici:request:trailers`) exist **only
   for undici**, which this request does not use.
   Sources: [Node diagnostics_channel](https://nodejs.org/api/diagnostics_channel.html),
   [undici DiagnosticsChannel](https://github.com/nodejs/undici/blob/main/docs/docs/api/DiagnosticsChannel.md).

## Why NO-GO

- To passively read the **body** of an axios (Node `http`) response via
  `diagnostics_channel` is **not supported** — it would require tee-ing the
  response stream or monkey-patching the official extension's HTTP client.
  Invasive, fragile, and coupled to undocumented internals (the endpoint, the
  axios adapter, the body schema, and both extensions sharing the host) — any of
  which can change without notice.
- Even if it worked, it covers **only** users running Claude Code as the VS Code
  extension. Terminal CLI users (a large share) get nothing — and for them we
  already provide the statusLine bridge + network poll, cross-platform.
- We already deliver the same real server data via two robust, cross-platform
  sources. Marginal benefit ≈ real-time + zero-setup for the in-editor subset
  who also haven't wired the bridge — and even they already get the network
  poll. Cost/fragility outweighs it.

## On-disk cache alternative — CHECKED, disproven (2026-06-30)

Hypothesis: the official extension fetches `/api/oauth/usage` and parses the
body, so maybe it **caches that quota to disk** — which we could read passively
for a true **zero-network + zero-setup** source. Checked on this machine
(VS Code, official extension 2.1.195). **It does not.**

Evidence (all local):

- `anthropic.claude-code` has **no `globalStorage` directory** of its own
  (`AppData/Roaming/Code/User/globalStorage/` contains only `solux-dev.cc-statusbar`
  — ours). It uses `globalState` in the shared `state.vscdb`.
- The shared `state.vscdb` contains **no quota keys** — no `utilization`,
  `five_hour`, `used_percentage`, `resetsAt`, `rateLimit`, `monthlyLimit`, or
  `sevenDaySonnet`. The `claude-code` strings present there are webview/walkthrough
  state and **Copilot Chat** model-registry entries, not quota.
- `~/.claude` has no `*usage*/*quota*/*limit*` file and no JSON carrying quota
  fields (other than our own bridge `.cc-statusbar-quota.json`).

The `fetchUtilization` result (`$Ze(s.data)`) is consumed **in memory**
(UI/webview) and, when a statusLine hook is configured, pushed to it via
**stdin** — exactly the path our companion `statusline.py` already taps.

## Conclusion — our two-source design is the optimum, not a compromise

Real 5h/7d quota **cannot** be obtained "zero-network + zero-setup". There are
exactly two physically available paths, and we already use both:

1. **Network call** → our poll ([`src/quota.ts`](../src/quota.ts)) — zero-setup.
2. **statusLine hook** → our bridge ([`src/localQuota.ts`](../src/localQuota.ts))
   — zero-network.

No third path exists: interception (`diagnostics_channel`) can't reach the
response body, and there is no on-disk quota cache to read. We are not behind the
competitor — we cover the same two physically possible paths, cross-platform.

## SUPERSEDED in part — an on-disk quota cache DOES exist now (2026-07-26)

The conclusion above ("no on-disk quota cache to read", "no third path exists")
is **no longer true**. It was correct for what it checked, and it checked the
wrong file: the 2026-06-30 sweep looked at the VS Code extension's storage and at
`~/.claude/**` — but **not at `~/.claude.json`**, the CLI's own state file.

Found while adding per-model (Fable) weekly limits, against Claude Code
**2.1.218** (static analysis of `claude.exe` + the live file on this machine):

- `~/.claude.json` carries **`cachedUsageUtilization`** = `{fetchedAtMs,
  accountUuid, utilization}` — the **body of the CLI's own
  `GET /api/oauth/usage`**, persisted verbatim.
- `utilization` holds `five_hour`, `seven_day`, `seven_day_opus`,
  `seven_day_sonnet`, `seven_day_oauth_apps`, `extra_usage`, `spend`, **and a
  `limits[]` array** whose `kind: "weekly_scoped"` rows are per-model weekly
  windows (`scope.model.display_name`, `percent`, `resets_at`). Those rows are
  what the CLI's `/usage` view renders as *"Current week (Fable)"*.
- Write throttle `300_000 ms`; the CLI itself distrusts the cache past
  `3_600_000 ms`. It is refilled when the CLI **fetches usage** (the `/usage`
  view, credit flows) — **not on a timer**, so it can be hours stale.

What this changes:

1. **A third source now exists and is implemented** for the per-model windows —
   [`src/scopedQuota.ts`](../src/scopedQuota.ts). Zero-network, zero-setup,
   zero-token, cross-platform. It is the ONLY path to the Fable number: the
   `anthropic-ratelimit-unified-*` headers carry just the `5h`/`7d` claims, and
   the statusLine payload is built from `five_hour` + `seven_day` only (verified
   in the binary — no `model_scoped` there).
2. **The 5h/7d claim above is weaker than stated.** The same cache carries
   `five_hour`/`seven_day` too, so a zero-network + zero-setup reading of them is
   possible — just not a *fresh* one. Our two live sources remain the right
   primary path; this is a fallback, not a replacement.

Open, and now the better lead than anything in this document: **fetch
`GET https://api.anthropic.com/api/oauth/usage` ourselves** with the OAuth token
we already read. One GET, **zero tokens** (versus the ~1-token POST we send
today), and it returns every window at once — 5h, 7d, Opus, Sonnet, Fable,
credits — always fresh. That would make the scoped rows live instead of
as-of-last-CLI-fetch, and could replace the current poll entirely.

### Follow-up resolved same day — we now fetch the payload ourselves

`GET https://api.anthropic.com/api/oauth/usage` **verified live** (2026-07-26,
owner-authorized) with the local `claudeAiOauth.accessToken`:

- `200`, ~1.6 s through our existing resilient transport (the IPv4 pin already in
  `resilientFetch` handles this machine's dead-AAAA route);
- body is FLAT — the same object the CLI wraps as `cachedUsageUtilization
  .utilization`: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`,
  `extra_usage`, `spend`, `limits[]`;
- `limits[]` carried the live `weekly_scoped` Fable row at **91%** while the
  on-disk cache still said **82%** (4 h stale) — the drift this closes.

Implemented as source 1 in [`src/quota.ts`](../src/quota.ts) `fetchUsage` +
[`src/usage.ts`](../src/usage.ts) (shared parser for the live body and the
cached copy). It costs **zero tokens**, so the 1-token header poll is now
skipped while it delivers 5h/7d (`usageCoversQuota`) and resumes automatically
otherwise. Nothing was removed: header poll → statusLine bridge → on-disk cache
all remain, freshest reading wins.
