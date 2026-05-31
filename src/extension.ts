// VS Code glue: wire transcript + quota + render into a StatusBarItem that
// refreshes on a timer. Keeps all fragile/IO logic in the imported modules.

import * as vscode from "vscode";
import { readSessionTotals } from "./transcript";
import { fetchQuota, fetchModelWindow, shouldPoll, QuotaResult, ModelWindowResult } from "./quota";
import { buildView, buildPanelHtml, QuotaView, ContextView, CacheView } from "./render";
import { Weights, ContextInfo } from "./metrics";
import { resolveLang, messages, LangSetting } from "./i18n";

let item: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;
let panel: vscode.WebviewPanel | undefined;
let extCtx: vscode.ExtensionContext | undefined;

// quota state across ticks
let lastQuota: QuotaResult | null = null;
let lastFetchSec = 0;
let rateLimitedUntilSec = 0;
let inFlight = false;

// model context-window limits: cached per model id (limits don't change → 24h),
// persisted in globalState so a restart doesn't refetch. Errors retried sooner.
const MODEL_LIMIT_TTL_SEC = 24 * 3600;
const MODEL_LIMIT_RETRY_SEC = 600;
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
    contextEnabled: c.get<boolean>("context.enabled", true),
  };
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
  return { usedTokens, limitTokens: null, limitState: "unavailable" };
}

function workspaceCwd(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) return folders[0].uri.fsPath;
  return null;
}

async function tick() {
  const conf = cfg();
  if (!conf.enabled) {
    item.hide();
    return;
  }
  const lang = resolveLang(conf.language, vscode.env.language);
  const m = messages(lang);
  const cwd = workspaceCwd();
  if (!cwd) {
    item.text = m.noFolder;
    item.tooltip = m.noFolderTip;
    item.show();
    return;
  }

  const { totals, mtimeMs, context, cacheTier, cacheHitRatePct } = readSessionTotals(cwd);
  const nowSec = Math.floor(Date.now() / 1000);
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
  const md = new vscode.MarkdownString(view.tooltip);
  // trusted so the tooltip's command links are clickable; only our own
  // ccStatusbar.* commands are referenced.
  md.isTrusted = { enabledCommands: ["ccStatusbar.switchLanguage", "ccStatusbar.openPanel"] };
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

export function activate(context: vscode.ExtensionContext) {
  extCtx = context;
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
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ccStatusbar")) {
        rebuildItem();
        startTimer();
        void tick();
      }
    }),
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
  item?.dispose();
  panel?.dispose();
}
