import type { PaceLevel, QuotaWindow, Totals } from "./metrics";
import type { CacheView, ContextView } from "./render";

export type UsageProviderKind = "claude" | "codex";

export type ProviderMode = "auto" | UsageProviderKind;

export interface ProviderCandidate {
  provider: UsageProviderKind;
  available: boolean;
  activity: ProviderActivity;
  unavailableDetail?: string;
}

export interface ProviderActivity {
  provider: UsageProviderKind;
  active: boolean;
  lastActivityMs: number | null;
  reason: string;
}

export interface ProviderSelected {
  kind: "selected";
  provider: UsageProviderKind;
  activity: ProviderActivity;
  reason: string;
}

export interface ProviderConflict {
  kind: "conflict";
  activities: ProviderActivity[];
}

export interface ProviderUnavailable {
  kind: "unavailable";
  provider: UsageProviderKind;
  detail: string;
}

export interface ProviderSnapshot {
  kind: "snapshot";
  provider: UsageProviderKind;
  title: string;
  totals: Totals;
  quota: {
    fiveH: QuotaWindow | null;
    sevenD: QuotaWindow | null;
    state: "ok" | "no-credentials" | "error" | "rate-limited" | "disabled";
    detail?: string;
  };
  context?: ContextView;
  cache?: CacheView;
  levelHint?: PaceLevel;
  source: ProviderSourceDetails;
}

export interface ProviderSourceDetails {
  workspacePath: string;
  sessionId?: string;
  threadId?: string;
  modelId?: string;
  planType?: string;
  updatedAtMs?: number;
  diagnostics?: string[];
}

export type ProviderResult = ProviderSnapshot | ProviderConflict | ProviderUnavailable;

export type ProviderSelection = ProviderSelected | ProviderConflict | ProviderUnavailable;
