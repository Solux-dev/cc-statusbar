// Locate and read the ACTIVE Claude Code session transcript for a workspace,
// then sum tokens (lead + subagents) exactly like tools/session-cost.py.
// All data here is LOCAL and robust — independent of Anthropic auth changes.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  Totals,
  ContextInfo,
  CacheTier,
  AgentDigest,
  IdleRebuild,
  agentDigest,
  sumTranscript,
  addTotals,
  addRebuild,
  emptyTotals,
  emptyRebuild,
  idleRebuildOf,
  lastAssistantContext,
  lastCacheTier,
  cacheHitRatePct,
} from "./metrics";

/** Claude Code's project slug: every non-alphanumeric char in the cwd replaced
 *  by '-' (so ':', '\', '/', '_', spaces, dots, parens … all collapse to '-').
 *  Must match Claude Code's own slug exactly — e.g. "…\My_Projects\Kasta Rico"
 *  → "…-My-Projects-Kasta-Rico". A narrower class (e.g. only [:\\/_]) silently
 *  fails to find sessions for any folder whose name contains a space. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function projectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** Newest *.jsonl directly inside the slug dir = the active session file. */
export function findActiveTranscript(cwd: string): string | null {
  const dir = path.join(projectsRoot(), projectSlug(cwd));
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best: { file: string; mtime: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.mtime) best = { file: full, mtime: st.mtimeMs };
    } catch {
      /* skip */
    }
  }
  return best ? best.file : null;
}

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

/** One subagent of the active session, as shown in the panel: which model the
 *  Lead delegated to, at what effort, what it cost, and what it was for. */
export interface SubagentInfo {
  /** Agent id from the file name (agent-<id>.jsonl). */
  id: string;
  /** Agent type from the sibling .meta.json ("general-purpose", "Explore", …). */
  agentType: string | null;
  /** Short task description the spawner gave it. */
  description: string | null;
  model: string | null;
  effort: string | null;
  /** 1 = spawned by the Lead. >1 = spawned by ANOTHER agent — real and common
   *  (measured on this machine: 82 of 620 agents, nesting up to depth 5), so the
   *  UI must not claim the Lead chose every one of these models. */
  spawnDepth: number | null;
  /** Agent that spawned it, when nested. */
  parentAgentId: string | null;
  totals: Totals;
  lastTurnMs: number;
  /** What this agent's own idle gaps cost — see IdleRebuild. */
  rebuild: IdleRebuild;
}

/** Parse cache for agent files: an agent's transcript is APPEND-ONLY and most of
 *  them are finished, so re-parsing every file on every 10s tick is pure waste
 *  (a busy session can hold dozens of MB of agent logs). Keyed by path,
 *  invalidated by mtime+size. */
interface AgentMeta {
  agentType: string | null;
  description: string | null;
  spawnDepth: number | null;
  parentAgentId: string | null;
}

interface AgentCacheEntry {
  mtimeMs: number;
  size: number;
  /** The sibling .meta.json is written independently of the transcript, so it
   *  needs its own invalidation stamp — keying only on the .jsonl could pin a
   *  missing/half-written description for the lifetime of the window. */
  metaStamp: string;
  digest: AgentDigest;
  meta: AgentMeta;
}
const agentCache = new Map<string, AgentCacheEntry>();

function metaPathFor(jsonlPath: string): string {
  // Claude Code writes agent-<id>.meta.json next to agent-<id>.jsonl.
  return jsonlPath.replace(/\.jsonl$/, ".meta.json");
}

function metaStamp(metaPath: string): string {
  try {
    const st = fs.statSync(metaPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "none";
  }
}

function readAgentMeta(metaPath: string): AgentMeta {
  try {
    const o = JSON.parse(readFileSafe(metaPath));
    return {
      agentType: typeof o?.agentType === "string" ? o.agentType : null,
      description: typeof o?.description === "string" ? o.description : null,
      spawnDepth: typeof o?.spawnDepth === "number" ? o.spawnDepth : null,
      parentAgentId: typeof o?.parentAgentId === "string" ? o.parentAgentId : null,
    };
  } catch {
    return { agentType: null, description: null, spawnDepth: null, parentAgentId: null };
  }
}

/** Read every subagent of one session. */
export function readSubagents(mainTranscript: string): SubagentInfo[] {
  const stem = mainTranscript.replace(/\.jsonl$/, "");
  const subDir = path.join(stem, "subagents");
  let names: string[];
  try {
    names = fs.readdirSync(subDir);
  } catch {
    return []; // no subagents dir — fine
  }
  const out: SubagentInfo[] = [];
  const seenPaths = new Set<string>();
  for (const name of names) {
    if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
    const full = path.join(subDir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    const metaPath = metaPathFor(full);
    const stamp = metaStamp(metaPath);
    const cached = agentCache.get(full);
    let entry: AgentCacheEntry;
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.metaStamp === stamp) {
      entry = cached;
    } else {
      const logUnchanged = Boolean(cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size);
      let raw: string | null = null;
      if (!logUnchanged) {
        try {
          raw = fs.readFileSync(full, "utf-8");
        } catch {
          raw = null; // transient failure — not an empty agent log
        }
      }
      entry = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        metaStamp: stamp,
        digest: logUnchanged
          ? cached!.digest // only the metadata changed — no need to re-parse the log
          : agentDigest(raw ?? ""),
        meta: readAgentMeta(metaPath),
      };
      // A failed read must not be remembered under the live file's stamp: it
      // would pin an agent at zero tokens until its log happened to change.
      if (logUnchanged || raw != null) agentCache.set(full, entry);
    }
    seenPaths.add(full);
    out.push({
      id: name.replace(/^agent-/, "").replace(/\.jsonl$/, ""),
      agentType: entry.meta.agentType,
      description: entry.meta.description,
      model: entry.digest.model,
      effort: entry.digest.effort,
      spawnDepth: entry.meta.spawnDepth,
      parentAgentId: entry.meta.parentAgentId,
      totals: entry.digest.totals,
      lastTurnMs: entry.digest.lastTurnMs || st.mtimeMs,
      rebuild: entry.digest.rebuild,
    });
  }
  // Drop cache entries for agents outside the session we are now watching, so a
  // long-lived window does not accumulate every session it has ever seen.
  for (const key of agentCache.keys()) {
    if (!seenPaths.has(key)) agentCache.delete(key);
  }
  out.sort((a, b) => b.lastTurnMs - a.lastTurnMs);
  return out;
}

/** Everything derived from ONE read of the main transcript. Kept together so the
 *  file is parsed once per change instead of once per derived value per tick. */
interface MainDigest {
  totals: Totals;
  context: ContextInfo;
  cacheTier: CacheTier;
  rebuild: IdleRebuild;
}

/** The main transcript is re-read on every redraw tick, and a long session's
 *  file reaches tens of megabytes. Cache the parse by mtime+size, exactly like
 *  the agent files: an append changes both, so a stale digest cannot survive a
 *  new turn, and an idle session costs one stat() instead of four full parses.
 *  One entry — the active session — so nothing accumulates. */
let mainCache: { path: string; mtimeMs: number; size: number; digest: MainDigest } | null = null;

function readMainDigest(main: string, st: fs.Stats | null): MainDigest {
  if (st && mainCache && mainCache.path === main && mainCache.mtimeMs === st.mtimeMs && mainCache.size === st.size) {
    return mainCache.digest;
  }
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(main, "utf-8");
  } catch {
    raw = null; // a transient failure (lock, permission blip) — NOT an empty file
  }
  const digest: MainDigest = {
    totals: sumTranscript(raw ?? ""),
    // MAIN only — subagents have their own windows and must not move this.
    context: lastAssistantContext(raw ?? ""),
    // Cache insight describes the MAIN session only: subagents run at 5m and
    // would mix tiers.
    cacheTier: lastCacheTier(raw ?? ""),
    rebuild: idleRebuildOf(raw ?? ""),
  };
  // Remember it only when we have BOTH an invalidation key and a real read.
  // Caching a failed read under the live file's stamp would pin zeros on the
  // panel until the transcript happened to change — a silent blackout.
  if (st && raw != null) mainCache = { path: main, mtimeMs: st.mtimeMs, size: st.size, digest };
  return digest;
}

/** Sum the active session: main transcript + its subagents/agent-*.jsonl.
 *  COST (`totals`) sums main + subagents. CONTEXT (`context`) is the MAIN
 *  transcript's last turn ONLY — subagents have separate windows (see spec). */
export function readSessionTotals(cwd: string): {
  totals: Totals;
  transcript: string | null;
  mtimeMs: number;
  context: ContextInfo;
  cacheTier: CacheTier;
  cacheHitRatePct: number | null;
  /** Lead-only consumption, so the panel can say how much of the session's
   *  spend went to delegated work. */
  leadTotals: Totals;
  subagents: SubagentInfo[];
  /** What the LEAD's own idle gaps cost. Reported without advice attached: the
   *  owner stepping away is not a defect, and a lead's cache_creation spike has
   *  real non-idle causes (a model switch during the break, compaction). */
  leadRebuild: IdleRebuild;
  /** The same, summed over every subagent stream with a KNOWN tier. This is the
   *  actionable one — an agent cannot switch model mid-run or be compacted, so
   *  the confounders are absent by construction. */
  subagentRebuild: IdleRebuild;
} {
  const main = findActiveTranscript(cwd);
  if (!main) {
    return {
      totals: emptyTotals(),
      transcript: null,
      mtimeMs: 0,
      context: { tokens: null, modelId: null, effort: null, turnId: null },
      cacheTier: null,
      cacheHitRatePct: null,
      leadTotals: emptyTotals(),
      subagents: [],
      leadRebuild: emptyRebuild(),
      subagentRebuild: emptyRebuild(),
    };
  }

  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(main);
  } catch {
    /* ignore — we then read without a cache key */
  }
  const digest = readMainDigest(main, st);
  const mainTotals = digest.totals;
  let totals = mainTotals;

  // subagents live in <main-without-ext>/subagents/agent-*.jsonl
  const subagents = readSubagents(main);
  let subagentRebuild = emptyRebuild();
  for (const a of subagents) {
    totals = addTotals(totals, a.totals);
    subagentRebuild = addRebuild(subagentRebuild, a.rebuild);
  }

  return {
    totals,
    transcript: main,
    mtimeMs: st ? st.mtimeMs : 0,
    context: digest.context,
    cacheTier: digest.cacheTier,
    cacheHitRatePct: cacheHitRatePct(mainTotals),
    leadTotals: mainTotals,
    subagents,
    leadRebuild: digest.rebuild,
    subagentRebuild,
  };
}
