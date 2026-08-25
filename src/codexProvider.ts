import { emptyTotals, QuotaWindow, Totals } from "./metrics";
import { CacheView, ContextView } from "./render";
import { ProviderSnapshot } from "./providerTypes";

export function shortCodexModelLabel(model: string | null | undefined): string | null {
  const raw = model?.trim();
  if (!raw) return null;
  const gpt = /^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/i.exec(raw);
  if (!gpt) return raw;
  const suffix = gpt[2]
    ? ` ${gpt[2]
        .split("-")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ")}`
    : "";
  return `GPT-${gpt[1]}${suffix}`;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number | null;
}

export interface CodexTokenBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  /** Codex states this counter; older payloads omit it (`null`/absent). */
  cacheWriteInputTokens?: number | null;
}

export interface CodexTokenUsage {
  last: CodexTokenBreakdown | null;
  total: CodexTokenBreakdown | null;
  modelContextWindow: number | null;
}

export interface CodexThreadIdentity {
  threadId: string;
  cwd: string;
  modelId?: string;
  planType?: string;
  updatedAtMs?: number;
}

export interface CodexProviderInput {
  workspacePath: string;
  thread: CodexThreadIdentity;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  tokenUsage: CodexTokenUsage | null;
}

export function codexWindowLabel(windowDurationMins: number): "5h" | "7d" | `${number}m` {
  if (windowDurationMins === 300) return "5h";
  if (windowDurationMins === 10080) return "7d";
  return `${windowDurationMins}m`;
}

export function codexQuotaWindow(w: CodexRateLimitWindow | null): QuotaWindow | null {
  if (!w) return null;
  return {
    pct: w.usedPercent,
    resetAt: w.resetsAt,
  };
}

export function codexTotals(usage: CodexTokenUsage | null): Totals {
  const total = usage?.total;
  if (!total) return emptyTotals();
  const cacheRead = total.cachedInputTokens || 0;
  const afterCached = Math.max(0, (total.inputTokens || 0) - cacheRead);
  // The same three-bucket split `codexEconomy` uses, so the two never disagree
  // about the same payload: OpenAI documents `input_tokens_details` as a
  // BREAKDOWN of `input_tokens`, with `ordinary = input − cached − cache_write`.
  // The write is clamped to what the reads leave, so the parts can never sum
  // past the whole. Codex states no cache TIER, so the write lands in the
  // unknown-lifetime bucket — the tiered ones stay 0, shown as unavailable
  // rather than guessed.
  const cacheWrite = Math.min(Math.max(0, total.cacheWriteInputTokens ?? 0), afterCached);
  const input = afterCached - cacheWrite;
  const output = total.outputTokens || 0;
  return {
    ...emptyTotals(),
    input,
    output,
    work: input + output,
    cacheRead,
    cacheWrite,
    cacheWriteUnknown: cacheWrite,
  };
}

export function codexContext(usage: CodexTokenUsage | null): ContextView | undefined {
  const last = usage?.last;
  if (!last) return undefined;
  if (usage.modelContextWindow && usage.modelContextWindow > 0) {
    return {
      usedTokens: last.inputTokens,
      limitTokens: usage.modelContextWindow,
      limitState: "ok",
    };
  }
  return {
    usedTokens: last.inputTokens,
    limitTokens: null,
    limitState: "unavailable",
    // Named, not spelled out: this clause is shown to the reader and has to
    // follow the panel's language (see ContextView.limitDetailKey).
    limitDetailKey: "codexNoWindow",
  };
}

export function codexCache(usage: CodexTokenUsage | null): CacheView | undefined {
  const total = usage?.total;
  if (!total) return undefined;
  const denom = total.inputTokens || 0;
  if (denom <= 0) return { tier: null, hitRatePct: null };
  return {
    tier: null,
    hitRatePct: Math.round(((total.cachedInputTokens || 0) / denom) * 100),
  };
}

export function buildCodexSnapshot(input: CodexProviderInput): ProviderSnapshot {
  return {
    kind: "snapshot",
    provider: "codex",
    title: "Codex",
    totals: codexTotals(input.tokenUsage),
    quota: {
      fiveH: codexQuotaWindow(input.primary),
      sevenD: codexQuotaWindow(input.secondary),
      state: input.primary || input.secondary ? "ok" : "error",
      detail: input.primary || input.secondary ? undefined : "rate limits unavailable",
    },
    context: codexContext(input.tokenUsage),
    cache: codexCache(input.tokenUsage),
    source: {
      workspacePath: input.workspacePath,
      threadId: input.thread.threadId,
      modelId: input.thread.modelId,
      planType: input.thread.planType,
      updatedAtMs: input.thread.updatedAtMs,
    },
  };
}
