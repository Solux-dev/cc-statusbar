import type {
  ProviderActivity,
  ProviderCandidate,
  ProviderMode,
  ProviderSelection,
  UsageProviderKind,
} from "./providerTypes";

export const CODEX_NOT_CONNECTED_DETAIL = "Codex app-server is unavailable.";

export function normalizeProviderMode(value: unknown): ProviderMode {
  return value === "claude" || value === "codex" || value === "auto" ? value : "auto";
}

export function providerActivity(
  provider: UsageProviderKind,
  active: boolean,
  lastActivityMs: number | null,
  reason: string
): ProviderActivity {
  return { provider, active, lastActivityMs, reason };
}

export interface ResolveProviderInput {
  mode: ProviderMode;
  candidates: ProviderCandidate[];
  fallbackProvider?: UsageProviderKind | null;
}

function byProvider(candidates: ProviderCandidate[]): Map<UsageProviderKind, ProviderCandidate> {
  return new Map(candidates.map((c) => [c.provider, c]));
}

function selected(candidate: ProviderCandidate, reason: string): ProviderSelection {
  return {
    kind: "selected",
    provider: candidate.provider,
    activity: candidate.activity,
    reason,
  };
}

function unavailable(provider: UsageProviderKind, detail?: string): ProviderSelection {
  return {
    kind: "unavailable",
    provider,
    detail: detail || "provider unavailable",
  };
}

export function resolveProvider(input: ResolveProviderInput): ProviderSelection {
  const candidates = byProvider(input.candidates);

  if (input.mode !== "auto") {
    const candidate = candidates.get(input.mode);
    if (!candidate) return unavailable(input.mode);
    if (!candidate.available) return unavailable(input.mode, candidate.unavailableDetail);
    return selected(candidate, "manual");
  }

  const active = input.candidates.filter((c) => c.available && c.activity.active);
  if (active.length > 1) {
    return {
      kind: "conflict",
      activities: active.map((c) => c.activity),
    };
  }
  if (active.length === 1) return selected(active[0], "active");

  if (input.fallbackProvider) {
    const fallback = candidates.get(input.fallbackProvider);
    if (fallback?.available) return selected(fallback, "fallback");
  }

  const claude = candidates.get("claude");
  if (claude?.available) return selected(claude, "default");

  const firstAvailable = input.candidates.find((c) => c.available);
  if (firstAvailable) return selected(firstAvailable, "default");

  const firstUnavailable = input.candidates[0];
  return unavailable(firstUnavailable?.provider || "claude", firstUnavailable?.unavailableDetail);
}
