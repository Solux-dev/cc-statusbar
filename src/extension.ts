// VS Code glue: wire transcript + quota + render into a StatusBarItem that
// refreshes on a timer. Keeps all fragile/IO logic in the imported modules.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { readSessionTotals } from "./transcript";
import { fetchQuota, fetchModelWindow, shouldPoll, QuotaResult, ModelWindowResult } from "./quota";
import {
  buildView,
  buildPanelHtml,
  buildCodexQuotaView,
  buildCodexPanelHtml,
  QuotaView,
  ContextView,
  CacheView,
} from "./render";
import { Weights, ContextInfo } from "./metrics";
import { resolveLang, messages, Lang, LangSetting } from "./i18n";
import { ProviderMode, ProviderSelection, UsageProviderKind } from "./providerTypes";
import {
  normalizeProviderMode,
  providerActivity,
  resolveProvider,
} from "./providerResolver";
import {
  CodexAppServerResult,
  CodexTokenUsageWatcher,
  fetchCodexAppServerStatus,
  readCodexRolloutTokenUsage,
} from "./codexAppServer";
import { codexCache, codexContext } from "./codexProvider";

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
let rateLimitedUntilSec = 0;
let inFlight = false;

let lastCodex: CodexAppServerResult | null = null;
let lastCodexFetchSec = 0;
let codexInFlight = false;
let codexTokenWatcher: CodexTokenUsageWatcher | undefined;

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

// model context-window limits: cached per model id (limits don't change → 24h),
// persisted in globalState so a restart doesn't refetch. Errors retried sooner.
const MODEL_LIMIT_TTL_SEC = 24 * 3600;
// Retry an errored/missing limit lookup soon so a transient first-fetch failure
// (e.g. a fresh install, a momentary network blip) self-heals within ~a minute
// instead of showing "(limit n/a)" for 10 minutes.
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
  };
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
  const choices: Array<{ mode: ProviderMode; command: string }> = [
    { mode: "auto", command: "ccStatusbar.useAuto" },
    { mode: "claude", command: "ccStatusbar.useClaude" },
    { mode: "codex", command: "ccStatusbar.useCodex" },
  ];
  const rendered = choices.map(({ mode, command }) => {
    const dot = workingProvider === mode ? "🟢 " : "";
    const label = `${dot}${m.providerNames[mode]}`;
    return selectedMode === mode ? `**${label}**` : `[${label}](command:${command})`;
  });
  return `**${m.chooseProvider}:** ${rendered.join(" · ")}`;
}

function languageChoicesMarkdown(m: ReturnType<typeof messages>, selected: LangSetting): string {
  const choices: Array<{ value: LangSetting; command: string }> = [
    { value: "auto", command: "ccStatusbar.useLanguageAuto" },
    { value: "ru", command: "ccStatusbar.useLanguageRu" },
    { value: "en", command: "ccStatusbar.useLanguageEn" },
  ];
  const rendered = choices.map(({ value, command }) => {
    const label = m.languageNames[value];
    return selected === value ? `**${label}**` : `[${label}](command:${command})`;
  });
  return `**${m.languageChoicesHeader}:** ${rendered.join(" · ")}`;
}

/** Resolve the cached context-window limit for a model, kicking off a
 *  background fetch when missing/stale. Never blocks the UI tick. */
function ensureModelLimit(id: string, credentialsPath: string, nowSec: number): ModelWindowResult | null {
  const cached = modelLimits.get(id) || null;
  const ttl = cached?.state === "ok" ? MODEL_LIMIT_TTL_SEC : MODEL_LIMIT_RETRY_SEC;
  const fresh = cached !== null && nowSec - cached.fetchedAtSec < ttl;
  if (!fresh && !limitInFlight.has(id)) {
    limitInFlight.add(id);
    fetchModelWindow(id, credentialsPath, nowSec)
      .then((r) => {
        modelLimits.set(id, r);
        void extCtx?.globalState.update(`modelWindow:${id}`, r);
      })
      .finally(() => limitInFlight.delete(id));
  }
  return cached;
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
  if (!cached) return { usedTokens, limitTokens: null, limitState: "pending" };
  if (cached.state === "ok" && cached.maxInputTokens) {
    return { usedTokens, limitTokens: cached.maxInputTokens, limitState: "ok" };
  }
  // definitive failure → fail visibly, and surface WHY (http code / reason) so a
  // user can tell a transient blip from a real problem when reporting.
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
  const codexThreadId = lastCodex?.state === "ok" ? lastCodex.thread?.id || null : null;
  const codexThread = lastCodex?.state === "ok" ? lastCodex.thread : null;
  const codexUsage = readCodexRolloutTokenUsage(codexThread) || codexTokenWatcher?.latestForThread(codexThreadId) || null;
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

  const { totals, mtimeMs, context, cacheTier, cacheHitRatePct } = readSessionTotals(cwd);
  const nowSec = Math.floor(Date.now() / 1000);

  const selection = resolveProvider({
    mode: conf.provider,
    candidates: [
      {
        provider: "claude",
        available: true,
        activity: providerActivity(
          "claude",
          mtimeMs > 0,
          mtimeMs > 0 ? mtimeMs : null,
          mtimeMs > 0 ? "workspace transcript found" : "no workspace transcript"
        ),
      },
      {
        provider: "codex",
        available: true,
        activity: providerActivity("codex", false, null, "app-server not connected"),
      },
    ],
    fallbackProvider: "claude",
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
    if (
      !inFlight &&
      shouldPoll(lastFetchSec, nowSec, conf.minPollSeconds, mtimeMs, rateLimitedUntilSec)
    ) {
      inFlight = true;
      fetchQuota(conf.credentialsPath, nowSec)
        .then((r) => {
          lastQuota = r;
          lastFetchSec = r.fetchedAtSec;
          if (r.state === "rate-limited") {
            const retry = Number(r.detail) || 60;
            rateLimitedUntilSec = nowSec + Math.max(retry, conf.minPollSeconds);
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
    quotaView = lastQuota
      ? { fiveH: lastQuota.fiveH, sevenD: lastQuota.sevenD, state: lastQuota.state }
      : { fiveH: null, sevenD: null, state: "error" };
  }

  const view = buildView(totals, conf.weights, quotaView, nowSec, lang, contextView, cacheView);
  item.text = view.text;
  const providerFooter =
    `_${m.providerTooltipLine(m.providerNames[conf.provider], m.providerNames.claude)}_` +
    `\n\n${providerChoicesMarkdown(m, conf.provider, "claude")}` +
    `\n\n${languageChoicesMarkdown(m, conf.language)}`;
  const md = new vscode.MarkdownString(`${view.tooltip}\n\n${providerFooter}`);
  // trusted so the tooltip's command links are clickable; only our own
  // ccStatusbar.* commands are referenced.
  md.isTrusted = { enabledCommands: TRUSTED_COMMANDS };
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
    panel.webview.html = buildPanelHtml(totals, conf.weights, quotaView, nowSec, lang, contextView, cacheView);
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
      if (r && typeof r.id === "string") modelLimits.set(r.id, r);
    }
  } catch {
    /* globalState.keys() unavailable on very old VS Code — fine, refetch lazily */
  }
  rebuildItem();

  context.subscriptions.push(
    vscode.commands.registerCommand("ccStatusbar.refresh", () => {
      lastFetchSec = 0; // force a quota refresh on manual click
      rateLimitedUntilSec = 0;
      lastCodexFetchSec = 0;
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
