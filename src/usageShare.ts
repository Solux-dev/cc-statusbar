// CROSS-WINDOW share of the usage reading — one fetch serves every open editor.
//
// Why this exists: the free usage route is now polled on a fixed cadence instead
// of only while the user types (see shouldPollFree). That is correct per window
// and wrong in aggregate — three VS Code windows on the same machine would
// triple the request rate against an undocumented endpoint for three copies of
// one identical number. So the window that fetches writes the result here, and
// every other window reads it and skips its own request. Total rate stays at one
// poll per interval no matter how many windows are open.
//
// Same idea as the statusline bridge in localQuota.ts (a file as the transport),
// with the roles reversed: there we CONSUME a file Claude Code writes, here we
// both produce and consume our own. Nothing depends on it — a missing or corrupt
// file simply means every window polls for itself, i.e. the behaviour without
// this module.

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { QuotaWindow, ScopedQuotaWindow } from "./metrics";
import { UsageWindows } from "./usage";

export interface SharedUsage extends UsageWindows {
  /** Unix seconds the writing window obtained this reading from the server. */
  fetchedAtSec: number;
  /** True only when the file existed, parsed, and carried at least one window. */
  ok: boolean;
}

const EMPTY: SharedUsage = { fiveH: null, sevenD: null, scoped: [], fetchedAtSec: 0, ok: false };

/** How far ahead of our own reading a shared file may legitimately be before we
 *  treat its clock as broken rather than merely faster. Overlapping requests
 *  finish seconds apart; anything beyond a poll interval or two is not a race,
 *  it is a bad timestamp. */
const SHARE_MAX_LEAD_SEC = 15 * 60;

/** Short, stable fingerprint of WHICH ACCOUNT a reading belongs to.
 *
 *  Derived from the resolved credentials FILE PATH — never from the token
 *  itself, which is not ours to copy or digest. Two windows pointed at the same
 *  file are the same account and may share; two pointed at different files are
 *  two accounts, and a share between them would put one account's 80% on the
 *  other's status bar. That is a WRONG number, not a stale one, so the two get
 *  separate files and simply do not share. Case- and separator-normalised so
 *  Windows' many spellings of one path do not fragment the share. Pure. */
export function accountKey(credentialsFile: string, platform: string = process.platform): string {
  // Resolve symlinks/junctions where we can: two aliases of one credentials
  // file are one account, and fragmenting them into two shares would silently
  // turn sharing off. Falls back to the lexical path when the file does not
  // exist yet (first run, or a path typed into settings before signing in).
  let full = path.resolve(credentialsFile);
  try {
    full = fs.realpathSync.native(full);
  } catch {
    /* not on disk yet — the lexical path is the best identity available */
  }
  // Case-folding is a WINDOWS truth, not a universal one: on Linux/macOS-with-a
  // -case-sensitive-volume, two paths differing only in case are two different
  // files, and folding them would merge two accounts into one share — the exact
  // failure this function exists to prevent.
  const norm = platform === "win32" ? full.replace(/\\/g, "/").toLowerCase() : full;
  return crypto.createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

/** Where the windows of ONE account meet. `credentialsFile` is the resolved
 *  path (see resolveCredentialsPath), not the raw setting. */
export function sharePath(credentialsFile: string, override = ""): string {
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), ".claude", `.cc-statusbar-usage-${accountKey(credentialsFile)}.json`);
}

function lockPath(credentialsFile: string, override = ""): string {
  return `${sharePath(credentialsFile, override)}.lock`;
}

/** How long a poll claim stays valid. Comfortably longer than the transport's
 *  worst case (~42s of escalating attempts) so a slow-but-alive window is not
 *  overtaken mid-request, and short enough that a killed one blocks nobody for
 *  long. */
export const CLAIM_TTL_SEC = 60;

/** Distinguishes two claims taken by the same process in the same second. */
let claimSeq = 0;

interface Claim {
  untilSec: number;
  token: string;
}

/** The claim currently on disk, or null when there is none we can trust. Never
 *  throws — an unreadable claim is treated as no claim, so a corrupt file can
 *  never become a permanent gate. */
function readClaim(file: string): Claim | null {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf-8"));
    const untilSec = typeof o?.untilSec === "number" && Number.isFinite(o.untilSec) ? o.untilSec : 0;
    if (!untilSec) return null;
    return { untilSec, token: typeof o?.token === "string" ? o.token : "" };
  } catch {
    return null;
  }
}

/** Try to become THE window that polls this interval. True = go ahead, false =
 *  somebody else is already doing it, use what they publish.
 *
 *  The shared file alone cannot prevent a simultaneous start: it is written only
 *  when a request COMPLETES, so every window that looks during those seconds
 *  sees the same stale file and all of them fetch — and, being on the same
 *  cadence, they can stay aligned and repeat it every interval. The claim is
 *  taken BEFORE the request, which is the gap the file cannot cover.
 *
 *  Deliberately an EXPIRING, STEALABLE claim rather than a lock: a crashed or
 *  suspended holder must not be able to stop the others from ever polling
 *  again. `wx` makes the common case a single atomic create — two windows
 *  racing cannot both win it. Never throws. */
export function claimUsagePoll(
  credentialsFile: string,
  nowSec: number,
  ttlSec: number = CLAIM_TTL_SEC,
  override = ""
): string | null {
  const file = lockPath(credentialsFile, override);
  // Identifies THIS claim, so its owner can tell "my claim" from "the claim of
  // whoever took over after mine expired" when releasing.
  const token = `${process.pid}:${nowSec}:${claimSeq++}`;
  const write = (): boolean => {
    try {
      fs.writeFileSync(file, JSON.stringify({ untilSec: nowSec + ttlSec, token }), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return token; // cannot coordinate → poll rather than go silent
  }
  if (write()) return token;

  // Something is already there. Stand down ONLY for a claim that is positively
  // alive; everything else — expired, unreadable, absurdly dated — is a leftover
  // to be cleared. The upper bound is generous rather than exact: two windows
  // read the clock a second or two apart, and a strict `nowSec + ttlSec` would
  // let a marginally-behind contender declare the winner's brand-new claim
  // "impossible" and steal it, which is the very collision this prevents.
  const claim = readClaim(file);
  if (claim && claim.untilSec > nowSec && claim.untilSec <= nowSec + SHARE_MAX_LEAD_SEC) return null;

  try {
    fs.unlinkSync(file);
  } catch {
    /* raced, or not ours to remove — the retry below decides */
  }
  if (write()) return token;

  // Could neither claim nor clear: a read-only home, a permissions problem, a
  // file we are not allowed to touch. FAIL OPEN. This claim is an optimisation
  // for the request count; letting it become a gate would mean an unwritable
  // directory silently stops the limits from ever updating again — trading the
  // bug we set out to fix for a quieter version of itself.
  return token;
}

/** Give the claim back the moment the request finishes, so the next interval is
 *  not gated by a TTL that has outlived its purpose.
 *
 *  Only ever releases OUR claim: a window suspended past its TTL wakes up to
 *  find someone else legitimately polling, and deleting that successor's claim
 *  would invite a third window in on top of it. Never throws. */
export function releaseUsagePoll(credentialsFile: string, token: string | null, override = ""): void {
  if (!token) return;
  const file = lockPath(credentialsFile, override);
  const claim = readClaim(file);
  if (claim && claim.token !== token) return; // superseded — not ours to remove
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone — nothing to do */
  }
}

/** Validate one window written by another window. Deliberately strict: a shared
 *  file is untrusted input like any other, and a half-written number must not
 *  reach the bar. Pure. */
function windowOf(v: any): QuotaWindow | null {
  if (!v || typeof v !== "object") return null;
  if (typeof v.pct !== "number" || !Number.isFinite(v.pct)) return null;
  const resetAt = typeof v.resetAt === "number" && Number.isFinite(v.resetAt) ? v.resetAt : null;
  return { pct: v.pct, resetAt };
}

function scopedOf(v: any): ScopedQuotaWindow | null {
  const w = windowOf(v);
  if (!w) return null;
  const label = typeof v.label === "string" ? v.label.trim() : "";
  return label ? { label, pct: w.pct, resetAt: w.resetAt } : null;
}

/** Parse the shared file's text. Separated from disk I/O so it is pure →
 *  unit-testable. Never throws. */
export function parseSharedUsage(raw: string): SharedUsage {
  try {
    const o = JSON.parse(raw);
    const fiveH = windowOf(o?.fiveH);
    const sevenD = windowOf(o?.sevenD);
    const scoped = (Array.isArray(o?.scoped) ? o.scoped.map(scopedOf).filter(Boolean) : []) as ScopedQuotaWindow[];
    const at = o?.fetchedAtSec;
    const fetchedAtSec = typeof at === "number" && Number.isFinite(at) && at > 0 ? Math.round(at) : 0;
    if (!fetchedAtSec) return EMPTY; // a reading with no clock cannot be compared → useless
    return { fiveH, sevenD, scoped, fetchedAtSec, ok: Boolean(fiveH || sevenD || scoped.length) };
  } catch {
    return EMPTY;
  }
}

/** The timestamp a shared reading may be USED with, or 0 when it may not be
 *  used at all.
 *
 *  The only rejection is a clock ahead of ours, and it matters twice over. For
 *  throttling, a future date would say "someone polled recently" forever, so
 *  this window would never poll again. For the freshest-wins merge it is worse:
 *  the winner is kept and persisted, so nothing real could ever out-freshen a
 *  bogus date — the display would be pinned to that one reading for good. Both
 *  failures are silent, which is why an ordinary file write by any process on
 *  the machine must not be able to cause them. Pure. */
export function usableSharedAtSec(shared: SharedUsage, nowSec: number): number {
  if (!shared.ok) return 0;
  return shared.fetchedAtSec > 0 && shared.fetchedAtSec <= nowSec ? shared.fetchedAtSec : 0;
}

/** Read the reading another window (or this one, earlier) last fetched. NO
 *  network. Never throws — an absent/unreadable file just means "nobody has
 *  fetched recently", which makes this window poll for itself. */
export function readSharedUsage(credentialsFile: string, override = ""): SharedUsage {
  try {
    return parseSharedUsage(fs.readFileSync(sharePath(credentialsFile, override), "utf-8"));
  } catch {
    return EMPTY;
  }
}

/** Publish a reading for the other windows of the same account. Written via a
 *  temp file + rename so a concurrent reader can never observe half a JSON
 *  document. Never throws — failing to share is not a reason to fail the tick. */
export function writeSharedUsage(
  credentialsFile: string,
  windows: UsageWindows,
  fetchedAtSec: number,
  override = ""
): void {
  const file = sharePath(credentialsFile, override);
  // Per-process, but NOT per-call: a process killed between write and rename
  // would otherwise strand a new temp file every time, while one fixed name per
  // process is simply overwritten by that process's next write.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // Two windows can finish overlapping requests out of order — the slower one
    // started earlier and would otherwise replace a NEWER reading with its own
    // older one. Harmless for windows already running (their merge only accepts
    // strictly fresher), but a window opening afterwards would read the
    // regressed value as the best available. Cheap check, not a lock: the race
    // is narrow and the cost of losing it is one stale interval.
    //
    // The lead is BOUNDED, and that bound is the important half. A genuinely
    // newer reading is at most seconds ahead of ours. A file claiming hours or
    // years is a bad clock or a corrupt write — and yielding to it would be
    // permanent: readers reject a future date (usableSharedAtSec), so nobody
    // would use the file and nobody would ever be allowed to repair it.
    const existing = parseSharedUsage(fs.readFileSync(file, "utf-8"));
    const lead = existing.ok ? existing.fetchedAtSec - fetchedAtSec : 0;
    if (lead > 0 && lead <= SHARE_MAX_LEAD_SEC) return;
  } catch {
    /* no readable file yet — ours becomes the first */
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ ...windows, fetchedAtSec }), "utf-8");
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing left to clean up */
    }
  }
}
