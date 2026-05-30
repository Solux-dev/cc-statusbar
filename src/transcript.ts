// Locate and read the ACTIVE Claude Code session transcript for a workspace,
// then sum tokens (lead + subagents) exactly like tools/session-cost.py.
// All data here is LOCAL and robust — independent of Anthropic auth changes.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Totals, ContextInfo, sumTranscript, addTotals, emptyTotals, lastAssistantContext } from "./metrics";

/** Claude Code's project slug: cwd with : \ / _ all replaced by '-'.
 *  Matches session-cost.py get_project_slug(). */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[:\\/_]/g, "-");
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

/** Sum the active session: main transcript + its subagents/agent-*.jsonl.
 *  COST (`totals`) sums main + subagents. CONTEXT (`context`) is the MAIN
 *  transcript's last turn ONLY — subagents have separate windows (see spec). */
export function readSessionTotals(cwd: string): {
  totals: Totals;
  transcript: string | null;
  mtimeMs: number;
  context: ContextInfo;
} {
  const main = findActiveTranscript(cwd);
  if (!main) {
    return { totals: emptyTotals(), transcript: null, mtimeMs: 0, context: { tokens: null, modelId: null } };
  }

  const mainRaw = readFileSafe(main);
  let totals = sumTranscript(mainRaw);
  const context = lastAssistantContext(mainRaw); // MAIN only — do NOT include subagents
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(main).mtimeMs;
  } catch {
    /* ignore */
  }

  // subagents live in <main-without-ext>/subagents/agent-*.jsonl
  const stem = main.replace(/\.jsonl$/, "");
  const subDir = path.join(stem, "subagents");
  try {
    for (const name of fs.readdirSync(subDir)) {
      if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
      totals = addTotals(totals, sumTranscript(readFileSafe(path.join(subDir, name))));
    }
  } catch {
    /* no subagents dir — fine */
  }

  return { totals, transcript: main, mtimeMs, context };
}
