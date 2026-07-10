// Per-million-token rates for the chat models. Prompt-cache writes cost 1.25× the
// input rate; cache reads cost 0.1×. Unknown models fall back to opus pricing.
const PRICING: Record<string, { inPerM: number; outPerM: number }> = {
  "claude-opus-4-8": { inPerM: 5, outPerM: 25 },
  "claude-opus-4-7": { inPerM: 5, outPerM: 25 },
  "claude-sonnet-4-6": { inPerM: 3, outPerM: 15 },
  "claude-haiku-4-5-20251001": { inPerM: 1, outPerM: 5 },
};

export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Total USD for one turn's token usage, blending base, output, and cache rates. */
export function costUsd(model: string, u: TokenUsage): number {
  const p = PRICING[model] ?? PRICING["claude-opus-4-8"];
  return (
    (u.input * p.inPerM +
      u.output * p.outPerM +
      u.cacheWrite * p.inPerM * 1.25 +
      u.cacheRead * p.inPerM * 0.1) /
    1_000_000
  );
}
