/**
 * Screen-level summary of the access graph: the per-type tally the risk matrix is drawn from, plus
 * the single worst access concentration.
 *
 * Pure, and it classifies nothing. Every verdict arrives on the graph nodes from `infra-risk.ts`,
 * exactly as `infra-graph.ts` never re-derives one — this module only counts and traverses. That is
 * what keeps the matrix, the findings list and the drawn map incapable of disagreeing.
 */
import { REACHED_KINDS, type InfraGraph, type InfraNodeKind } from "./infra-graph";

export interface RiskTallyRow {
  kind: InfraNodeKind;
  critical: number;
  warning: number;
  safe: number;
  /** Rows the risk model scored — what the three columns add up to. */
  scored: number;
  /** Registry rows. Exceeds `scored` where the model excludes some (retired ad accounts). */
  registered: number;
}

export interface AccessConcentration {
  /** Row id, so the caller can deep-link to the profile. */
  profileId: string;
  name: string;
  /** BMs this profile is the only usable admin of. */
  bms: number;
  /** Ad accounts, pixels and pages that lose their last live path if this profile goes. */
  strandedAssets: number;
}

export interface InfraRiskSummary {
  /**
   * Non-safe assets. A profile is a means of access rather than an asset to protect, so it is
   * counted here only through what it strands — the same contract `profileRisk` documents.
   */
  atRisk: number;
  /** Matrix row order: assets worst-reaching-first, profiles last as the access-path line. */
  tally: RiskTallyRow[];
  concentration: AccessConcentration | null;
}

const TALLY_ORDER: readonly InfraNodeKind[] = ["bm", "adAccount", "pixel", "page", "profile"];
const ASSET_KINDS: readonly InfraNodeKind[] = ["bm", "adAccount", "pixel", "page"];
/** Widened once so `includes` takes a plain node kind instead of a cast at every call. */
const LOSABLE_KINDS: readonly InfraNodeKind[] = REACHED_KINDS;

export function buildRiskSummary(
  graph: InfraGraph,
  registered: Record<InfraNodeKind, number>,
): InfraRiskSummary {
  const tally = TALLY_ORDER.map((kind) => {
    const nodes = graph.nodes.filter((n) => n.kind === kind);
    const critical = nodes.filter((n) => n.risk.level === "critical").length;
    const warning = nodes.filter((n) => n.risk.level === "warning").length;
    return {
      kind,
      critical,
      warning,
      safe: nodes.length - critical - warning,
      scored: nodes.length,
      registered: registered[kind],
    };
  });

  const atRisk = tally
    .filter((row) => ASSET_KINDS.includes(row.kind))
    .reduce((n, row) => n + row.critical + row.warning, 0);

  return { atRisk, tally, concentration: worstConcentration(graph) };
}

/**
 * The profile whose ban would cascade furthest: sole usable admin of two or more BMs, so one ban
 * takes all of them out at once. One BM is the ordinary case and not a concentration.
 *
 * The loss is measured by removing the profile AND every BM it solely holds, not by walking each BM
 * in turn: a per-BM walk reports an asset reachable from two of those BMs as surviving, when in truth
 * it survives the loss of either one and not the loss of the profile holding both.
 */
function worstConcentration(graph: InfraGraph): AccessConcentration | null {
  const liveAdmins = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.relation !== "admin" || e.dead) continue;
    const held = liveAdmins.get(e.target);
    if (held) held.push(e.source);
    else liveAdmins.set(e.target, [e.source]);
  }

  const soleOf = new Map<string, string[]>();
  for (const [bm, admins] of liveAdmins) {
    if (admins.length !== 1) continue;
    const held = soleOf.get(admins[0]);
    if (held) held.push(bm);
    else soleOf.set(admins[0], [bm]);
  }

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const candidates: AccessConcentration[] = [];
  for (const [profile, bms] of soleOf) {
    const node = nodeById.get(profile);
    if (!node || bms.length < 2) continue;
    candidates.push({
      profileId: node.entityId,
      name: node.name,
      bms: bms.length,
      strandedAssets: strandedWithout(graph, new Set([profile, ...bms])),
    });
  }

  // Sorted rather than tracked in a running `best` so ties break on name — registry order is not
  // stable across reads, and a headline that flips between two equal profiles reads as a bug.
  candidates.sort(
    (a, b) => b.bms - a.bms || b.strandedAssets - a.strandedAssets || a.name.localeCompare(b.name),
  );
  return candidates[0] ?? null;
}

/** Assets that have a live way in today and would have none once `doomed` is gone. */
function strandedWithout(graph: InfraGraph, doomed: Set<string>): number {
  const liveSources = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.dead) continue;
    const sources = liveSources.get(e.target);
    if (sources) sources.push(e.source);
    else liveSources.set(e.target, [e.source]);
  }

  let stranded = 0;
  for (const node of graph.nodes) {
    if (!LOSABLE_KINDS.includes(node.kind)) continue;
    const sources = liveSources.get(node.id);
    // No live source at all means it is already unreachable — a standing finding, not this ban's doing.
    if (!sources?.length) continue;
    if (sources.every((s) => doomed.has(s))) stranded += 1;
  }
  return stranded;
}
