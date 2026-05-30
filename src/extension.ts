// VS Code glue: wire transcript + quota + render into a StatusBarItem that
// refreshes on a timer. Keeps all fragile/IO logic in the imported modules.

import * as vscode from "vscode";
import { readSessionTotals } from "./transcript";
import { fetchQuota, shouldPoll, QuotaResult } from "./quota";
import { buildView, QuotaView } from "./render";
import { Weights } from "./metrics";

let item: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;

// quota state across ticks
let lastQuota: QuotaResult | null = null;
let lastFetchSec = 0;
let rateLimitedUntilSec = 0;
let inFlight = false;

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
  };
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
  const cwd = workspaceCwd();
  if (!cwd) {
    item.text = "$(pulse) cc: нет папки";
    item.tooltip = "Откройте папку проекта.";
    item.show();
    return;
  }

  const { totals, mtimeMs } = readSessionTotals(cwd);
  const nowSec = Math.floor(Date.now() / 1000);

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

  const view = buildView(totals, conf.weights, quotaView, nowSec);
  item.text = view.text;
  const md = new vscode.MarkdownString(view.tooltip);
  md.isTrusted = false;
  item.tooltip = md;
  item.backgroundColor =
    view.level === "over"
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : view.level === "tight"
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
  item.show();
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
}
