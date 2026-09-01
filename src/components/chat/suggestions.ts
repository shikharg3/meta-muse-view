import type { ToolTrace } from "@/server/agent/events";

/**
 * Prompt suggestions, derived rather than hardcoded.
 *
 * The old version shipped four literal strings naming two specific clients; the moment the Notion
 * board changed they pointed at accounts that no longer existed. Starters now come from the loader's
 * client list, and follow-ups come from what the turn actually did — which tools ran, and whether the
 * answer carried a KPI strip, a chart, or a report.
 */

export interface TurnFacts {
  /** The question the user asked, used to spot which client (if any) the turn was about. */
  question: string;
  toolCalls: ToolTrace[];
  hasCards: boolean;
  hasSeries: boolean;
  hasReport: boolean;
  /** Active client names from the route loader. */
  clientNames: string[];
}

const GENERIC: string[] = [
  "How are we doing across all accounts this week?",
  "Which client spent the most in the last 30 days?",
  "Anything that needs my attention today?",
  "Compare this week to last week",
];

/** Opening suggestions for an empty thread, naming clients that actually exist. */
export function starterPrompts(
  clients: { name: string; accountCount: number; status: string | null }[],
): string[] {
  // Busiest first: a client with several ad accounts makes for a more interesting first answer than
  // one that was added yesterday and has none.
  const named = clients
    .filter((c) => c.name.trim() !== "")
    .sort((a, b) => b.accountCount - a.accountCount)
    .map((c) => c.name);
  const [first, second] = named;
  const out: string[] = [];
  if (first) out.push(`How is ${first} performing over the last 7 days?`);
  if (second) out.push(`What's the status of ${second}'s campaigns?`);
  if (named.length > 1) out.push("Which client spent the most in the last 30 days?");
  // GENERIC backfills the rest, so a workspace with no clients yet still gets four usable starters.
  return dedupe([...out, ...GENERIC]).slice(0, 4);
}

/**
 * Two-to-four follow-ups for a completed turn. Every candidate is conditioned on something that
 * happened, so a turn that only listed clients does not get offered "break that down by campaign".
 */
export function deriveFollowUps(facts: TurnFacts): string[] {
  const { toolCalls, hasCards, hasSeries, hasReport } = facts;
  const ran = (fragment: string) => toolCalls.some((t) => t.name.includes(fragment));
  const subject = matchClient(facts.question, facts.clientNames);
  const who = subject ?? "all clients";
  const out: string[] = [];

  if (hasReport) {
    out.push("Run the same report for the previous 30 days");
    out.push(`Summarise what stands out in that ${subject ? `${subject} ` : ""}report`);
  }
  if (hasSeries) {
    out.push("What happened on the worst day in that chart?");
    if (!ran("campaign")) out.push(`Break that down by campaign for ${who}`);
  } else if (hasCards || ran("stats") || ran("overview") || ran("performance")) {
    out.push(`Chart daily spend for ${who} over the last 14 days`);
    out.push(`How does that compare to the previous period?`);
  }
  if (ran("campaign") && !hasSeries) out.push("Which campaigns are driving the spend?");
  if (ran("creative") || ran("ad_")) out.push("Which creatives are worth scaling?");
  if (ran("budget") || ran("pacing")) out.push("Is anything pacing off target?");
  if (ran("alert") || ran("health")) out.push("What should I fix first?");
  if (ran("list_clients") && !subject) {
    const [first] = facts.clientNames;
    if (first) out.push(`Show me ${first}'s last 7 days`);
  }
  if (subject) out.push(`Anything unusual for ${subject} this month?`);

  return dedupe([...out, ...GENERIC]).slice(0, 4);
}

/** Longest client name mentioned in the question — longest so "Wild Foods" beats "Wild". */
function matchClient(question: string, clientNames: string[]): string | null {
  const q = question.toLowerCase();
  let best: string | null = null;
  for (const name of clientNames) {
    const n = name.trim();
    if (n.length < 3 || !q.includes(n.toLowerCase())) continue;
    if (best === null || n.length > best.length) best = n;
  }
  return best;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}
