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
  /**
   * The profile cannot carry access today, so the loss is realised rather than hypothetical. Ranked
   * above a live concentration: an outage that has already happened outranks one that might.
   */
  blocked: boolean;
  /**
   * BMs it is the only usable admin of. When `blocked`, BMs it admins that have no usable admin at
   * all — the ones it took out.
   */
  bms: number;
  /**
   * When `blocked`: the assets sitting behind those BMs, which nobody can now administer.
   *
   * NOT "assets already unreachable" — `usableBm` reads a BM's own status, so an admin-less but
   * active BM still counts as a live path for what hangs off it. Claiming otherwise here would be a
   * second, disagreeing risk rule. Otherwise: assets that would lose their last live path if this
   * profile went.
   */
  assets: number;
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
 * The profile that concentrates the most access, in either of the two forms that matter.
 *
 *  - **Live:** the only usable admin of two or more BMs. One ban takes all of them out at once.
 *  - **Blocked:** already unusable, and an admin of two or more BMs that now have no usable admin.
 *    The cascade has happened; naming it is the difference between an operator seeing four
 *    unreachable BMs and seeing the one suspended profile that explains three of them.
 *
 * Measured on the live registry, only the blocked form occurs — which is exactly why it is here.
 * One BM is the ordinary case and never a concentration.
 *
 * The live form's loss is measured by removing the profile AND every BM it solely holds, not by
 * walking each BM in turn: a per-BM walk reports an asset reachable from two of those BMs as
 * surviving, when in truth it survives the loss of either one and not of the profile holding both.
 */
function worstConcentration(graph: InfraGraph): AccessConcentration | null {
  const adminsByBm = new Map<string, { profile: string; dead: boolean }[]>();
  for (const e of graph.edges) {
    if (e.relation !== "admin") continue;
    const held = adminsByBm.get(e.target);
    if (held) held.push({ profile: e.source, dead: e.dead });
    else adminsByBm.set(e.target, [{ profile: e.source, dead: e.dead }]);
  }

  const soleUsable = new Map<string, string[]>();
  const strandedBms = new Map<string, string[]>();
  for (const [bm, admins] of adminsByBm) {
    const usable = admins.filter((a) => !a.dead);
    if (usable.length === 1) group(soleUsable, usable[0].profile, bm);
    // Nobody usable admins it. Every admin it has is a dead hand, and each is named as a cause.
    else if (usable.length === 0) for (const a of admins) group(strandedBms, a.profile, bm);
  }

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const candidates: AccessConcentration[] = [];
  const consider = (profile: string, bms: string[], blocked: boolean) => {
    const node = nodeById.get(profile);
    if (!node || bms.length < 2) return;
    candidates.push({
      profileId: node.entityId,
      name: node.name,
      blocked,
      assets: blocked
        ? assetsBehind(graph, new Set(bms))
        : strandedWithout(graph, new Set([profile, ...bms])),
      bms: bms.length,
    });
  };
  for (const [profile, bms] of strandedBms) consider(profile, bms, true);
  for (const [profile, bms] of soleUsable) consider(profile, bms, false);

  // Sorted rather than tracked in a running `best` so ties break on name — registry order is not
  // stable across reads, and a headline that flips between two equal profiles reads as a bug.
  candidates.sort(
    (a, b) =>
      Number(b.blocked) - Number(a.blocked) ||
      b.bms - a.bms ||
      b.assets - a.assets ||
      a.name.localeCompare(b.name),
  );
  return candidates[0] ?? null;
}

/** Map-of-arrays push. Three groupings in this module have to behave identically. */
function group(map: Map<string, string[]>, key: string, value: string) {
  const held = map.get(key);
  if (held) held.push(value);
  else map.set(key, [value]);
}

/**
 * Distinct assets these BMs reach directly. Used for the blocked case, where the question is not
 * "what would a ban cost" but "what is now sitting behind a BM nobody can administer".
 */
function assetsBehind(graph: InfraGraph, bms: Set<string>): number {
  const reached = new Set(graph.edges.filter((e) => bms.has(e.source)).map((e) => e.target));
  return graph.nodes.filter((n) => LOSABLE_KINDS.includes(n.kind) && reached.has(n.id)).length;
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
