# Security

## Reporting a vulnerability

**Please report privately, not in a public issue.**

Use GitHub's private reporting form:
[**Report a vulnerability**](https://github.com/Solux-dev/cc-statusbar/security/advisories/new).
Only the maintainer sees it, and the report stays hidden until a fix ships.

Include what you would want to receive yourself: the version, your OS and editor,
what the extension did, and the smallest way to reproduce it. A proof of concept
helps more than a description.

You will get an acknowledgement within **7 days**. This is a one-person project,
not a company with an on-call rota — if a week passes with no reply, please open
a plain (non-security) issue saying only *"awaiting a reply on a private
report"*, with no details, and it will be picked up.

## Supported versions

Only the **latest published version** is supported. Fixes ship as a new release
on the [VS Marketplace](https://marketplace.visualstudio.com/items?itemName=solux-dev.cc-statusbar)
and [Open VSX](https://open-vsx.org/extension/solux-dev/cc-statusbar); there are
no backports to older versions.

## What this extension touches — and what would count as a vulnerability

The extension is a read-only reporter. It has no server of its own, no
telemetry, and no analytics. It reads local files and makes two network requests.

| It does this | So a bug here would matter |
|---|---|
| Reads your Claude Code OAuth token from `~/.claude/.credentials.json` | Sending that token anywhere except Anthropic's own API |
| Reads local Claude Code transcripts (`~/.claude/projects/**`) for token counters | Sending transcript content anywhere at all |
| Reads local Codex session files and talks to the local Codex app-server/CLI | Sending that data outside your machine |
| Writes a small quota cache under the extension's own storage | Writing outside its own storage, or storing a credential in it |
| Renders two webview panels | Rendering unescaped data as HTML or script (the panels have no scripts and a `default-src 'none'` policy) |

**Anything that moves your credentials, prompts, code, or transcripts off your
machine is a vulnerability — report it privately.** So is anything that lets a
file the extension reads (a transcript, a Codex session file, a quota response)
execute code or inject markup into a panel.

The five files that carry all of the above are small and worth reading before
you report, so you can point at a line:
[`src/quota.ts`](src/quota.ts) (the two network requests),
[`src/usage.ts`](src/usage.ts) (usage payloads and the on-disk copy),
[`src/localQuota.ts`](src/localQuota.ts) (the passive statusLine bridge),
[`src/transcript.ts`](src/transcript.ts) (transcript parsing),
[`src/codexAppServer.ts`](src/codexAppServer.ts) (the Codex side).

## What is *not* a vulnerability

- **A wrong number.** Quota, context or token figures that disagree with
  reality are ordinary bugs — please open a normal issue, they are welcome.
- **A quota reading that stops working.** These endpoints are undocumented and
  can change without notice; see *Reliability* in the README. That is a bug, not
  a security issue.
- **Anything requiring an attacker who is already running code as you.** If
  someone can read `~/.claude/.credentials.json` directly, this extension is not
  the weak link.
- **Findings from an automated scanner with no working exploit.** A report that
  names a line and a scenario is welcome; a tool's raw output is not.

## Scope

This repository only. The Claude Code CLI, the Codex CLI, VS Code itself and
Anthropic's or OpenAI's services belong to their own vendors — report those to
them.
