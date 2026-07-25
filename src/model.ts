// WHICH MODEL the session in front of you runs on — the one signal a Claude Code
// user cannot see passively while working (the picker lives inside the chat UI,
// the status bar is where the eyes already are).
//
// Two sources, deliberately kept apart because they answer different questions:
//
//   CONFIRMED — `message.model` of the LAST main-transcript assistant turn (read
//           in metrics.lastAssistantContext). That is what actually ran and
//           burned quota. Subagents can run a different model, but they live in
//           separate `<session>/subagents/agent-*.jsonl` files AND carry
//           isSidechain — both excluded upstream, so a helper model can never
//           masquerade as the model you are talking to.
//
//   PLANNED — `ANTHROPIC_MODEL` in the environment, else the `model` key in
//           Claude Code's OWN settings. Claude Code writes that key itself: the
//           VS Code model picker does `setModel → writeUserSettingsAndPush`, and
//           `/model` writes it when the choice is saved "as your default for new
//           sessions". So it is what a chat that has not answered yet will start
//           on — the only truthful answer available before a first reply exists.
//
// Which one applies is decided by Claude Code's live-session registry
// (`~/.claude/sessions/<pid>.json`, written when a chat tab opens — before any
// prompt). A registered session that has NO transcript file has never answered;
// that is an unanswered chat, and only for those is the PLANNED value shown.
// A RESUMED session already has a transcript, so its confirmed model keeps
// winning — resuming must not downgrade a known fact to an expectation.
//
// What this deliberately does NOT claim: which chat tab is FOCUSED. VS Code
// exposes no API for that, so when an unanswered chat is open next to an active
// one the bar says so instead of guessing (see `pendingLabel` in render.ts).
//
// Sources checked and rejected: the statusLine bridge (IDE sessions run Claude
// Code without a status line), the SessionStart hook (carries `model` only in
// the terminal path), the process command line (no --model), VS Code
// globalState / .claude.json (no model there).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { projectSlug } from "./transcript";

/** Where the shown model name came from — this is displayed, never smoothed. */
export type ModelState =
  | "actual" // confirmed: a real turn ran on it
  | "planned" // no turn yet; settings say a new chat starts on it
  | "planned-default"; // no turn yet and nothing pinned (account default)

export type PlannedScope = "local" | "project" | "user" | "env";

/** A settings key is tri-state, and the three states mean different things:
 *  absent (defer to a broader scope) · explicit "default" (clear any broader
 *  pin — the account default applies) · a pinned value. Collapsing the first two
 *  into "null" would let a broader scope's model be shown for a chat that
 *  explicitly cleared it. */
export type SettingsValue =
  | { kind: "absent" }
  | { kind: "default" }
  | { kind: "pinned"; value: string };

const ABSENT: SettingsValue = { kind: "absent" };

export interface PlannedModel {
  /** Pinned model id, or null when nothing is pinned (= account default). */
  id: string | null;
  /** Which layer decided it (null when nothing anywhere pinned one). */
  scope: PlannedScope | null;
}

/** Claude Code's `model` setting: a full id ("claude-opus-5"), a family alias
 *  ("opus"), or an id with the 1M-context marker ("claude-opus-5[1m]").
 *  "default" explicitly means "no override". Pure. */
export function parseSettingsModel(raw: string): SettingsValue {
  try {
    const obj = JSON.parse(raw);
    const m = obj?.model;
    if (typeof m !== "string") return ABSENT;
    const t = m.trim();
    if (!t) return ABSENT;
    if (t.toLowerCase() === "default") return { kind: "default" };
    return { kind: "pinned", value: t };
  } catch {
    return ABSENT; // unreadable/!JSON contributes nothing, never throws
  }
}

/** The reasoning-effort level pinned in Claude Code's settings. `ultracode: true`
 *  is a separate flag that MEANS xhigh effort, so it is read as such rather than
 *  ignored. Pure. */
export function parseSettingsEffort(raw: string): SettingsValue {
  try {
    const obj = JSON.parse(raw);
    if (obj?.ultracode === true) return { kind: "pinned", value: "xhigh" };
    const e = obj?.effortLevel;
    if (typeof e !== "string") return ABSENT;
    const t = e.trim().toLowerCase();
    if (t === "default") return { kind: "default" };
    return t === "low" || t === "medium" || t === "high" || t === "xhigh"
      ? { kind: "pinned", value: t }
      : ABSENT; // not a level Claude Code accepts → treat as unset, never shown
  } catch {
    return ABSENT;
  }
}

/** Resolve one setting across Claude Code's layers. Narrowest wins, and the
 *  FIRST layer that says anything decides — including when it says "default",
 *  which clears broader pins instead of deferring to them. Pure. */
export function pickPlanned(layers: Array<{ scope: PlannedScope; value: SettingsValue }>): PlannedModel {
  const order: PlannedScope[] = ["env", "local", "project", "user"];
  for (const scope of order) {
    const layer = layers.find((l) => l.scope === scope && l.value.kind !== "absent");
    if (!layer) continue;
    return layer.value.kind === "pinned" ? { id: layer.value.value, scope } : { id: null, scope };
  }
  return { id: null, scope: null };
}

/** A model id that names a real model. Claude Code writes `<synthetic>` for its
 *  own placeholder turns (interrupts, errors); those must never become the
 *  displayed model nor a context-window lookup key. Pure. */
export function isRealModelId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.trim().length > 0 && !id.trim().startsWith("<");
}

const FAMILIES = ["opus", "sonnet", "haiku", "fable"];

/** Is this one of Anthropic's own id shapes, which we know how to shorten?
 *  Anything else — Bedrock ARNs, Vertex/Foundry deployment names, a company's
 *  own alias — must NOT be run through the shortener: it would produce a
 *  confident but wrong name (`arn:aws:bedrock:…` → "Arn:aws:bedrock:us"). Pure. */
export function isClaudeStyleId(id: string): boolean {
  const base = id.trim().toLowerCase().replace(/\[1m\]$/i, "");
  const parts = base.replace(/^claude[-_]/, "").split(/[-_.]/).filter(Boolean);
  if (!parts.length) return false;
  if (!parts.some((p) => FAMILIES.includes(p))) return false;
  // every other token must be a version number, a release date, or "latest"
  return parts.every((p) => FAMILIES.includes(p) || /^\d+$/.test(p) || p === "latest");
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Derive "Opus 4.8" from "claude-opus-4-8" without any network. Handles the
 *  release-date suffix ("claude-haiku-4-5-20251001" → "Haiku 4.5"), family
 *  aliases ("opus" → "Opus"), dotted versions ("claude-opus-5.1" → "Opus 5.1")
 *  and the legacy id order ("claude-3-5-sonnet-…" → "Sonnet 3.5"). Only ever
 *  called for ids that passed isClaudeStyleId. Pure. */
export function deriveLabel(id: string): string {
  const parts = id
    .trim()
    .toLowerCase()
    .replace(/^claude[-_]/, "")
    .split(/[-_.]/)
    .filter(Boolean);
  if (!parts.length) return "";
  if (/^\d{8}$/.test(parts[parts.length - 1])) parts.pop(); // drop a release date
  const family = parts.find((p) => FAMILIES.includes(p)) ?? parts.find((p) => !/^\d+$/.test(p));
  if (!family) return id;
  const version = parts.filter((p) => /^\d+$/.test(p)).join(".");
  return version ? `${capitalize(family)} ${version}` : capitalize(family);
}

/** Best readable form of an id we do NOT recognise: keep the raw value (it is
 *  the truth), trimmed to the most identifying tail so the bar stays glanceable.
 *  The full id remains available in the panel. Pure. */
export function fallbackLabel(id: string): string {
  const tail = id.trim().split("/").pop() || id.trim();
  const MAX = 24;
  return tail.length <= MAX ? tail : `…${tail.slice(-(MAX - 1))}`;
}

/** Short, glanceable label: "Opus 5", "Sonnet 5", "Haiku 4.5", "Opus 5 1M".
 *
 *  `displayName` (from GET /v1/models/{id}, already fetched for the context
 *  limit) wins when present — it is Anthropic's own naming. Otherwise the label
 *  is derived from the id for known shapes, or kept as a trimmed raw id for
 *  anything else, so the model shows INSTANTLY and fully offline without ever
 *  inventing a name. Pure. */
export function shortModelLabel(
  id: string | null | undefined,
  displayName?: string | null
): string | null {
  if (!isRealModelId(id)) return null;
  const raw = (id as string).trim();
  const fromApi = displayName ? displayName.replace(/^claude\s+/i, "").trim() : "";
  if (fromApi) return fromApi;
  if (!isClaudeStyleId(raw)) return fallbackLabel(raw);
  // "[1m]" = the 1M-context variant — a different context budget, worth showing.
  const oneM = /\[1m\]$/i.test(raw);
  const label = deriveLabel(raw.replace(/\[1m\]$/i, ""));
  if (!label) return fallbackLabel(raw);
  return oneM ? `${label} 1M` : label;
}

function claudeHome(): string {
  return path.join(os.homedir(), ".claude");
}

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

/** The layers Claude Code merges for a setting, narrowest first. `ANTHROPIC_MODEL`
 *  outranks all settings files in Claude Code's own resolution, so it is one of
 *  the layers rather than an afterthought. (Enterprise policy settings outrank
 *  even that, but they have no fixed cross-platform path — a policy-pinned model
 *  therefore surfaces only once a turn confirms it, which is fail-quiet, not
 *  fail-wrong.) */
function settingsLayers(
  cwd: string,
  homeDir: string,
  envModel: string | undefined,
  parse: (raw: string) => SettingsValue,
  useEnv: boolean
): Array<{ scope: PlannedScope; value: SettingsValue }> {
  const env: SettingsValue =
    useEnv && envModel && envModel.trim() ? { kind: "pinned", value: envModel.trim() } : ABSENT;
  return [
    { scope: "env", value: env },
    { scope: "local", value: parse(readFileSafe(path.join(cwd, ".claude", "settings.local.json"))) },
    { scope: "project", value: parse(readFileSafe(path.join(cwd, ".claude", "settings.json"))) },
    { scope: "user", value: parse(readFileSafe(path.join(homeDir, "settings.json"))) },
  ];
}

/** Read the pinned ("planned") model. Never throws. */
export function readPlannedModel(
  cwd: string,
  homeDir = claudeHome(),
  env: NodeJS.ProcessEnv = process.env
): PlannedModel {
  return pickPlanned(settingsLayers(cwd, homeDir, env.ANTHROPIC_MODEL, parseSettingsModel, true));
}

/** Read the pinned ("planned") effort level, same layering. */
export function readPlannedEffort(cwd: string, homeDir = claudeHome()): string | null {
  return pickPlanned(settingsLayers(cwd, homeDir, undefined, parseSettingsEffort, false)).id;
}

/** One entry of Claude Code's live-session registry (`~/.claude/sessions/*.json`). */
export interface SessionRegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAtMs: number;
}

/** Parse one registry file's JSON. Pure → unit-testable. Null on any bad shape. */
export function parseSessionEntry(raw: string): SessionRegistryEntry | null {
  try {
    const o = JSON.parse(raw);
    if (typeof o?.sessionId !== "string" || typeof o?.cwd !== "string") return null;
    const pid = typeof o.pid === "number" ? o.pid : 0;
    const startedAtMs = typeof o.startedAt === "number" ? o.startedAt : 0;
    return { pid, sessionId: o.sessionId, cwd: o.cwd, startedAtMs };
  } catch {
    return null;
  }
}

/** Same folder? Registry paths come from the CLI, workspace paths from VS Code —
 *  they differ in separators and drive-letter case on Windows. Pure. */
export function sameFolder(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const r = path.resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? r.toLowerCase().replace(/\//g, "\\") : r;
  };
  return norm(a) === norm(b);
}

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence probe, never touches the process
    return true;
  } catch (e: any) {
    // EPERM = it exists but belongs to another user → still alive.
    return e?.code === "EPERM";
  }
}

/** Which chats are open for this folder right now. */
export interface OpenChats {
  /** Live sessions that have produced no turn at all — a chat waiting for its
   *  first prompt. These are the ONLY ones the planned value describes. */
  unanswered: SessionRegistryEntry[];
  /** Total live sessions for this folder (>1 means the bar cannot know which tab
   *  is focused — VS Code exposes no such API — so it says so instead). */
  liveCount: number;
}

/** Split live sessions into answered/unanswered. Separated from disk I/O so it
 *  is pure → unit-testable. */
export function pickOpenChats(
  entries: SessionRegistryEntry[],
  hasTranscript: (sessionId: string) => boolean
): OpenChats {
  const unanswered = entries.filter((e) => !hasTranscript(e.sessionId));
  // newest first: if several unanswered chats exist, the newest is the one the
  // user just opened.
  unanswered.sort((a, b) => b.startedAtMs - a.startedAtMs);
  return { unanswered, liveCount: entries.length };
}

/** Read the live-session registry for this folder and check which of those
 *  sessions have a transcript yet. Dead pids are skipped so a registry file left
 *  behind by a hard-killed process does not fake an open chat (Claude Code
 *  removes the file on a normal exit; on Windows a reused pid could in principle
 *  still slip through, which is why this only ever ADDS a hint, never replaces a
 *  confirmed reading). */
export function readOpenChats(
  cwd: string,
  sessionsDir = path.join(claudeHome(), "sessions"),
  projectsDir = path.join(claudeHome(), "projects")
): OpenChats {
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return { unanswered: [], liveCount: 0 };
  }
  const entries: SessionRegistryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const e = parseSessionEntry(readFileSafe(path.join(sessionsDir, name)));
    if (!e || !sameFolder(e.cwd, cwd) || !pidAlive(e.pid)) continue;
    entries.push(e);
  }
  const dir = path.join(projectsDir, projectSlug(cwd));
  return pickOpenChats(entries, (sessionId) => {
    try {
      return fs.statSync(path.join(dir, `${sessionId}.jsonl`)).isFile();
    } catch {
      return false;
    }
  });
}
