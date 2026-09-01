/**
 * Thresholds and formatting for conversation cost.
 *
 * Separate from ThreadMeter.tsx so that file exports only components (react-refresh), matching how
 * trace.ts sits beside ToolTrace.tsx.
 *
 * The numbers come from measured usage: a question at thread depth 21+ cost 2.6x one at depth 1-2
 * ($0.289 vs $0.109), and the thread that prompted all of this reached 212 questions and $59.16.
 * Nudging at 8 questions or $1 would have caught it about $58 earlier.
 */
export const NUDGE_TURNS = 8;
export const NUDGE_COST = 1;

/** Above this a thread reads as a problem, not a warning. */
export const HIGH_COST = 3;
export const WARN_COST = 1;

/** Sub-cent turns still round to two places: "$0.00" reads as free, which is how this started. */
export const fmtCost = (usd: number): string =>
  usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
