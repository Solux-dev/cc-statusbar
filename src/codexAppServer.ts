import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface CodexRateLimitWindowSnapshot {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimitSnapshot {
  limitId: string | null;
  limitName?: string | null;
  primary: CodexRateLimitWindowSnapshot | null;
  secondary: CodexRateLimitWindowSnapshot | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

export interface CodexAccountSummary {
  type: string;
  planType?: string | null;
}

export interface CodexThreadSummary {
  id: string;
  name: string | null;
  preview: string | null;
  path: string | null;
  cwd: string | null;
  updatedAtSec: number | null;
  status: string | null;
  source: string | null;
  modelProvider: string | null;
  cliVersion: string | null;
  loaded: boolean;
}

export interface CodexTokenUsageBreakdownSnapshot {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexThreadTokenUsageSnapshot {
  total: CodexTokenUsageBreakdownSnapshot;
  last: CodexTokenUsageBreakdownSnapshot;
  modelContextWindow: number | null;
}

export interface CodexThreadTokenUsageUpdate {
  threadId: string;
  turnId: string;
  tokenUsage: CodexThreadTokenUsageSnapshot;
}

export interface CodexAppServerOk {
  state: "ok";
  fetchedAtSec: number;
  source: "proxy" | "stdio";
  userAgent: string | null;
  account: CodexAccountSummary | null;
  rateLimits: CodexRateLimitSnapshot | null;
  thread: CodexThreadSummary | null;
  diagnostics: string[];
}

export interface CodexAppServerError {
  state: "error";
  fetchedAtSec: number;
  detail: string;
  diagnostics: string[];
}

export type CodexAppServerResult = CodexAppServerOk | CodexAppServerError;

export interface CodexAppServerOptions {
  commandPath?: string;
  workspacePath?: string;
}

export interface CodexCommandResolution {
  command: string;
  source: "setting" | "env" | "openai-extension" | "npm" | "path";
  shell: boolean;
}

export interface JsonLineState {
  buffer: string;
}

export function buildCodexRequest(id: string | number, method: string, params?: unknown): Record<string, unknown> {
  const request: Record<string, unknown> = { id, method };
  if (params !== undefined) request.params = params;
  return request;
}

export function parseCodexJsonLines(state: JsonLineState, chunk: string): unknown[] {
  state.buffer += chunk;
  const messages: unknown[] = [];
  let idx = state.buffer.indexOf("\n");
  while (idx >= 0) {
    const line = state.buffer.slice(0, idx).trim();
    state.buffer = state.buffer.slice(idx + 1);
    if (line) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        // app-server can be wrapped by noisy launchers; ignore non-JSON lines.
      }
    }
    idx = state.buffer.indexOf("\n");
  }
  return messages;
}

export function isCodexResponseForId(message: unknown, id: string | number): boolean {
  if (!message || typeof message !== "object") return false;
  const m = message as Record<string, unknown>;
  return String(m.id) === String(id) && ("result" in m || "error" in m);
}

export function codexErrorDetail(message: unknown): string {
  if (!message || typeof message !== "object") return "unknown app-server error";
  const error = (message as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return "unknown app-server error";
  const e = error as Record<string, unknown>;
  const messageText = typeof e.message === "string" ? e.message : "app-server error";
  const code = e.code !== undefined ? ` (${String(e.code)})` : "";
  return `${messageText}${code}`;
}

function existsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function newestDirectory(root: string, prefix: string): string | null {
  let best: { path: string; mtimeMs: number } | null = null;
  try {
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith(prefix)) continue;
      const full = path.join(root, name);
      const st = fs.statSync(full);
      if (!st.isDirectory()) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs };
    }
  } catch {
    return null;
  }
  return best?.path || null;
}

function shellNeeded(command: string): boolean {
  const ext = path.extname(command).toLowerCase();
  return ext === ".cmd" || ext === ".bat" || ext === ".ps1";
}

export function resolveCodexCommand(commandPath?: string, env: NodeJS.ProcessEnv = process.env): CodexCommandResolution {
  const configured = (commandPath || "").trim();
  if (configured) return { command: configured, source: "setting", shell: shellNeeded(configured) };

  const envPath = (env.CODEX_CLI_PATH || "").trim();
  if (envPath) return { command: envPath, source: "env", shell: shellNeeded(envPath) };

  const vscodeExtensionsRoot = path.join(os.homedir(), ".vscode", "extensions");
  const openaiExt = newestDirectory(vscodeExtensionsRoot, "openai.chatgpt-");
  if (openaiExt) {
    const exe = path.join(openaiExt, "bin", "windows-x86_64", "codex.exe");
    if (existsFile(exe)) return { command: exe, source: "openai-extension", shell: false };
  }

  const appData = env.APPDATA;
  if (appData) {
    const npmCmd = path.join(appData, "npm", process.platform === "win32" ? "codex.cmd" : "codex");
    if (existsFile(npmCmd)) return { command: npmCmd, source: "npm", shell: shellNeeded(npmCmd) };
  }

  return { command: "codex", source: "path", shell: false };
}

export function selectCodexRateLimits(payload: unknown): CodexRateLimitSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, any>;
  const byLimitId = p.rateLimitsByLimitId;
  if (byLimitId && typeof byLimitId === "object" && byLimitId.codex) return byLimitId.codex;
  return p.rateLimits || null;
}

function accountSummary(payload: unknown): CodexAccountSummary | null {
  if (!payload || typeof payload !== "object") return null;
  const account = (payload as Record<string, any>).account;
  if (!account || typeof account !== "object" || typeof account.type !== "string") return null;
  return {
    type: account.type,
    planType: typeof account.planType === "string" ? account.planType : null,
  };
}

function resultOf(response: unknown): unknown {
  if (!response || typeof response !== "object") return null;
  return (response as Record<string, unknown>).result;
}

function conciseError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err || "unknown error");
}

function tokenBreakdown(payload: unknown): CodexTokenUsageBreakdownSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const totalTokens = numberOrNull(p.totalTokens);
  const inputTokens = numberOrNull(p.inputTokens);
  const cachedInputTokens = numberOrNull(p.cachedInputTokens);
  const outputTokens = numberOrNull(p.outputTokens);
  const reasoningOutputTokens = numberOrNull(p.reasoningOutputTokens);
  if (
    totalTokens == null ||
    inputTokens == null ||
    cachedInputTokens == null ||
    outputTokens == null ||
    reasoningOutputTokens == null
  ) {
    return null;
  }
  return { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens };
}

function tokenBreakdownFromRollout(payload: unknown): CodexTokenUsageBreakdownSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const totalTokens = numberOrNull(p.total_tokens);
  const inputTokens = numberOrNull(p.input_tokens);
  const cachedInputTokens = numberOrNull(p.cached_input_tokens);
  const outputTokens = numberOrNull(p.output_tokens);
  const reasoningOutputTokens = numberOrNull(p.reasoning_output_tokens);
  if (
    totalTokens == null ||
    inputTokens == null ||
    cachedInputTokens == null ||
    outputTokens == null ||
    reasoningOutputTokens == null
  ) {
    return null;
  }
  return { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens };
}

export function parseCodexTokenUsageNotification(message: unknown): CodexThreadTokenUsageUpdate | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.method !== "thread/tokenUsage/updated") return null;
  const params = m.params;
  if (!params || typeof params !== "object") return null;
  const p = params as Record<string, unknown>;
  const threadId = stringOrNull(p.threadId);
  const turnId = stringOrNull(p.turnId);
  const tokenUsage = p.tokenUsage;
  if (!threadId || !turnId || !tokenUsage || typeof tokenUsage !== "object") return null;
  const usage = tokenUsage as Record<string, unknown>;
  const total = tokenBreakdown(usage.total);
  const last = tokenBreakdown(usage.last);
  if (!total || !last) return null;
  const modelContextWindow = numberOrNull(usage.modelContextWindow);
  return { threadId, turnId, tokenUsage: { total, last, modelContextWindow } };
}

export function parseCodexRolloutTokenCount(message: unknown): CodexThreadTokenUsageSnapshot | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.type !== "event_msg") return null;
  const payload = m.payload;
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== "token_count") return null;
  const info = p.info;
  if (!info || typeof info !== "object") return null;
  const i = info as Record<string, unknown>;
  const total = tokenBreakdownFromRollout(i.total_token_usage);
  const last = tokenBreakdownFromRollout(i.last_token_usage);
  if (!total || !last) return null;
  const modelContextWindow = numberOrNull(i.model_context_window);
  return { total, last, modelContextWindow };
}

export function parseCodexRolloutTokenUsage(raw: string): CodexThreadTokenUsageSnapshot | null {
  let latest: CodexThreadTokenUsageSnapshot | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("\"token_count\"")) continue;
    try {
      latest = parseCodexRolloutTokenCount(JSON.parse(trimmed)) || latest;
    } catch {
      // Ignore partial/corrupt rollout lines; Codex appends JSONL while running.
    }
  }
  return latest;
}

const rolloutUsageCache = new Map<string, { mtimeMs: number; size: number; usage: CodexThreadTokenUsageSnapshot | null }>();

export function readCodexRolloutTokenUsage(thread: CodexThreadSummary | null | undefined): CodexThreadTokenUsageSnapshot | null {
  const filePath = thread?.path;
  if (!filePath) return null;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return null;
    const cached = rolloutUsageCache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.usage;
    const usage = parseCodexRolloutTokenUsage(fs.readFileSync(filePath, "utf8"));
    rolloutUsageCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, usage });
    return usage;
  } catch {
    return null;
  }
}

function resultDataArray(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as Record<string, unknown>).data;
  return Array.isArray(data) ? data : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statusName(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (!value || typeof value !== "object") return null;
  return stringOrNull((value as Record<string, unknown>).type);
}

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => path.normalize(s).replace(/[\\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function summarizeThread(thread: unknown, loadedIds: Set<string>): CodexThreadSummary | null {
  if (!thread || typeof thread !== "object") return null;
  const t = thread as Record<string, unknown>;
  const id = stringOrNull(t.id);
  if (!id) return null;
  return {
    id,
    name: stringOrNull(t.name),
    preview: stringOrNull(t.preview),
    path: stringOrNull(t.path),
    cwd: stringOrNull(t.cwd),
    updatedAtSec: numberOrNull(t.updatedAt),
    status: statusName(t.status),
    source: stringOrNull(t.source),
    modelProvider: stringOrNull(t.modelProvider),
    cliVersion: stringOrNull(t.cliVersion),
    loaded: loadedIds.has(id),
  };
}

class CodexProcessClient {
  private child: ChildProcessWithoutNullStreams;
  private lineState: JsonLineState = { buffer: "" };
  private stderr = "";
  private closed = false;
  private nextId = 1;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(
    private readonly command: CodexCommandResolution,
    private readonly args: string[],
    private readonly onNotification?: (message: unknown) => void,
    private readonly onClose?: (error: string | null) => void
  ) {
    this.child = spawn(command.command, args, { stdio: ["pipe", "pipe", "pipe"], shell: command.shell });
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-2000);
    });
    this.child.on("error", (err) => {
      this.closed = true;
      const error = `codex spawn failed: ${err.message}`;
      this.rejectAll(new Error(error));
      this.onClose?.(error);
    });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      const suffix = this.stderr.trim() ? `: ${this.stderr.trim()}` : "";
      const error = `codex app-server exited (${signal || code})${suffix}`;
      if (this.pending.size > 0) {
        this.rejectAll(new Error(error));
      }
      this.onClose?.(error);
    });
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = String(this.nextId++);
    const payload = JSON.stringify(buildCodexRequest(id, method, params)) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(payload, (err) => {
        if (!err) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new Error(`write failed: ${err.message}`));
      });
    });
  }

  close(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    if (!this.child.killed) this.child.kill();
  }

  isClosed(): boolean {
    return this.closed || this.child.killed;
  }

  private onStdout(chunk: Buffer): void {
    for (const message of parseCodexJsonLines(this.lineState, chunk.toString("utf8"))) {
      if (!message || typeof message !== "object") continue;
      const id = (message as Record<string, unknown>).id;
      if (id === undefined || id === null) {
        this.onNotification?.(message);
        continue;
      }
      const pending = this.pending.get(String(id));
      if (!pending || !isCodexResponseForId(message, String(id))) continue;
      clearTimeout(pending.timer);
      this.pending.delete(String(id));
      if ("error" in (message as Record<string, unknown>)) {
        pending.reject(new Error(codexErrorDetail(message)));
      } else {
        pending.resolve(message);
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export class CodexTokenUsageWatcher {
  private client: CodexProcessClient | null = null;
  private commandKey = "";
  private starting = false;
  private usageByThread = new Map<string, CodexThreadTokenUsageUpdate>();
  private diagnostics: string[] = [];

  constructor(private readonly onUpdate?: () => void) {}

  ensureStarted(commandPath?: string): void {
    const key = (commandPath || "").trim();
    if (this.client && !this.client.isClosed() && this.commandKey === key) return;
    if (this.starting && this.commandKey === key) return;
    this.dispose();
    this.commandKey = key;
    this.starting = true;
    void this.start(key);
  }

  latestForThread(threadId: string | null | undefined): CodexThreadTokenUsageSnapshot | null {
    if (!threadId) return null;
    return this.usageByThread.get(threadId)?.tokenUsage || null;
  }

  diagnosticLines(): string[] {
    return this.diagnostics.slice();
  }

  dispose(): void {
    this.client?.close();
    this.client = null;
    this.starting = false;
  }

  private async start(commandPath: string): Promise<void> {
    const command = resolveCodexCommand(commandPath);
    this.diagnostics = [];
    try {
      await this.open(command, ["app-server", "proxy"], "proxy", 5000);
      return;
    } catch (err) {
      this.diagnostics.push(`token usage proxy unavailable: ${conciseError(err)}`);
    }
    try {
      await this.open(command, ["app-server"], "stdio", 12000);
    } catch (err) {
      this.diagnostics.push(`token usage watcher unavailable: ${conciseError(err)}`);
      this.starting = false;
    }
  }

  private async open(
    command: CodexCommandResolution,
    args: string[],
    source: "proxy" | "stdio",
    timeoutMs: number
  ): Promise<void> {
    const client = new CodexProcessClient(
      command,
      args,
      (message) => {
        const update = parseCodexTokenUsageNotification(message);
        if (!update) return;
        this.usageByThread.set(update.threadId, update);
        this.onUpdate?.();
      },
      (error) => {
        if (this.client === client) this.client = null;
        this.diagnostics = [`token usage ${source} closed: ${error || "closed"}`];
      }
    );
    try {
      await client.request(
        "initialize",
        {
          clientInfo: { name: "cc-statusbar", title: "CC Statusbar", version: "local" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
        },
        timeoutMs
      );
    } catch (err) {
      client.close();
      throw err;
    }
    this.client = client;
    this.starting = false;
    this.diagnostics.push(`token usage watcher: ${source}`);
  }
}

async function readThreadSummary(
  client: CodexProcessClient,
  workspacePath: string | undefined,
  timeoutMs: number,
  diagnostics: string[]
): Promise<CodexThreadSummary | null> {
  try {
    const loadedPayload = resultOf(await client.request("thread/loaded/list", { limit: 50 }, timeoutMs));
    const loadedIds = new Set(resultDataArray(loadedPayload).filter((id): id is string => typeof id === "string"));

    const threadListParams: Record<string, unknown> = {
      limit: 20,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
    };
    if (workspacePath) threadListParams.cwd = workspacePath;

    const byWorkspacePayload = resultOf(await client.request("thread/list", threadListParams, timeoutMs));
    let candidates = resultDataArray(byWorkspacePayload);

    if (workspacePath && candidates.length === 0) {
      const allPayload = resultOf(
        await client.request(
          "thread/list",
          { limit: 20, sortKey: "updated_at", sortDirection: "desc", archived: false },
          timeoutMs
        )
      );
      candidates = resultDataArray(allPayload).filter((thread) =>
        samePath((thread as Record<string, unknown> | null)?.cwd as string | null | undefined, workspacePath)
      );
    }

    const preferred =
      candidates.find((thread) => {
        const id = (thread as Record<string, unknown> | null)?.id;
        return typeof id === "string" && loadedIds.has(id);
      }) || candidates[0];
    return summarizeThread(preferred, loadedIds);
  } catch (err) {
    diagnostics.push(`thread unavailable: ${conciseError(err)}`);
    return null;
  }
}

async function probeWith(
  command: CodexCommandResolution,
  args: string[],
  source: "proxy" | "stdio",
  timeoutMs: number,
  fetchedAtSec: number,
  workspacePath?: string
): Promise<CodexAppServerOk> {
  const client = new CodexProcessClient(command, args);
  try {
    const diagnostics = [`codex command: ${command.source}`];
    const init = resultOf(
      await client.request(
        "initialize",
        {
          clientInfo: { name: "cc-statusbar", title: "CC Statusbar", version: "local" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
        },
        timeoutMs
      )
    ) as Record<string, any> | null;
    const account = accountSummary(resultOf(await client.request("account/read", { refreshToken: false }, timeoutMs)));
    const rateLimitsPayload = resultOf(await client.request("account/rateLimits/read", undefined, timeoutMs));
    const thread = await readThreadSummary(client, workspacePath, timeoutMs, diagnostics);
    return {
      state: "ok",
      fetchedAtSec,
      source,
      userAgent: typeof init?.userAgent === "string" ? init.userAgent : null,
      account,
      rateLimits: selectCodexRateLimits(rateLimitsPayload),
      thread,
      diagnostics,
    };
  } finally {
    client.close();
  }
}

export async function fetchCodexAppServerStatus(
  nowSec: number,
  timeoutMs = 12000,
  options: CodexAppServerOptions = {}
): Promise<CodexAppServerResult> {
  const command = resolveCodexCommand(options.commandPath);
  const diagnostics: string[] = [];
  try {
    const result = await probeWith(
      command,
      ["app-server", "proxy"],
      "proxy",
      Math.min(timeoutMs, 5000),
      nowSec,
      options.workspacePath
    );
    return { ...result, diagnostics: result.diagnostics };
  } catch (err) {
    diagnostics.push(`proxy unavailable: ${conciseError(err)}`);
  }

  try {
    const result = await probeWith(command, ["app-server"], "stdio", timeoutMs, nowSec, options.workspacePath);
    return { ...result, diagnostics: [...diagnostics, ...result.diagnostics] };
  } catch (err) {
    diagnostics.push(`stdio unavailable: ${conciseError(err)}`);
    return {
      state: "error",
      fetchedAtSec: nowSec,
      detail: conciseError(err),
      diagnostics,
    };
  }
}
