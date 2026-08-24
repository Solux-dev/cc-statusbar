#!/usr/bin/env python3
"""Claude Code statusLine script + local quota bridge for the cc-statusbar extension.

Claude Code hands its statusLine hook a JSON payload on stdin after every
assistant message. That payload carries the REAL 5h/7d subscription limits
(`rate_limits`), read from the headers of Claude Code's own ongoing traffic —
no extra request, no extra token. The VS Code extension cannot see that stdin,
so this script mirrors those limits to a tiny local file that the extension
reads with zero network:

    ~/.claude/.cc-statusbar-quota.json

This is source 2 of the extension's four quota sources (see README →
"How it gets data"). It is entirely optional: without it the extension still
reads quota over the network. It matters on links too weak for a network call
to complete, because it costs no request at all.

Terminal sessions only. The VS Code / Cursor integration runs Claude Code
*without* a status line, so an IDE-only session never triggers this script.

Setup — add to ~/.claude/settings.json (adjust the path to where you put it):

    {
      "statusLine": {
        "type": "command",
        "command": "python ~/.claude/statusline.py"
      }
    }

Already have your own statusLine script? Keep it, and copy just
`dump_quota_bridge()` plus its call at the end of `main()` into it — the bridge
is independent of whatever your script prints.

Requires Python 3.8+. No third-party packages. Windows, macOS and Linux.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

# Where the extension looks for the mirrored limits. Must match
# src/localQuota.ts → bridgePath(). Do not rename without changing both.
QUOTA_BRIDGE_PATH = Path.home() / ".claude" / ".cc-statusbar-quota.json"

# Windows consoles default to a legacy code page, so the block glyphs below
# would raise UnicodeEncodeError and the status line would show nothing.
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
DIM = "\033[2m"
RESET = "\033[0m"


def fmt_remaining(seconds: float) -> str:
    """Countdown to a window reset: '38m' / '2h41m' / '4d3h'."""
    secs = int(seconds)
    if secs <= 0:
        return "—"
    days, rem = divmod(secs, 86_400)
    hours, rem = divmod(rem, 3_600)
    mins = rem // 60
    if days:
        return f"{days}d{hours}h"
    if hours:
        return f"{hours}h{mins:02d}m"
    return f"{mins}m"


def quota_segment(label: str, window: object, now: float, window_seconds: int) -> "str | None":
    """One quota window as a pace-coloured bar: '5h ▓▓▓░░░░░ 34% on track · resets in 2h41m'.

    The colour is the projected end-of-window usage, not the current percentage:
    a nearly full window that is about to reset is normal, not an alarm.
        green  — projected under 90%
        yellow — projected 90-102% (lands right on the limit)
        red    — projected over 102% (on pace to run out before the reset)
    Skipped during the first 3% of a window: too little data to extrapolate.
    Returns None when the window is missing from the payload.
    """
    if not isinstance(window, dict):
        return None
    pct = window.get("used_percentage")
    if not isinstance(pct, (int, float)):
        return None
    pct = float(pct)

    color, status, reset_txt = GREEN, "on track", ""
    resets_at = window.get("resets_at")
    if isinstance(resets_at, (int, float)):
        remaining = resets_at - now
        reset_txt = f" · resets in {fmt_remaining(remaining)}"
        elapsed = (window_seconds - remaining) / window_seconds
        if 0.03 < elapsed <= 1 and remaining > 0:
            projected = pct / elapsed
            if projected > 102:
                color, status = RED, "over pace"
            elif projected >= 90:
                color, status = YELLOW, "running tight"

    width = 8
    filled = max(0, min(width, round(pct / 100 * width)))
    bar = "▓" * filled + "░" * (width - filled)
    return f"{label} {color}{bar}{RESET} {pct:.0f}% {status}{reset_txt}"


def build_status_line(data: dict, now: "float | None" = None) -> str:
    """Compact one-line status: model, context fill, then both quota windows."""
    if now is None:
        now = time.time()

    model = (data.get("model") or {}).get("display_name") or "model?"
    ctx = data.get("context_window") or {}
    limits = data.get("rate_limits") or {}

    ctx_pct = ctx.get("used_percentage")
    head = f"[{model}]"
    if isinstance(ctx_pct, (int, float)):
        head += f" ctx {float(ctx_pct):.0f}%"

    segments = [
        quota_segment("5h", limits.get("five_hour"), now, 5 * 3600),
        quota_segment("7d", limits.get("seven_day"), now, 7 * 86_400),
    ]
    segments = [s for s in segments if s]
    if not segments:
        return f"{head} · {DIM}5h/7d limits appear after Claude's first reply{RESET}"
    return head + " · " + " · ".join(segments)


def render(raw: str) -> str:
    """Raw stdin to the line we print. All error handling lives here."""
    if not raw.strip():
        return "[statusline] no input"
    try:
        data = json.loads(raw)
    except Exception:
        return "[statusline] invalid json"
    if not isinstance(data, dict):
        return "[statusline] unexpected payload"
    try:
        return build_status_line(data)
    except Exception:
        return "[statusline] render error"


def dump_quota_bridge(raw: str, now: "float | None" = None) -> None:
    """Mirror the stdin `rate_limits` to QUOTA_BRIDGE_PATH for the extension.

    Best-effort and isolated: every failure is swallowed, and this runs only
    after the status line is already on stdout, so the bridge can never break
    what you see. Writes only when at least one window carries a real
    `used_percentage`, so an early render before the first API response never
    overwrites a good last-known reading. The write is atomic (temp file plus
    rename), so the extension never reads a half-written file.
    """
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            return
        limits = data.get("rate_limits") or {}
        windows = [limits.get("five_hour"), limits.get("seven_day")]
        if not any(isinstance(w, dict) and w.get("used_percentage") is not None for w in windows):
            return
        payload = {
            "writtenAtSec": int(now if now is not None else time.time()),
            "rate_limits": limits,
        }
        QUOTA_BRIDGE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = QUOTA_BRIDGE_PATH.with_name(QUOTA_BRIDGE_PATH.name + ".tmp")
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        tmp.replace(QUOTA_BRIDGE_PATH)
    except Exception:
        pass


def main() -> None:
    try:
        raw = sys.stdin.read()
    except Exception:
        raw = ""

    try:
        sys.stdout.write(render(raw) + "\n")
    except Exception:
        # Last resort: never leave the status line blank on an encoding error.
        print("[statusline] render error")

    dump_quota_bridge(raw)


if __name__ == "__main__":
    main()
