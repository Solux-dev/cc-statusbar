// VS Code glue: wire transcript + quota + render into a StatusBarItem that
// refreshes on a timer. Keeps all fragile/IO logic in the imported modules.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { readSessionTotals, SubagentInfo } from "./transcript";
import {
  fetchQuota,
  fetchUsage,
  fetchModelWindow,
  backoffUntil,
  coversQuota,
  parseRetryAfterSec,
  resolveCredentialsPath,
  shouldPoll,
  shouldPollFree,
  usageCoversQuota,
  FAIL_RETRY_SEC,
  USAGE_BACKOFF_MAX_SEC,
  QuotaResult,
  UsageResult,
  ModelWindowResult,
} from "./quota";
import {
  buildView,
  buildPanelHtml,
  buildCodexQuotaView,
  buildCodexPanelHtml,
  QuotaView,
  ContextView,
  CacheView,
  ModelView,
  SubagentView,
  choicesMarkdown,
} from "./render";
import { Weights, ContextInfo, QuotaWindow, ScopedQuotaWindow, effectiveTokens, knownModelWindow } from "./metrics";
import { readLocalQuota } from "./localQuota";
import { readCachedUsage } from "./usage";
import {
  accountKey,
  claimUsagePoll,
  readSharedUsage,
  releaseUsagePoll,
  usableSharedAtSec,
  writeSharedUsage,
} from "./usageShare";
import { isRealModelId, readOpenChats, readPlannedEffort, readPlannedModel, shortModelLabel } from "./model";
import { resolveLang, messages, Lang, LangSetting } from "./i18n";
import { ProviderMode, ProviderSelection, UsageProviderKind } from "./providerTypes";
import {
  isRecentProviderActivity,
  newestActivityProvider,
  normalizeProviderMode,
  providerActivity,
  resolveProvider,
} from "./providerResolver";
import {
  CodexAppServerResult,
  CodexThreadSummary,
  CodexTokenUsageWatcher,
  codexThreadActivityMs,
  fetchCodexAppServerStatus,
  readCodexRolloutIdentity,
  readCodexRolloutTokenUsage,
} from "./codexAppServer";
import { codexCache, codexContext, shortCodexModelLabel } from "./codexProvider";

let item: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;
let panel: vscode.WebviewPanel | undefined;
let extCtx: vscode.ExtensionContext | undefined;
let diagnosticsChannel: vscode.OutputChannel | undefined;
const loggedDiagnostics = new Set<string>();

const TRUSTED_COMMANDS = [
  "ccStatusbar.switchLanguage",
  "ccStatusbar.openPanel",
  "ccStatusbar.selectProvider",
  "ccStatusbar.useAuto",
  "ccStatusbar.useClaude",
  "ccStatusbar.useCodex",
  "ccStatusbar.useLanguageAuto",
  "ccStatusbar.useLanguageEn",
  "ccStatusbar.useLanguageRu",
];

// quota state across ticks
let lastQuota: QuotaResult | null = null;
let lastFetchSec = 0;
// 429 backoff, ONE PER ROUTE. Sharing a single variable meant a 429 from the
// free usage GET also silenced the paid header poll — two independent endpoints
// gagged by one refusal, which is how a single bad reply took the whole feature
// off the air for an hour. They fail and recover on their own now.
let quotaBackoffUntilSec = 0;
let usageBackoffUntilSec = 0;
let inFlight = false;
/** Set by the status-bar click, cleared once the tick it triggered has decided
 *  whether to poll. This is what makes the refresh command actually refresh:
 *  every automatic gate (throttle, activity window, 429 backoff) is overridden
 *  for exactly one tick, bounded by FORCE_MIN_GAP_SEC inside the gate itself. */
let forceRefresh = false;
/** Hands the click's authority to the PAID route alone, one tick later.
 *
 *  A click normally reaches only the free route, because while that route is
 *  delivering, the paid one is skipped as redundant. But if the click's free
 *  request then FAILS, the click has produced nothing — and the ordinary
 *  activity gate would reject the fallback, since a user who clicks a stale
 *  number is by definition not typing. So the failure re-arms the override for
 *  the fallback only. Deliberately not the free route: re-arming that one on its
 *  own failure is a retry loop with no exit. */
let forceQuotaOnce = false;
/** Per-process offset (0–29s) added to the free route's cadence.
 *
 *  Several editor windows launched together tick in lockstep, so they can all
 *  find the shared file stale in the same instant and all fetch — and then stay
 *  aligned, repeating the burst every interval. A fixed per-process skew pulls
 *  them apart after the first round. Derived from the pid rather than random so
 *  a given process behaves identically every tick. */
const POLL_JITTER_SEC = process.pid % 30;

/** Which credentials file the remembered quota state belongs to. null until the
 *  first tick — an unknown previous account must not look like a change. */
let activeCredFile: string | null = null;

/** globalState keys for the last-known readings, scoped to the account.
 *
 *  Unscoped keys were the hole a restart could walk through: change the
 *  credentials setting while the editor is closed, and the next launch restored
 *  the PREVIOUS account's percentages — with the runtime switch-detector unable
 *  to help, since from its point of view nothing changed during the session. If
 *  the new account then cannot fetch, those foreign numbers simply stay. */
function quotaKey(credFile: string): string {
  return `lastGoodQuota:${accountKey(credFile)}`;
}

function usageKey(credFile: string): string {
  return `lastGoodUsage:${accountKey(credFile)}`;
}

/** Drop every remembered quota reading. Called on an account switch: these
 *  values are answers about a specific subscription, and there is no such thing
 *  as a stale-but-usable reading of the WRONG account. */
function forgetQuotaState(credFile: string): void {
  lastQuota = null;
  lastUsage = null;
  lastGoodQuota = null;
  lastGoodUsage = null;
  lastFetchSec = 0;
  lastUsageFetchSec = 0;
  quotaBackoffUntilSec = 0;
  usageBackoffUntilSec = 0;
  usageFailStreak = 0;
  lastPollFailed = false;
  void extCtx?.globalState.update(quotaKey(credFile), undefined);
  void extCtx?.globalState.update(usageKey(credFile), undefined);
}
// True after a failed (timeout/network) poll → the next poll is allowed sooner
// (FAIL_RETRY_SEC) so an intermittent link is caught quickly instead of waiting
// the full interval. Reset to false on any successful poll.
let lastPollFailed = false;

// Best-known quota across BOTH sources — the network poll AND the local
// statusline bridge (~/.claude/.cc-statusbar-quota.json). The displayed value
// is always the FRESHEST valid reading from either; this is what makes the new
// local source a strict SUPERSET of the old behavior (the network poll keeps
// updating this exactly as before — we only ADD a second way to refresh it).
// Persisted to globalState so a reload/update never blanks the line.
interface GoodQuota {
  fiveH: QuotaWindow | null;
  sevenD: QuotaWindow | null;
  atSec: number;
  source: "network" | "local" | "usage";
}
let lastGoodQuota: GoodQuota | null = null;

// ── usage payload (GET /api/oauth/usage) — the ONLY live source of the
// per-model weekly windows (Fable), and a free superset of the header poll:
// zero tokens, every window in one request. Shares the header poll's gate, so a
// manual click refreshes Fable too. On any failure we fall straight back to the
// header poll + the on-disk cache, which is why nothing here can regress.
let lastUsage: UsageResult | null = null;
/** Gate timestamp, separate from lastUsage.fetchedAtSec: a manual click zeroes
 *  THIS to force a re-ask, while the real fetch time keeps telling us whether
 *  the payload is currently covering the header poll. */
let lastUsageFetchSec = 0;
let usageInFlight = false;
/** Consecutive failures of the usage route. Drives the fast-retry allowance
 *  below: without a bound, a machine with no network would retry every 45s
 *  forever now that idleness no longer stops the poll. */
let usageFailStreak = 0;
/** How many quick retries a failure earns before the cadence settles back to
 *  the normal interval. Enough to ride out a tunnel or a laptop waking up;
 *  short enough that a genuinely offline machine stops burning wake-ups. */
const USAGE_FAST_RETRIES = 3;
/** Windows last seen from the LIVE payload, kept across ticks so a momentary
 *  failure doesn't blank the Fable row (the renderer states their age). */
let lastGoodUsage: { scoped: ScopedQuotaWindow[]; atSec: number } | null = null;

let lastCodex: CodexAppServerResult | null = null;
let lastCodexFetchSec = 0;
let codexInFlight = false;
let codexTokenWatcher: CodexTokenUsageWatcher | undefined;
let lastCodexThreadRefreshSec = 0;
const CODEX_THREAD_REFRESH_SEC = 10;

function logDiagnostics(scope: string, lines: string[]): void {
  const clean = lines.map((line) => line.trim()).filter(Boolean);
  if (!clean.length) return;
  const key = `${scope}\n${clean.join("\n")}`;
  if (loggedDiagnostics.has(key)) return;
  loggedDiagnostics.add(key);

  const stamp = new Date().toISOString();
  const block = [`[${stamp}] ${scope}`, ...clean.map((line) => `  ${line}`)].join("\n");
  diagnosticsChannel?.appendLine(block);
  diagnosticsChannel?.appendLine("");

  if (!extCtx) return;
  try {
    const dir = extCtx.globalStorageUri.fsPath;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "cc-statusbar.log"), `${block}\n\n`, "utf8");
  } catch {
    // Logging must never break the status bar.
  }
}

function codexDiagnostics(result: CodexAppServerResult): string[] {
  return result.state === "error" ? [result.detail, ...result.diagnostics] : result.diagnostics;
}

function observedCodexThread(cwd: string): CodexThreadSummary | null {
  const watched = codexTokenWatcher?.latestThread(cwd) || null;
  const fetched = lastCodex?.state === "ok" ? lastCodex.thread : null;
  if (!watched) return fetched;
  if (!fetched) return watched;
  return (codexThreadActivityMs(watched) || 0) >= (codexThreadActivityMs(fetched) || 0) ? watched : fetched;
}

function refreshCodexThread(nowSec: number, conf: ReturnType<typeof cfg>, cwd: string): void {
  const watcher = codexTokenWatcher;
  watcher?.ensureStarted(conf.codexCommandPath);
  if (!watcher?.isReady()) return;
  if (nowSec - lastCodexThreadRefreshSec < CODEX_THREAD_REFRESH_SEC) return;
  lastCodexThreadRefreshSec = nowSec;
  void watcher.refreshThread(cwd).then(() => void tick());
}

// model context-window limits: cached per model id and persisted in globalState.
// A model's window is IMMUTABLE, so a known-good value is kept indefinitely and
// is NEVER overwritten by a later failed fetch — that overwrite was what hid the
// context % on a weak link (a 24h refresh expired mid-session, the refetch timed
// out, and the error replaced the good value). We only (re)fetch when we have no
// good value yet, retrying on a short cadence so a fresh model self-heals fast.
const MODEL_LIMIT_RETRY_SEC = 60;
const modelLimits = new Map<string, ModelWindowResult>();
const limitInFlight = new Set<string>();

function cfg() {
  const c = vscode.workspace.getConfiguration("ccStatusbar");
  return {
    enabled: c.get<boolean>("enabled", true),
    refreshSeconds: c.get<number>("refreshSeconds", 10),
    alignment: c.get<string>("alignment", "right"),
    weights: {
      cacheRead: c.get<number>("cacheReadWeight", 0.1),
      cacheWrite: c.get<number>("cacheWriteWeight", 1.25),
    } as Weights,
    quotaEnabled: c.get<boolean>("quota.enabled", true),
    minPollSeconds: c.get<number>("quota.minPollSeconds", 300),
    credentialsPath: c.get<string>("credentialsPath", ""),
    language: c.get<LangSetting>("language", "auto"),
    provider: normalizeProviderMode(c.get<string>("provider", "auto")),
    codexCommandPath: c.get<string>("codex.commandPath", ""),
    contextEnabled: c.get<boolean>("context.enabled", true),
    modelEnabled: c.get<boolean>("model.enabled", true),
    subagentsEnabled: c.get<boolean>("subagents.enabled", true),
  };
}

// ── model identity ───────────────────────────────────────────────────────────
// A change notice stays up until the NEXT confirmed turn — not for N seconds.
// A wall clock would quietly expire while the user is away from the keyboard,
// which is exactly when a switch goes unnoticed; "until the model speaks again"
// is both deterministic and impossible to miss.
interface IdentityChange {
  from: string;
  to: string;
  /** Turn the change was first seen on. Cleared once a LATER turn appears. */
  turnId: string | null;
}

/** Last CONFIRMED identity for the current workspace, persisted so a window
 *  reload neither re-fires nor loses a pending change notice. */
interface IdentityState {
  modelId: string | null;
  effort: string | null;
  modelChange: IdentityChange | null;
  effortChange: IdentityChange | null;
}
let identity: IdentityState = { modelId: null, effort: null, modelChange: null, effortChange: null };
let identityCwd: string | null = null;

function identityKey(cwd: string): string {
  return `identity:${cwd}`;
}

function saveIdentity(cwd: string): void {
  void extCtx?.globalState.update(identityKey(cwd), identity);
}

/** Pretty label for a model id, preferring Anthropic's own display name from
 *  the /v1/models response we already cache for the context-window limit. */
function labelFor(id: string | null): string | null {
  if (!id) return null;
  return shortModelLabel(id, modelLimits.get(id)?.displayName ?? null);
}

/** Which model is in play, and with what provenance.
 *
 *  CONFIRMED wins whenever the newest transcript has a real turn — including for
 *  a RESUMED session, whose transcript already exists (downgrading a known fact
 *  to an expectation just because the process restarted would lose information).
 *  The PLANNED value describes only chats that have never answered: those are
 *  identified by a live registry entry with no transcript file at all.
 *
 *  When such an unanswered chat sits beside an active one, the bar cannot know
 *  which tab is focused (VS Code has no API for it), so it names the other chat's
 *  model instead of silently picking one — but only when the two differ, so the
 *  line stays quiet whenever nothing can go wrong. */
function buildModelView(
  ctxInfo: ContextInfo,
  cwd: string,
  enabled: boolean
): ModelView | undefined {
  if (!enabled) return undefined;

  // A workspace switch (new window/folder) must not inherit another folder's
  // identity — that would fire a phantom "model changed".
  if (identityCwd !== cwd) {
    identityCwd = cwd;
    identity = extCtx?.globalState.get<IdentityState>(identityKey(cwd)) ?? {
      modelId: null,
      effort: null,
      modelChange: null,
      effortChange: null,
    };
  }

  const chats = readOpenChats(cwd);
  const actualId = isRealModelId(ctxInfo.modelId) ? (ctxInfo.modelId as string) : null;

  // What an unanswered chat would start on (null when there is no such chat).
  const plannedModel = chats.unanswered.length ? readPlannedModel(cwd) : null;
  const plannedEffort = chats.unanswered.length ? readPlannedEffort(cwd) : null;

  if (!actualId) {
    // Nothing has answered here at all → the plan is all there is to show.
    const planned = plannedModel ?? readPlannedModel(cwd);
    const effort = plannedEffort ?? readPlannedEffort(cwd);
    const label = shortModelLabel(planned.id);
    return planned.id
      ? { label, state: "planned", effort }
      : { label: null, state: "planned-default", effort };
  }

  const label = labelFor(actualId);
  const effort = ctxInfo.effort;
  const turnId = ctxInfo.turnId;

  // A notice is raised on the first turn that shows the new value, and cleared
  // as soon as a LATER turn confirms the user has moved on.
  if (actualId !== identity.modelId) {
    const from = labelFor(identity.modelId);
    // The first observation ever has nothing to compare against → stay silent.
    if (from && label && from !== label) identity.modelChange = { from, to: label, turnId };
    identity.modelId = actualId;
    saveIdentity(cwd);
  } else if (identity.modelChange && identity.modelChange.turnId !== turnId) {
    identity.modelChange = null;
    saveIdentity(cwd);
  }
  if (effort && effort !== identity.effort) {
    if (identity.effort) identity.effortChange = { from: identity.effort, to: effort, turnId };
    identity.effort = effort;
    saveIdentity(cwd);
  } else if (identity.effortChange && identity.effortChange.turnId !== turnId) {
    identity.effortChange = null;
    saveIdentity(cwd);
  }

  // Only warn about the other chat when it would actually run something else.
  const pendingLabel = plannedModel?.id ? shortModelLabel(plannedModel.id) : null;
  const pending = chats.unanswered.length && pendingLabel !== label ? pendingLabel : null;

  return {
    label,
    state: "actual",
    changedFrom: identity.modelChange?.to === label ? identity.modelChange.from : null,
    effort,
    effortChangedFrom: identity.effortChange?.to === effort ? identity.effortChange.from : null,
    pendingLabel: pending,
  };
}

/** Reduce the raw subagent records to display data (labels + one comparable
 *  token number), newest first — transcript.ts already sorts them. */
function buildSubagentViews(subagents: SubagentInfo[], weights: Weights): SubagentView[] {
  return subagents
    .map((a) => ({
      agentType: a.agentType,
      description: a.description,
      modelId: a.model,
      modelLabel: labelFor(a.model),
      effort: a.effort,
      spawnDepth: a.spawnDepth,
      effective: effectiveTokens(a.totals, weights),
    }))
    // Most expensive first: this list answers "where did my tokens go", so the
    // biggest spender must never fall below the display cap.
    .sort((a, b) => b.effective - a.effective);
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function noticePanelHtml(title: string, body: string, lang: Lang): string {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 14px 18px; font-size: 13px; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  p { opacity: .8; line-height: 1.45; }
</style>
</head>
<body>
  <h2>${escHtml(title)}</h2>
  <p>${escHtml(body)}</p>
</body>
</html>`;
}

function showProviderNotice(selection: Exclude<ProviderSelection, { kind: "selected" }>, lang: Lang): void {
  const m = messages(lang);
  if (selection.kind === "conflict") {
    item.text = m.providerConflictText;
    const md = new vscode.MarkdownString(m.providerConflictTooltip);
    md.isTrusted = { enabledCommands: TRUSTED_COMMANDS };
    md.supportHtml = true;
    item.tooltip = md;
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    item.show();
    if (panel) {
      panel.title = m.chooseProvider;
      panel.webview.html = noticePanelHtml(m.chooseProvider, m.providerConflictTooltip.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"), lang);
    }
    return;
  }

  const provider = m.providerNames[selection.provider];
  const detail = selection.provider === "codex" ? m.providerDescriptions.codex : selection.detail;
  item.text = m.providerUnavailableText(provider);
  const md = new vscode.MarkdownString(m.providerUnavailableTooltip(provider, detail));
  md.isTrusted = { enabledCommands: TRUSTED_COMMANDS };
  md.supportHtml = true; // the selected provider/language is highlighted with an inline span
  item.tooltip = md;
  item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  item.show();
  if (panel) {
    panel.title = provider;
    panel.webview.html = noticePanelHtml(m.providerUnavailableText(provider).replace("$(warning) ", ""), detail, lang);
  }
}

function plainNoticeText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/_/g, "")
    .replace(/^-\s+/gm, "• ");
}

function providerChoicesMarkdown(
  m: ReturnType<typeof messages>,
  selectedMode: ProviderMode,
  workingProvider: UsageProviderKind | null
): string {
  // The dot is a DIFFERENT signal from the check: it means "this source has data
  // right now", not "this one is selected".
  const dot = (kind: UsageProviderKind): string => (workingProvider === kind ? "🟢 " : "");
  return choicesMarkdown<ProviderMode>(m.chooseProvider, selectedMode, [
    { value: "auto", label: m.providerNames.auto, command: "ccStatusbar.useAuto" },
    { value: "claude", label: `${dot("claude")}${m.providerNames.claude}`, command: "ccStatusbar.useClaude" },
    { value: "codex", label: `${dot("codex")}${m.providerNames.codex}`, command: "ccStatusbar.useCodex" },
  ]);
}

function languageChoicesMarkdown(m: ReturnType<typeof messages>, selected: LangSetting): string {
  return choicesMarkdown<LangSetting>(m.languageChoicesHeader, selected, [
    { value: "auto", label: m.languageNames.auto, command: "ccStatusbar.useLanguageAuto" },
    { value: "ru", label: m.languageNames.ru, command: "ccStatusbar.useLanguageRu" },
    { value: "en", label: m.languageNames.en, command: "ccStatusbar.useLanguageEn" },
  ]);
}

/** Resolve the cached context-window limit for a model, kicking off a
 *  background fetch when missing/stale. Never blocks the UI tick. */
function ensureModelLimit(id: string, credentialsPath: string, nowSec: number): ModelWindowResult | null {
  const cached = modelLimits.get(id) || null;
  const haveGood = cached?.state === "ok" && !!cached.maxInputTokens;
  // Refetch ONLY when we have no good value yet (a good one is immutable → kept
  // forever). Without one, retry on a short cadence for weak-link resilience.
  const lastTrySec = cached?.fetchedAtSec ?? 0;
  const needFetch = !haveGood && nowSec - lastTrySec >= MODEL_LIMIT_RETRY_SEC;
  if (needFetch && !limitInFlight.has(id)) {
    limitInFlight.add(id);
    fetchModelWindow(id, credentialsPath, nowSec)
      .then((r) => {
        if (r.state === "ok" && r.maxInputTokens) {
          modelLimits.set(id, r);
          void extCtx?.globalState.update(`modelWindow:${id}`, r); // persist ONLY good values
        } else {
          // Failed fetch: never overwrite a good value, never persist an error.
          // Keep the good one if present; otherwise record the attempt in memory
          // so the retry cadence advances.
          modelLimits.set(id, cached?.state === "ok" ? cached : r);
        }
      })
      .finally(() => limitInFlight.delete(id));
  }
  return modelLimits.get(id) || null;
}

/** Map transcript context + model-limit cache into a render ContextView. */
function buildContextView(
  ctxInfo: ContextInfo,
  contextEnabled: boolean,
  credentialsPath: string,
  nowSec: number
): ContextView | undefined {
  if (!contextEnabled) return undefined;
  const usedTokens = ctxInfo.tokens;
  if (!ctxInfo.modelId) {
    // no model id yet (e.g. empty transcript) — show used only if we somehow
    // have it, but with no way to resolve a limit it stays pending.
    return { usedTokens, limitTokens: null, limitState: "pending" };
  }
  const cached = ensureModelLimit(ctxInfo.modelId, credentialsPath, nowSec);
  // 1) Live API value is authoritative when we have it.
  if (cached?.state === "ok" && cached.maxInputTokens) {
    return { usedTokens, limitTokens: cached.maxInputTokens, limitState: "ok" };
  }
  // 2) No live value yet → use the built-in known window so the context % shows
  // INSTANTLY and fully offline (the background fetch above overrides it once it
  // succeeds). This is why context works on a weak link where the live fetch may
  // not: known models never need the network at all.
  const known = knownModelWindow(ctxInfo.modelId);
  if (known) return { usedTokens, limitTokens: known, limitState: "ok" };
  // 3) Truly unknown model: no fetch yet → pending; a definitive fetch failure →
  // fail visibly with the reason (so a real problem is reportable).
  if (!cached) return { usedTokens, limitTokens: null, limitState: "pending" };
  return { usedTokens, limitTokens: null, limitState: "unavailable", limitDetail: cached.detail };
}

function workspaceCwd(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) return folders[0].uri.fsPath;
  return null;
}

function workspaceResource(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function codexQuotaWindow(w: { usedPercent: number; resetsAt: number | null } | null | undefined) {
  return w ? { pct: w.usedPercent, resetAt: w.resetsAt } : null;
}

function quotaFromCodex(result: CodexAppServerResult | null): QuotaView {
  if (!result || result.state !== "ok" || !result.rateLimits) {
    return { fiveH: null, sevenD: null, state: "error" };
  }
  const windows = [result.rateLimits.primary, result.rateLimits.secondary];
  const fiveH = windows.find((w) => w?.windowDurationMins === 300);
  const sevenD = windows.find((w) => w?.windowDurationMins === 10080);
  return {
    fiveH: codexQuotaWindow(fiveH),
    sevenD: codexQuotaWindow(sevenD),
    state: fiveH || sevenD ? "ok" : "error",
  };
}

function renderCodex(nowSec: number, lang: Lang, conf: ReturnType<typeof cfg>, cwd: string): void {
  codexTokenWatcher?.ensureStarted(conf.codexCommandPath);
  if (!codexInFlight && (!lastCodex || nowSec - lastCodexFetchSec >= conf.minPollSeconds)) {
    codexInFlight = true;
    fetchCodexAppServerStatus(nowSec, 12000, { commandPath: conf.codexCommandPath, workspacePath: cwd })
      .then((r) => {
        lastCodex = r;
        lastCodexFetchSec = r.fetchedAtSec;
        logDiagnostics("Codex app-server", codexDiagnostics(r));
      })
      .finally(() => {
        codexInFlight = false;
        void tick();
      });
  }

  const diagnostics =
    lastCodex?.diagnostics?.slice() ||
    (codexInFlight ? ["app-server request in progress"] : ["app-server has not returned data yet"]);
  if (lastCodex?.state === "error") diagnostics.unshift(lastCodex.detail);
  const planType =
    lastCodex?.state === "ok" ? lastCodex.rateLimits?.planType || lastCodex.account?.planType || null : null;
  const codexQuota = quotaFromCodex(lastCodex);
  const codexThread = observedCodexThread(cwd);
  const codexThreadId = codexThread?.id || null;
  const codexUsage = readCodexRolloutTokenUsage(codexThread) || codexTokenWatcher?.latestForThread(codexThreadId) || null;
  const codexIdentity = readCodexRolloutIdentity(codexThread);
  const codexModelView: ModelView | undefined =
    conf.modelEnabled && codexIdentity
      ? {
          label: shortCodexModelLabel(codexIdentity.model),
          state: "actual",
          effort: codexIdentity.effort,
        }
      : undefined;
  const codexContextView = codexContext(codexUsage);
  const codexCacheView = codexCache(codexUsage);
  const codexUsageView = codexUsage
    ? {
        totalTokens: codexUsage.total.totalTokens,
        lastTokens: codexUsage.last.totalTokens,
        inputTokens: codexUsage.total.inputTokens,
        cachedInputTokens: codexUsage.total.cachedInputTokens,
        outputTokens: codexUsage.total.outputTokens,
        reasoningOutputTokens: codexUsage.total.reasoningOutputTokens,
      }
    : null;
  const contextState = codexContextView ? undefined : ("waiting" as const);
  const cacheState = codexCacheView ? undefined : ("waiting" as const);
  logDiagnostics("Codex token usage watcher", codexTokenWatcher?.diagnosticLines() || []);
  const view = buildCodexQuotaView(codexQuota, nowSec, lang, {
    source: lastCodex?.state === "ok" ? lastCodex.source : null,
    planType,
    userAgent: lastCodex?.state === "ok" ? lastCodex.userAgent : null,
    model: codexModelView,
    thread: codexThread,
    context: codexContextView,
    contextState,
    cache: codexCacheView,
    cacheState,
    weights: conf.weights,
    usage: codexUsageView,
    diagnostics: [...diagnostics, ...(codexTokenWatcher?.diagnosticLines() || [])],
  });

  item.text = view.text;
  const m = messages(lang);
  const workingProvider = codexQuota.state === "ok" ? "codex" : null;
  const md = new vscode.MarkdownString(
    `${view.tooltip}\n\n${providerChoicesMarkdown(m, conf.provider, workingProvider)}\n\n${languageChoicesMarkdown(m, conf.language)}`
  );
  md.isTrusted = { enabledCommands: TRUSTED_COMMANDS };
  md.supportHtml = true; // the selected provider/language is highlighted with an inline span
  item.tooltip = md;
  item.backgroundColor =
    view.level === "over"
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : view.level === "tight"
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
  item.show();

  if (panel) {
    panel.title = m.codexPanelTitle;
    panel.webview.html = buildCodexPanelHtml(codexQuota, nowSec, lang, {
      source: lastCodex?.state === "ok" ? lastCodex.source : null,
      planType,
      userAgent: lastCodex?.state === "ok" ? lastCodex.userAgent : null,
      model: codexModelView,
      thread: codexThread,
      context: codexContextView,
      contextState,
      cache: codexCacheView,
      cacheState,
      weights: conf.weights,
      usage: codexUsageView,
      diagnostics: [...diagnostics, ...(codexTokenWatcher?.diagnosticLines() || [])],
    });
  }
}

async function tick() {
  // Consume the click's override HERE, before any early return: a flag left set
  // by a tick that bailed out (no folder, Codex provider, quota disabled) would
  // silently arm the next automatic tick with a second, unasked-for request.
  const forced = forceRefresh;
  forceRefresh = false;
  // The click's authority, handed to the paid fallback by a failed forced free
  // poll (see forceQuotaOnce). Consumed here for the same reason as above.
  // Kept distinct from `forced`: only the FALLBACK may be re-armed, and only the
  // fallback describes a click that has so far produced nothing.
  const forcedFallback = forceQuotaOnce;
  forceQuotaOnce = false;
  const forcedPaid = forced || forcedFallback;

  const conf = cfg();
  if (!conf.enabled) {
    item.backgroundColor = undefined;
    item.hide();
    return;
  }
  const lang = resolveLang(conf.language, vscode.env.language);
  const m = messages(lang);
  const cwd = workspaceCwd();
  if (!cwd) {
    item.text = m.noFolder;
    item.tooltip = m.noFolderTip;
    item.backgroundColor = undefined;
    item.show();
    return;
  }

  const { totals, mtimeMs, context, cacheTier, cacheHitRatePct, leadTotals, subagents } = readSessionTotals(cwd);
  const nowSec = Math.floor(Date.now() / 1000);
  if (conf.provider === "auto") refreshCodexThread(nowSec, conf, cwd);

  const codexThread = observedCodexThread(cwd);
  const claudeActivityMs = mtimeMs > 0 ? mtimeMs : null;
  const codexActivityMs = codexThreadActivityMs(codexThread);
  const nowMs = nowSec * 1000;
  const fallbackProvider =
    newestActivityProvider([
      { provider: "claude", lastActivityMs: claudeActivityMs },
      { provider: "codex", lastActivityMs: codexActivityMs },
    ]) || "claude";

  const selection = resolveProvider({
    mode: conf.provider,
    candidates: [
      {
        provider: "claude",
        available: true,
        activity: providerActivity(
          "claude",
          isRecentProviderActivity(claudeActivityMs, nowMs),
          claudeActivityMs,
          claudeActivityMs ? "recent workspace transcript" : "no workspace transcript"
        ),
      },
      {
        provider: "codex",
        available: true,
        activity: providerActivity(
          "codex",
          isRecentProviderActivity(codexActivityMs, nowMs),
          codexActivityMs,
          codexActivityMs ? "recent workspace thread" : "no matching thread"
        ),
      },
    ],
    fallbackProvider,
  });
  if (selection.kind !== "selected") {
    showProviderNotice(selection, lang);
    return;
  }
  if (selection.provider === "codex") {
    renderCodex(nowSec, lang, conf, cwd);
    return;
  }

  const contextView = buildContextView(context, conf.contextEnabled, conf.credentialsPath, nowSec);
  const cacheView: CacheView = { tier: cacheTier, hitRatePct: cacheHitRatePct };

  // quota: throttled + activity-gated; never blocks the UI tick
  let quotaView: QuotaView;
  if (!conf.quotaEnabled) {
    quotaView = { fiveH: null, sevenD: null, state: "disabled" };
  } else {
    // ── Source 0: the usage payload — the ONLY live source of the per-model
    // weekly windows (Fable), and a free superset of the header poll below.
    //
    // Polled on a FIXED CADENCE, active or idle. It is a plain GET costing zero
    // tokens, so the activity gate that (rightly) guards the paid poll below
    // bought nothing here and cost everything: the numbers stopped moving the
    // moment the human stopped typing — exactly when a long autonomous run is
    // spending the quota they want to watch.
    //
    // Another window may have just fetched the same number: the shared file is
    // consulted first, so N open editors still produce ONE request per interval.
    const credFile = resolveCredentialsPath(conf.credentialsPath);
    // Switching credentials switches ACCOUNT. Everything remembered about the
    // old one — in memory and in globalState — describes a different
    // subscription, and keeping it would put the previous account's percentages
    // on this account's bar until a fresh reading happened to beat them on
    // timestamp. The on-disk share is already account-keyed; this is the same
    // rule applied to our own state.
    // Compared by ACCOUNT KEY, not by raw string: the key canonicalizes case,
    // separators and symlinks, so merely respelling the same path in settings
    // must not be mistaken for a new account and throw away good readings.
    if (activeCredFile !== null && accountKey(activeCredFile) !== accountKey(credFile)) {
      forgetQuotaState(activeCredFile);
    }
    activeCredFile = credFile;
    const shared = readSharedUsage(credFile);
    // Sources 2 and 3 below are the DEFAULT account's files by construction:
    // Claude Code writes them for whoever it is signed in as, with no way to ask
    // for another. When this window has been pointed at a different credentials
    // file, they describe someone else's subscription — so they are not read at
    // all rather than merged into this account's numbers.
    const defaultAccount = !conf.credentialsPath.trim();
    const usageThrottleSec =
      usageFailStreak > 0 && usageFailStreak <= USAGE_FAST_RETRIES
        ? Math.min(conf.minPollSeconds, FAIL_RETRY_SEC)
        : conf.minPollSeconds + POLL_JITTER_SEC;
    // Treat someone else's fetch as if it were ours for gating purposes. 0 when
    // the shared file is absent, unusable, or dated in the future (see
    // usableSharedAtSec — a bogus date must not be able to silence this window).
    const sharedGateSec = usableSharedAtSec(shared, nowSec);
    const usageGateSec = Math.max(lastUsageFetchSec, sharedGateSec);
    // A click that lands while a request is already running must not evaporate:
    // the flag was consumed at the top of this tick, so hand it to the next one
    // instead. The in-flight request's own completion re-ticks, so the wait is
    // bounded by that request, not by the refresh timer.
    if (usageInFlight && forced) forceRefresh = true;
    // Last gate, and the only one that can see the OTHER windows: taken just
    // before the request, because the shared file is written only when one
    // COMPLETES — the seconds in between are exactly when simultaneous starts
    // happen, and on a common cadence they would keep happening. Evaluated last
    // so a claim is never taken by a tick that then decides not to poll.
    const claim =
      !usageInFlight && shouldPollFree(usageGateSec, nowSec, usageThrottleSec, usageBackoffUntilSec, forced)
        ? claimUsagePoll(credFile, nowSec)
        : null;
    if (claim) {
      usageInFlight = true;
      lastUsageFetchSec = nowSec;
      fetchUsage(conf.credentialsPath, nowSec)
        .then((r) => {
          // The account may have been switched while this was in the air. Its
          // answer describes the OLD subscription, so applying it would undo the
          // wipe and put the previous account's percentages back on the bar.
          if (credFile !== activeCredFile) return;
          lastUsage = r;
          lastUsageFetchSec = r.fetchedAtSec;
          usageFailStreak = r.state === "ok" ? 0 : usageFailStreak + 1;
          // A click that reached only this route and got nothing must not end in
          // silence: hand its authority to the paid fallback for the next tick.
          if (forced && r.state !== "ok") forceQuotaOnce = true;
          if (r.state === "rate-limited") {
            // Capped, unlike the paid route below: see USAGE_BACKOFF_MAX_SEC.
            usageBackoffUntilSec = backoffUntil(
              nowSec,
              parseRetryAfterSec(r.detail, nowSec),
              conf.minPollSeconds,
              USAGE_BACKOFF_MAX_SEC
            );
          } else if (r.state === "ok") {
            usageBackoffUntilSec = 0; // the route answered → whatever it objected to is over
          }
          // Keep the last GOOD scoped reading: a momentary failure must not blank
          // a row whose number is still perfectly usable (its age is shown).
          if (r.state === "ok" && r.scoped.length) {
            lastGoodUsage = { scoped: r.scoped, atSec: r.fetchedAtSec };
            void extCtx?.globalState.update(usageKey(credFile), lastGoodUsage);
          }
          // Publish for the other windows — only a real reading, never a failure.
          if (r.state === "ok") {
            writeSharedUsage(credFile, { fiveH: r.fiveH, sevenD: r.sevenD, scoped: r.scoped }, r.fetchedAtSec);
          }
          if (r.state !== "ok") {
            logDiagnostics("Claude usage", [`state: ${r.state}`, r.detail ? `detail: ${r.detail}` : ""]);
          }
        })
        .finally(() => {
          usageInFlight = false;
          releaseUsagePoll(credFile, claim); // hand the interval back before its TTL
          void tick(); // paint the new number now, not up to refreshSeconds later
        });
    }

    // ── Source 1: header poll — UNCHANGED in mechanics (same throttle, activity
    // gate, timeouts, retries) and still the safety net. It is SKIPPED only
    // while the free payload above is demonstrably doing its job — i.e. it
    // answered within the last interval WITH 5h/7d — because it costs ~1 token
    // per poll to learn the very same two numbers. The moment the payload route
    // fails or stops carrying them, this poll resumes by itself.
    // Throttle: normally minPollSeconds, but only FAIL_RETRY_SEC after a failed
    // poll so a flaky link recovers fast. The activity window stays at the
    // normal interval (a short retry gap must not shrink "is the user active?").
    const throttleSec = lastPollFailed
      ? Math.min(conf.minPollSeconds, FAIL_RETRY_SEC)
      : conf.minPollSeconds;
    // "Delivering" counts a reading from ANY window of this account, not just
    // one we fetched ourselves. A second editor window skips the free request
    // because the shared file is fresh — so judging coverage by our own
    // `lastUsage` alone would leave it permanently empty and send that window to
    // the PAID route every interval. N windows, N-1 needless paid polls, to
    // learn a number already sitting on disk.
    //
    // But a shared reading only counts while OUR OWN free route has not just
    // failed. Otherwise the invariant this whole fallback exists for — "the free
    // route dies, the paid one takes over" — would be defeated by our own last
    // success: the file we wrote minutes ago would keep vouching for a route
    // that is now down, for as long as it stayed young. `lastUsage` is null for
    // a window that never had to fetch (the case above), and an error only for
    // one that tried and failed.
    const maxAgeSec = conf.minPollSeconds * 2;
    const freeRouteFailing = lastUsage != null && lastUsage.state !== "ok";
    const covered =
      usageCoversQuota(lastUsage, nowSec, maxAgeSec) ||
      (!freeRouteFailing && coversQuota(shared.fiveH, shared.sevenD, sharedGateSec, nowSec, maxAgeSec));
    // Rescue only the FALLBACK authority, never the click itself: a click whose
    // free poll is healthy has no business here, and re-arming it would buy a
    // second paid request out of one press.
    if (inFlight && forcedFallback) forceQuotaOnce = true;
    if (
      !inFlight &&
      // Coverage is NOT bypassed for a click. A click asks for fresh numbers,
      // and while the free route is delivering them it already provides exactly
      // that — spending a token to re-learn the same two figures would be the
      // "free first, paid only on failure" rule broken by its own escape hatch.
      // The failure path reaches this line anyway: a failed forced free poll
      // marks the route as failing, which drops `covered` on the next tick.
      !covered &&
      shouldPoll(lastFetchSec, nowSec, throttleSec, mtimeMs, quotaBackoffUntilSec, conf.minPollSeconds, forcedPaid)
    ) {
      inFlight = true;
      fetchQuota(conf.credentialsPath, nowSec)
        .then((r) => {
          if (credFile !== activeCredFile) return; // answer for a former account
          lastQuota = r;
          lastFetchSec = r.fetchedAtSec;
          // a network/timeout failure → retry soon; success/429 → normal cadence
          lastPollFailed = r.state === "error";
          if (r.state === "rate-limited") {
            // This route SPENDS tokens, so its Retry-After is honoured verbatim —
            // no cap (contrast the free GET above).
            quotaBackoffUntilSec = backoffUntil(nowSec, parseRetryAfterSec(r.detail, nowSec), conf.minPollSeconds);
          } else if (r.state === "ok") {
            quotaBackoffUntilSec = 0;
          }
          // Surface quota fetch failures in the diagnostics log (previously only
          // Codex was logged) so a "limits stopped showing" report can be told
          // apart from a real break — e.g. a slow/unstable link timing the
          // request out shows up here as state: error.
          if (r.state !== "ok") {
            logDiagnostics("Claude quota", [`state: ${r.state}`, r.detail ? `detail: ${r.detail}` : ""]);
          }
        })
        .finally(() => {
          inFlight = false;
        });
    }

    // ── Source 2: local statusline bridge — zero network, cheap local read.
    // This is the SAME real server data Claude Code shows in its own usage view,
    // mirrored to a file by the companion statusline.py — so it stays available
    // on links too weak for our own poll to complete.
    const local = defaultAccount ? readLocalQuota() : { ok: false, fiveH: null, sevenD: null, writtenAtSec: 0 };

    // ── Source 3: Claude Code's own on-disk usage cache — zero network. Only a
    // FALLBACK now that we fetch the payload ourselves: it is refilled when the
    // CLI happens to fetch usage, so it can be hours old. It still earns its
    // place — it covers the first tick after a reload and any moment our request
    // cannot get through.
    const cached = defaultAccount
      ? readCachedUsage()
      : { ok: false, fiveH: null, sevenD: null, scoped: [], fetchedAtSec: 0 };

    // ── Merge: freshest valid reading wins, then persist as last-known. Strict
    // ">" so a tie never flip-flops; the network reading is preferred when it is
    // at least as fresh, the local one when it is newer.
    const candidates: GoodQuota[] = [];
    if (lastUsage?.state === "ok" && (lastUsage.fiveH || lastUsage.sevenD)) {
      candidates.push({ fiveH: lastUsage.fiveH, sevenD: lastUsage.sevenD, atSec: lastUsage.fetchedAtSec, source: "usage" });
    }
    if (lastQuota?.state === "ok" && (lastQuota.fiveH || lastQuota.sevenD)) {
      candidates.push({ fiveH: lastQuota.fiveH, sevenD: lastQuota.sevenD, atSec: lastQuota.fetchedAtSec, source: "network" });
    }
    if (local.ok) {
      candidates.push({ fiveH: local.fiveH, sevenD: local.sevenD, atSec: local.writtenAtSec, source: "local" });
    }
    if (cached.ok && (cached.fiveH || cached.sevenD)) {
      candidates.push({ fiveH: cached.fiveH, sevenD: cached.sevenD, atSec: cached.fetchedAtSec, source: "local" });
    }
    // The reading another editor window fetched — same server data, same clock,
    // so it competes on freshness like any other candidate. This is the half of
    // the cross-window share that pays it back: a window that skipped its own
    // request still shows the number the request that DID run brought home.
    // Future-dated readings are refused for a harsher reason than above: the
    // merge keeps the newest timestamp FOREVER (and persists it), so one bogus
    // date would pin the display to that reading permanently — nothing real
    // could ever out-freshen it again.
    if (sharedGateSec && (shared.fiveH || shared.sevenD)) {
      candidates.push({ fiveH: shared.fiveH, sevenD: shared.sevenD, atSec: sharedGateSec, source: "usage" });
    }
    let refreshed = false;
    for (const c of candidates) {
      if (!lastGoodQuota || c.atSec > lastGoodQuota.atSec) {
        lastGoodQuota = c;
        refreshed = true;
      }
    }
    if (refreshed) void extCtx?.globalState.update(quotaKey(credFile), lastGoodQuota);

    if (lastGoodQuota) {
      // We have a real reading (possibly last-known) → always show it. Never
      // blank when at least one source has ever succeeded.
      quotaView = {
        fiveH: lastGoodQuota.fiveH,
        sevenD: lastGoodQuota.sevenD,
        state: "ok",
        asOfSec: lastGoodQuota.atSec,
        source: lastGoodQuota.source,
      };
    } else {
      // Never had ANY reading yet → keep today's exact behavior: surface the
      // network state (drives the offline marker), or a generic error.
      quotaView = lastQuota
        ? { fiveH: lastQuota.fiveH, sevenD: lastQuota.sevenD, state: lastQuota.state }
        : { fiveH: null, sevenD: null, state: "error" };
    }
    // Per-model weekly windows are ADDITIVE — never merged into 5h/7d, and they
    // carry their own clock because their sources refresh on different
    // schedules. Freshest of {live payload, CLI's cache} wins.
    const scopedCandidates: Array<{ scoped: ScopedQuotaWindow[]; atSec: number }> = [];
    if (lastGoodUsage) scopedCandidates.push(lastGoodUsage);
    if (cached.ok && cached.scoped.length) scopedCandidates.push({ scoped: cached.scoped, atSec: cached.fetchedAtSec });
    if (sharedGateSec && shared.scoped.length) scopedCandidates.push({ scoped: shared.scoped, atSec: sharedGateSec });
    const bestScoped = scopedCandidates.sort((a, b) => b.atSec - a.atSec)[0];
    if (bestScoped) {
      quotaView.scoped = bestScoped.scoped;
      quotaView.scopedAsOfSec = bestScoped.atSec;
    }
    // Say WHY the number stopped moving while a 429 backoff is in force. Without
    // this the bar just quietly ages, and an unexplained stale reading is the
    // one failure mode nobody can report usefully.
    const pausedUntil = Math.max(usageBackoffUntilSec, quotaBackoffUntilSec);
    if (pausedUntil > nowSec) quotaView.pausedUntilSec = pausedUntil;
  }

  const modelView = buildModelView(context, cwd, conf.modelEnabled);
  const subagentViews = conf.subagentsEnabled ? buildSubagentViews(subagents, conf.weights) : [];
  const view = buildView(
    totals,
    conf.weights,
    quotaView,
    nowSec,
    lang,
    contextView,
    cacheView,
    modelView,
    subagentViews
  );
  item.text = view.text;
  const providerFooter =
    `_${m.providerTooltipLine(m.providerNames[conf.provider], m.providerNames.claude)}_` +
    `\n\n${providerChoicesMarkdown(m, conf.provider, "claude")}` +
    `\n\n${languageChoicesMarkdown(m, conf.language)}`;
  const md = new vscode.MarkdownString(`${view.tooltip}\n\n${providerFooter}`);
  // trusted so the tooltip's command links are clickable; only our own
  // ccStatusbar.* commands are referenced.
  md.isTrusted = { enabledCommands: TRUSTED_COMMANDS };
  md.supportHtml = true; // the selected provider/language is highlighted with an inline span
  item.tooltip = md;
  item.backgroundColor =
    view.level === "over"
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : view.level === "tight"
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
  item.show();

  // keep the (optional) persistent panel live
  if (panel) {
    panel.title = m.panelTitle;
    panel.webview.html = buildPanelHtml(
      totals,
      conf.weights,
      quotaView,
      nowSec,
      lang,
      contextView,
      cacheView,
      modelView,
      subagentViews,
      effectiveTokens(leadTotals, conf.weights)
    );
  }
}

function rebuildItem() {
  const conf = cfg();
  if (item) item.dispose();
  item = vscode.window.createStatusBarItem(
    conf.alignment === "left" ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right,
    100
  );
  item.command = "ccStatusbar.refresh";
}

async function setProviderMode(mode: ProviderMode): Promise<void> {
  const resource = workspaceResource();
  const c = vscode.workspace.getConfiguration("ccStatusbar", resource);
  const inspected = c.inspect("provider");
  const target =
    resource && inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await c.update("provider", mode, target);
  const lang = resolveLang(cfg().language, vscode.env.language);
  const m = messages(lang);
  vscode.window.setStatusBarMessage(m.providerSet(m.providerNames[mode]), 2000);
  void tick();
}

async function setLanguageMode(language: LangSetting): Promise<void> {
  await vscode.workspace
    .getConfiguration("ccStatusbar")
    .update("language", language, vscode.ConfigurationTarget.Global);
  void tick();
}

async function selectProviderMode(): Promise<void> {
  const conf = cfg();
  const lang = resolveLang(conf.language, vscode.env.language);
  const m = messages(lang);
  const cwd = workspaceCwd();
  const claudeWorking = cwd ? readSessionTotals(cwd).mtimeMs > 0 : false;
  const codexWorking = lastCodex?.state === "ok" && quotaFromCodex(lastCodex).state === "ok";
  const label = (mode: ProviderMode): string => {
    const selected = conf.provider === mode ? "$(check) " : "";
    const working =
      (mode === "claude" && claudeWorking) || (mode === "codex" && codexWorking) ? "🟢 " : "";
    return `${selected}${working}${m.providerNames[mode]}`;
  };
  const items: Array<vscode.QuickPickItem & { value: ProviderMode }> = [
    { label: label("auto"), description: m.providerDescriptions.auto, value: "auto" },
    { label: label("claude"), description: m.providerDescriptions.claude, value: "claude" },
    { label: label("codex"), description: m.providerDescriptions.codex, value: "codex" },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: m.providerSelectPlaceholder,
  });
  if (pick) await setProviderMode(pick.value);
}

export function activate(context: vscode.ExtensionContext) {
  extCtx = context;
  diagnosticsChannel = vscode.window.createOutputChannel("CC Statusbar");
  codexTokenWatcher = new CodexTokenUsageWatcher(() => void tick());
  // hydrate persisted model-window limits so a restart doesn't refetch.
  try {
    for (const k of context.globalState.keys()) {
      if (!k.startsWith("modelWindow:")) continue;
      const r = context.globalState.get<ModelWindowResult>(k);
      // Only restore GOOD values. A persisted error (from the old overwrite bug)
      // is ignored so it can't keep the context % hidden — we refetch instead.
      if (r && typeof r.id === "string" && r.state === "ok" && r.maxInputTokens) {
        modelLimits.set(r.id, r);
      }
    }
  } catch {
    /* globalState.keys() unavailable on very old VS Code — fine, refetch lazily */
  }
  // hydrate the last-known quota so a reload/update shows the limits immediately
  // instead of blanking until the first successful poll (the exact "stopped
  // showing after the update" symptom this guards against).
  try {
    const conf = cfg();
    const credFile = resolveCredentialsPath(conf.credentialsPath);
    activeCredFile = credFile;
    // Restore only what belongs to THIS account. The pre-1.0.23 unscoped keys
    // are NOT read: they were written under whatever credentials were set at the
    // time, so "the setting is empty now" does not prove they came from the
    // default account — and nothing is lost by dropping them, because the free
    // route now polls on the very first tick instead of waiting for activity.
    //
    // Age-bounded as well. Re-signing in as a different account reuses the same
    // credentials file, so the key cannot tell the two apart; a short bound
    // keeps that blind spot to minutes. It costs nothing — this value exists
    // only to avoid a blank line across a reload, and anything older than this
    // is replaced by the first poll anyway.
    const HYDRATE_MAX_AGE_SEC = 30 * 60;
    const nowSec = Math.floor(Date.now() / 1000);
    const fresh = (atSec: unknown): boolean =>
      typeof atSec === "number" && atSec > 0 && nowSec - atSec < HYDRATE_MAX_AGE_SEC;
    const g = context.globalState.get<GoodQuota>(quotaKey(credFile));
    if (g && fresh(g.atSec) && (g.fiveH || g.sevenD)) lastGoodQuota = g;
    type GoodUsage = { scoped: ScopedQuotaWindow[]; atSec: number };
    const u = context.globalState.get<GoodUsage>(usageKey(credFile));
    if (u && fresh(u.atSec) && Array.isArray(u.scoped) && u.scoped.length) lastGoodUsage = u;
  } catch {
    /* fine — falls back to fetching fresh */
  }
  rebuildItem();

  context.subscriptions.push(
    vscode.commands.registerCommand("ccStatusbar.refresh", () => {
      // Zeroing the throttles is not enough on its own — the ACTIVITY window is
      // what used to swallow the click, so a user who had been away for five
      // minutes (i.e. anyone who clicks because the number looks stale) got no
      // request at all, just a repaint of the same figures. The explicit flag
      // overrides every gate for one tick instead.
      forceRefresh = true;
      // NOTE: the attempt timestamps are deliberately NOT zeroed. Zeroing them
      // was the old way to force a refetch, and keeping it would quietly disable
      // the new anti-spam floor — that floor measures "how long since the last
      // attempt", so an attempt time of 0 always reads as "long enough" and a
      // held-down click becomes one request per click.
      //
      // The 429 backoffs are not cleared either. The forced
      // poll goes through regardless (see shouldPoll/shouldPollFree), and if it
      // succeeds the handler clears them itself — but if the server is still
      // refusing, the automatic cadence must keep honouring what it said rather
      // than resume at full rate because someone clicked.
      lastCodexFetchSec = 0;
      lastCodexThreadRefreshSec = 0;
      void tick();
    }),
    vscode.commands.registerCommand("ccStatusbar.toggleQuota", async () => {
      const c = vscode.workspace.getConfiguration("ccStatusbar");
      const cur = c.get<boolean>("quota.enabled", true);
      await c.update("quota.enabled", !cur, vscode.ConfigurationTarget.Global);
      void tick();
    }),
    vscode.commands.registerCommand("ccStatusbar.switchLanguage", async () => {
      const items: Array<vscode.QuickPickItem & { value: LangSetting }> = [
        { label: "Auto", description: "follow the editor · язык редактора", value: "auto" },
        { label: "English", value: "en" },
        { label: "Русский", value: "ru" },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Status bar language · Язык строки состояния",
      });
      if (pick) {
        await vscode.workspace
          .getConfiguration("ccStatusbar")
          .update("language", pick.value, vscode.ConfigurationTarget.Global);
        void tick();
      }
    }),
    vscode.commands.registerCommand("ccStatusbar.openPanel", () => {
      const lang = resolveLang(cfg().language, vscode.env.language);
      if (panel) {
        panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside);
      } else {
        panel = vscode.window.createWebviewPanel(
          "ccStatusbarUsage",
          messages(lang).panelTitle,
          { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
          { enableScripts: false, retainContextWhenHidden: true }
        );
        panel.onDidDispose(() => {
          panel = undefined;
        });
      }
      void tick(); // fill/refresh immediately
    }),
    vscode.commands.registerCommand("ccStatusbar.selectProvider", () => {
      void selectProviderMode();
    }),
    vscode.commands.registerCommand("ccStatusbar.useAuto", () => {
      void setProviderMode("auto");
    }),
    vscode.commands.registerCommand("ccStatusbar.useClaude", () => {
      void setProviderMode("claude");
    }),
    vscode.commands.registerCommand("ccStatusbar.useCodex", () => {
      void setProviderMode("codex");
    }),
    vscode.commands.registerCommand("ccStatusbar.useLanguageAuto", () => {
      void setLanguageMode("auto");
    }),
    vscode.commands.registerCommand("ccStatusbar.useLanguageEn", () => {
      void setLanguageMode("en");
    }),
    vscode.commands.registerCommand("ccStatusbar.useLanguageRu", () => {
      void setLanguageMode("ru");
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ccStatusbar")) {
        if (e.affectsConfiguration("ccStatusbar.codex.commandPath")) codexTokenWatcher?.dispose();
        rebuildItem();
        startTimer();
        void tick();
      }
    }),
    { dispose: () => codexTokenWatcher?.dispose() },
    { dispose: () => diagnosticsChannel?.dispose() },
    { dispose: () => item?.dispose() }
  );

  startTimer();
  void tick();
}

function startTimer() {
  if (timer) clearInterval(timer);
  const conf = cfg();
  timer = setInterval(() => void tick(), Math.max(3, conf.refreshSeconds) * 1000);
}

export function deactivate() {
  if (timer) clearInterval(timer);
  codexTokenWatcher?.dispose();
  diagnosticsChannel?.dispose();
  item?.dispose();
  panel?.dispose();
}
