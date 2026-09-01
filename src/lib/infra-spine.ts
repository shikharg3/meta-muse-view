/**
 * The access graph reshaped into the picture an operator can actually read.
 *
 * `infra-graph.ts` produces the truthful node-link graph. Drawn literally it is unreadable on a real
 * registry, and the reason is structural rather than cosmetic: the overwhelming majority of entities
 * are leaves or isolates, so the handful of relationships that decide whether you can still get in are
 * buried under a hundred that do not. Measured on the live registry: 26 of 37 profiles admin no BM at
 * all, every page is owned by exactly one profile and linked to no BM, and one profile owns 33 pages.
 *
 * So this module sorts the same data into the three shapes it really has:
 *
 *  - **The spine.** Business Managers are the hubs. A profile that admins exactly one BM is drawn
 *    INSIDE that BM, because containment says "belongs to" without a line to trace. Only a profile
 *    admining two or more BMs is drawn outside with edges — which makes a shared point of failure the
 *    one visually exceptional thing on the canvas, instead of one dot among a hundred.
 *  - **Page groups.** Owner-to-page is a flat one-to-many list, not a network. It gets a list.
 *  - **Unattached.** Profiles wired to nothing. They are registry entries, not access paths, and
 *    drawing them as free-floating nodes in a graph was pure noise.
 *
 * Pure and total: no node is dropped from the picture. A profile that both admins a BM and owns pages
 * appears on the spine AND as a page-group owner, because the two answer different questions about
 * it; `unattached` is exactly the complement of everything the map draws.
 */
import { RISK_ORDER } from "./infra-risk";
import type { InfraGraph, InfraGraphNode, InfraRelation } from "./infra-graph";

/** A profile admining a BM. `dead` restates that the profile cannot currently carry access. */
export interface SpineAdmin {
  profile: InfraGraphNode;
  dead: boolean;
}

export interface SpineBm {
  bm: InfraGraphNode;
  /** Admins this BM and nothing else — drawn inside the card. */
  inside: SpineAdmin[];
  /** Also admins another BM — drawn once outside, with an edge to each card. */
  shared: SpineAdmin[];
  /** Admins that can actually carry access right now; the number the BM's risk is computed from. */
  usableAdmins: number;
}

/** An ad account or pixel, and the BMs that reach it. */
export interface SpineEndpoint {
  node: InfraGraphNode;
  from: { bmId: string; relation: InfraRelation; dead: boolean }[];
}

export interface SpinePageGroup {
  owner: InfraGraphNode;
  /** Risk-first, like every other list in the feature. */
  pages: InfraGraphNode[];
  atRisk: number;
  /** The owner cannot carry access, so every page under it is held by a dead hand. */
  dead: boolean;
}

export interface InfraSpine {
  bms: SpineBm[];
  /** Profiles admining two or more BMs, in the order the cards they touch appear. */
  sharedProfiles: InfraGraphNode[];
  endpoints: SpineEndpoint[];
  pageGroups: SpinePageGroup[];
  /** Admins no BM and owns no page: in the registry, absent from every access path. */
  unattached: InfraGraphNode[];
}

const byRisk = (a: InfraGraphNode, b: InfraGraphNode) =>
  RISK_ORDER[a.risk.level] - RISK_ORDER[b.risk.level] || a.name.localeCompare(b.name);

export function buildSpine(graph: InfraGraph): InfraSpine {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  // One pass over the edges; every later grouping reads these instead of re-scanning.
  const adminsOf = new Map<string, { profileId: string; dead: boolean }[]>();
  const bmsAdminedBy = new Map<string, number>();
  const endpointSources = new Map<string, SpineEndpoint["from"]>();
  const pagesByOwner = new Map<string, InfraGraphNode[]>();

  for (const e of graph.edges) {
    if (e.relation === "admin") {
      const list = adminsOf.get(e.target);
      if (list) list.push({ profileId: e.source, dead: e.dead });
      else adminsOf.set(e.target, [{ profileId: e.source, dead: e.dead }]);
      bmsAdminedBy.set(e.source, (bmsAdminedBy.get(e.source) ?? 0) + 1);
      continue;
    }
    if (e.relation === "owns") {
      const page = nodeById.get(e.target);
      if (!page) continue;
      const list = pagesByOwner.get(e.source);
      if (list) list.push(page);
      else pagesByOwner.set(e.source, [page]);
      continue;
    }
    // Whatever is left points at an ad account or a pixel: `root`, `share`, or a BM's `access`.
    // Page `access` edges are deliberately ignored — pages live in the strip, not on the spine.
    const target = nodeById.get(e.target);
    if (!target || (target.kind !== "adAccount" && target.kind !== "pixel")) continue;
    const entry = { bmId: e.source, relation: e.relation, dead: e.dead };
    const list = endpointSources.get(e.target);
    if (list) list.push(entry);
    else endpointSources.set(e.target, [entry]);
  }

  const bms: SpineBm[] = graph.nodes
    .filter((n) => n.kind === "bm")
    .sort(byRisk)
    .map((bm) => {
      const inside: SpineAdmin[] = [];
      const shared: SpineAdmin[] = [];
      let usableAdmins = 0;
      for (const link of adminsOf.get(bm.id) ?? []) {
        const profile = nodeById.get(link.profileId);
        if (!profile) continue;
        if (!link.dead) usableAdmins += 1;
        ((bmsAdminedBy.get(link.profileId) ?? 0) > 1 ? shared : inside).push({
          profile,
          dead: link.dead,
        });
      }
      inside.sort((a, b) => byRisk(a.profile, b.profile));
      shared.sort((a, b) => byRisk(a.profile, b.profile));
      return { bm, inside, shared, usableAdmins };
    });

  // Ordered by the first card that needs them, so the outside lane reads top-to-bottom with the spine.
  const sharedProfiles: InfraGraphNode[] = [];
  const seenShared = new Set<string>();
  for (const entry of bms) {
    for (const admin of entry.shared) {
      if (seenShared.has(admin.profile.id)) continue;
      seenShared.add(admin.profile.id);
      sharedProfiles.push(admin.profile);
    }
  }

  const endpoints: SpineEndpoint[] = graph.nodes
    .filter((n) => n.kind === "adAccount" || n.kind === "pixel")
    .sort(byRisk)
    .map((node) => ({ node, from: endpointSources.get(node.id) ?? [] }));

  const pageGroups: SpinePageGroup[] = [...pagesByOwner.entries()]
    .flatMap(([ownerId, pages]) => {
      const owner = nodeById.get(ownerId);
      if (!owner) return [];
      const sorted = [...pages].sort(byRisk);
      return [
        {
          owner,
          pages: sorted,
          atRisk: sorted.filter((p) => p.risk.level !== "safe").length,
          dead: owner.risk.level !== "safe",
        },
      ];
    })
    // Most broken pages first, then the biggest group: the two reasons to look at one.
    .sort((a, b) => b.atRisk - a.atRisk || b.pages.length - a.pages.length);

  const unattached = graph.nodes
    .filter(
      (n) =>
        n.kind === "profile" &&
        !bmsAdminedBy.has(n.id) &&
        (pagesByOwner.get(n.id)?.length ?? 0) === 0,
    )
    .sort(byRisk);

  return { bms, sharedProfiles, endpoints, pageGroups, unattached };
}
