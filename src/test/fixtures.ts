import { messages } from "../i18n";

// Fixtures every themed test file leans on. Nothing here asserts anything: it
// is the shared vocabulary the tests are written in, lifted out of the single
// file they used to share.

export const W = { cacheRead: 0.1, cacheWrite: 1.25 };
export const EN_UNITS = messages("en").units;
export const RU_UNITS = messages("ru").units;

export const ctxTotals = { input: 50000, output: 150000, work: 200000, cacheRead: 10_000_000, cacheWrite: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 1_000_000 };

/** One assistant turn as Claude Code writes it. `at` is the ISO timestamp (pass
 *  "" for a turn whose clock cannot be read), `write` the cache-creation tokens,
 *  `tier` where the transcript says they landed (omit it for an older
 *  transcript that states no tier at all). */
export function turn(o: { id: string; at: string; write?: number; tier?: "1h" | "5m"; sidechain?: boolean }): string {
  const w = o.write ?? 0;
  const usage: any = {
    input_tokens: 10,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: w,
  };
  if (o.tier === "1h") usage.cache_creation = { ephemeral_1h_input_tokens: w, ephemeral_5m_input_tokens: 0 };
  if (o.tier === "5m") usage.cache_creation = { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: w };
  return JSON.stringify({
    type: "assistant",
    isSidechain: o.sidechain ?? false,
    timestamp: o.at,
    message: { id: o.id, model: "claude-opus-5", usage },
  });
}

export const REB = (o: Partial<{ tokens: number; tokens1h: number; tokens5m: number; tokensUnknown: number; cacheWrite: number; streams: number; unjudged: number }>) => ({
  tokens: 0, tokens1h: 0, tokens5m: 0, tokensUnknown: 0, cacheWrite: 0, streams: 0, unjudged: 0, ...o,
});

export const REBUILD_TOTALS = {
  input: 0,
  output: 0,
  work: 50_000_000,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cacheWrite5m: 0,
  cacheWriteUnknown: 0,
};

export const REBUILD_SUBS = [
  {
    agentType: "Explore",
    description: "map the repo",
    modelId: "claude-sonnet-5",
    modelLabel: "Sonnet 5",
    effort: "high",
    effective: 20_000_000,
  },
];

// 3M tokens on the 5-minute tier = 3.75M token-equivalent = 7.5% of the
// session, and 50% of everything the agents wrote: both bars cleared.
export const REBUILD_LOUD = REB({ tokens: 3_000_000, tokens5m: 3_000_000, cacheWrite: 6_000_000, streams: 2 });

export const QUOTA_OFF = { state: "disabled" as const, fiveH: null, sevenD: null };

export const ORDER_CODEX_USAGE = {
  totalTokens: 105_000, lastTokens: 0,
  inputTokens: 100_000, cachedInputTokens: 80_000,
  outputTokens: 5_000, reasoningOutputTokens: 0,
};

export const IDLE_BASE = { agentType: "implementer", description: "Fix round R3", modelId: "claude-opus-5", modelLabel: "Opus 5", effort: "xhigh" };

/** 400k reload tokens on the 5-minute tier = 500k token-equivalent = 25% of a
 *  2M agent — the same weights the headline uses, so the two are comparable. */
export const IDLE_AGENT = { ...IDLE_BASE, effective: 2_000_000, rebuild: REB({ tokens: 400_000, tokens5m: 400_000, cacheWrite: 900_000, streams: 1 }) };

export const PATIENT_AGENT = { agentType: "reviewer", description: "Review cache formula", modelId: "claude-opus-5", modelLabel: "Opus 5", effort: "xhigh", effective: 1_000_000, rebuild: REB({ cacheWrite: 800_000 }) };

export const IDLE_TOTALS = { input: 0, output: 0, work: 4_000_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheWriteUnknown: 0 };

export const WARMUP_TOTALS = {
  input: 500, output: 500, work: 1000,
  cacheRead: 0, cacheWrite: 100_000,
  cacheWrite1h: 100_000, cacheWrite5m: 0, cacheWriteUnknown: 0,
};
