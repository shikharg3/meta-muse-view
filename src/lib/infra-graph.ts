/**
 * The registry as a directed access graph: who can reach what.
 *
 * Pure and structural. Every node arrives already classified by `infra-risk.ts` — this module never
 * re-derives a verdict, it only wires the entities together, exactly as the risk read model never
 * re-derives risk in a component. The one thing it does decide is whether an edge is *dead*, and that
 * is a restatement of the caller's `usable` flag, not a new rule.
 *
 * Edge direction is "grants access to", always: a profile admins a BM, a BM reaches an ad account, a
 * profile owns a page. That single convention is what makes the drawn graph readable left-to-right —
 * anything with no live inbound arrow is unreachable, which is the whole product thesis made visible.
 */
import type { Risk, RiskLevel } from "./infra-risk";

export const INFRA_NODE_KINDS = ["profile", "bm", "adAccount", "pixel", "page"] as const;
export type InfraNodeKind = (typeof INFRA_NODE_KINDS)[number];

/**
 * Why the edge exists. Styling only — risk already lives on the nodes.
 *
 * `owns`/`root` are the structural parent (a page's owner profile, a pixel's root BM): exactly one per
 * child, NOT NULL in the schema, and never also a share. `admin`/`share`/`access` are the M:N links.
 */
export const INFRA_RELATIONS = ["admin", "owns", "root", "share", "access"] as const;
export type InfraRelation = (typeof INFRA_RELATIONS)[number];

export interface InfraGraphNode {
  /** `${kind}:${entityId}`. Entity ids only have to be unique per table, node ids must be global. */
  id: string;
  kind: InfraNodeKind;
  /** The row id, kept separate so the UI can deep-link without re-parsing `id`. */
  entityId: string;
  name: string;
  status: string;
  risk: Risk;
  detail: string;
  overdue?: boolean;
}

export interface InfraGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: InfraRelation;
  /** The source cannot carry access right now. A drawn-but-dead path, which is the useful signal. */
  dead: boolean;
}

export interface InfraGraph {
  nodes: InfraGraphNode[];
  edges: InfraGraphEdge[];
}

interface Entity {
  id: string;
  name: string;
  status: string;
  risk: Risk;
  detail: string;
}

/**
 * Already-fetched, already-classified rows plus the five link tables.
 *
 * `usable` is passed in rather than recomputed from `status`, because the profile rule reads a status
 * SET and the BM rule reads one value — duplicating either here would be a second place for them to
 * drift from `usableProfile`/`usableBm`.
 */
export interface InfraGraphInput {
  profiles: readonly (Entity & { usable: boolean })[];
  bms: readonly (Entity & { usable: boolean; overdue: boolean })[];
  /** Retired accounts are already filtered out by the caller, as they are for the risk tables. */
  adAccounts: readonly Entity[];
  pixels: readonly (Entity & { rootBmId: string })[];
  pages: readonly (Entity & { ownerProfileId: string })[];
  profileBm: readonly { profileId: string; bmId: string }[];
  bmAdAccount: readonly { bmId: string; adAccountId: string }[];
  pixelBm: readonly { pixelId: string; bmId: string }[];
  pageBm: readonly { pageId: string; bmId: string }[];
  pageProfile: readonly { pageId: string; profileId: string }[];
}

export const nodeId = (kind: InfraNodeKind, entityId: string) => `${kind}:${entityId}`;

/** Rank order for a left-to-right access flow, and the order nodes are emitted in. */
const KIND_RANK: Record<InfraNodeKind, number> = {
  profile: 0,
  bm: 1,
  adAccount: 2,
  pixel: 3,
  page: 4,
};

export function buildInfraGraph(input: InfraGraphInput): InfraGraph {
  const nodes: InfraGraphNode[] = [
    ...input.profiles.map((p) => toNode("profile", p)),
    ...input.bms.map((b) => ({ ...toNode("bm", b), overdue: b.overdue })),
    ...input.adAccounts.map((a) => toNode("adAccount", a)),
    ...input.pixels.map((p) => toNode("pixel", p)),
    ...input.pages.map((p) => toNode("page", p)),
  ].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.name.localeCompare(b.name));

  const present = new Set(nodes.map((n) => n.id));
  // A source that cannot carry access makes every edge leaving it dead. Only profiles and BMs are
  // ever sources, so this map covers all of them.
  const dead = new Map<string, boolean>();
  for (const p of input.profiles) dead.set(nodeId("profile", p.id), !p.usable);
  for (const b of input.bms) dead.set(nodeId("bm", b.id), !b.usable);

  // Keyed by edge id: a duplicate row (or a root BM wrongly also recorded as a share) would otherwise
  // emit two edges with the same id, which React Flow silently drops one of.
  const edges = new Map<string, InfraGraphEdge>();
  const link = (source: string, target: string, relation: InfraRelation) => {
    if (!present.has(source) || !present.has(target)) return; // e.g. a link to a retired account
    const id = `${relation}|${source}|${target}`;
    if (edges.has(id)) return;
    edges.set(id, { id, source, target, relation, dead: dead.get(source) ?? false });
  };

  for (const l of input.profileBm) {
    link(nodeId("profile", l.profileId), nodeId("bm", l.bmId), "admin");
  }
  for (const l of input.bmAdAccount) {
    link(nodeId("bm", l.bmId), nodeId("adAccount", l.adAccountId), "access");
  }
  for (const p of input.pixels) link(nodeId("bm", p.rootBmId), nodeId("pixel", p.id), "root");
  for (const l of input.pixelBm) link(nodeId("bm", l.bmId), nodeId("pixel", l.pixelId), "share");
  for (const p of input.pages) {
    link(nodeId("profile", p.ownerProfileId), nodeId("page", p.id), "owns");
  }
  for (const l of input.pageBm) link(nodeId("bm", l.bmId), nodeId("page", l.pageId), "access");
  for (const l of input.pageProfile) {
    link(nodeId("profile", l.profileId), nodeId("page", l.pageId), "access");
  }

  return { nodes, edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

function toNode(kind: InfraNodeKind, e: Entity): InfraGraphNode {
  return {
    id: nodeId(kind, e.id),
    kind,
    entityId: e.id,
    name: e.name,
    status: e.status,
    risk: e.risk,
    detail: e.detail,
  };
}

/** The kinds that are assets to be protected. Profiles and BMs are the paths, never the loss. */
export const REACHED_KINDS = ["adAccount", "pixel", "page"] as const;
export type ReachedKind = (typeof REACHED_KINDS)[number];

/** An asset one node reaches, with the number of live paths that would survive without that node. */
export interface ReachedAsset {
  id: string;
  name: string;
  risk: RiskLevel;
  detail: string;
  /** Distinct live sources still reaching it if `source` went. 0 = `source` is its only way in. */
  otherLivePaths: number;
}

/**
 * Everything a single node reaches, annotated with what would still reach it afterwards.
 *
 * The one traversal behind every "what does a ban cost" answer on the screen and in the agent tools,
 * so a preview can never disagree with the map — they read the same graph.
 *
 * Pages are included even where a profile owns them: an owning or shared profile IS an independent
 * path, so a page a BM merely co-reaches is not stranded by that BM, and `otherLivePaths` says so.
 */
export function reachedFrom(
  graph: InfraGraph,
  source: string,
): Record<ReachedKind, ReachedAsset[]> {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: Record<ReachedKind, ReachedAsset[]> = { adAccount: [], pixel: [], page: [] };
  // De-duped: a pixel rooted in AND shared with the same BM arrives as two edges to one node.
  const targets = new Set(graph.edges.filter((e) => e.source === source).map((e) => e.target));

  for (const target of targets) {
    const node = nodeById.get(target);
    if (!node || node.kind === "profile" || node.kind === "bm") continue;
    const survivors = new Set(
      graph.edges
        .filter((e) => e.target === target && e.source !== source && !e.dead)
        .map((e) => e.source),
    );
    out[node.kind].push({
      id: node.entityId,
      name: node.name,
      risk: node.risk.level,
      detail: node.detail,
      otherLivePaths: survivors.size,
    });
  }
  for (const kind of REACHED_KINDS) {
    out[kind].sort((a, b) => a.otherLivePaths - b.otherLivePaths || a.name.localeCompare(b.name));
  }
  return out;
}
