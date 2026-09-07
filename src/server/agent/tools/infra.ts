/**
 * Ban resilience: the infrastructure registry, its access paths, and the blast radius of losing one.
 *
 * Everything here is admin-only, exactly as the /infrastructure screens are, so every tool declares
 * `requires: "admin"` — the registry both hides these definitions from a non-admin and refuses the
 * call.
 *
 * On guards: `buildRiskMap()` is the UNGUARDED inner read that `fetchRiskMap()` wraps, and it is what
 * this module uses — the `requires: "admin"` gate above is the authorisation, so re-entering a
 * cookie-reading guard would only add a second way to fail. `fetchBms`, `fetchBmDetail`,
 * `previewBmBan` and `fetchAdAccounts` have no unguarded inner function, so they are called as-is.
 * That ASSUMES the chat turn runs inside the caller's request — it does; `ToolContext.role` comes
 * from that same session — and the guard is deliberately not weakened to remove the assumption: if a
 * background caller ever runs the agent without a session, `requireAdmin` throws and `runTool` turns
 * it into error data the model can report.
 */
import { disableReasonLabel } from "@/lib/format";
import { nodeId, reachedFrom } from "@/lib/infra-graph";
import { AD_ACCOUNT_USAGE, isAdAccountUsage, type AdAccountUsage } from "@/lib/infra-status";
import { fetchAdAccounts } from "@/server/fns/infra/ad-accounts";
import { fetchBmDetail, fetchBms, previewBmBan, type BmView } from "@/server/fns/infra/bms";
import { buildRiskMap, type InfraRiskRow } from "@/server/fns/infra/risk";
import { isResolveError, type AgentTool, type ResolveError } from "./kit";

/**
 * The one rule behind every number these tools return, repeated into each description on purpose:
 * the model has to be able to REASON about the counts, not just read them back.
 */
const RISK_RULE =
  'Core rule: an asset is at risk when it has fewer than two INDEPENDENT access paths — 0 usable paths = "critical" (label "No backup": one ban and the asset is gone), 1 = "warning" (label "Single access"), 2+ = "safe" (label "Redundant"). A path counts only while it can actually grant access: a profile that is suspended/restricted/has lost access, or a BM that is suspended or in_review, is a DEAD path and counts as zero — so "3 BMs linked, 1 usable" is a warning, not a safe.';

/** At-risk rows per kind in `get_infra_risk`. The registry is a few hundred rows; the tail is noise. */
const RISK_CAP = 25;
/** Named blast-radius rows per kind in `preview_bm_ban`. */
const LOSS_CAP = 40;
/** Ad-account rows in `list_spare_accounts`. */
const ACCOUNT_CAP = 60;

/* ------------------------------------------------------------------ risk map */

/** Non-safe rows only, worst-first — they arrive sorted critical → warning → safe. */
function riskSection(rows: InfraRiskRow[], withId = false) {
  const hits = rows.filter((r) => r.risk.level !== "safe");
  const critical = hits.filter((r) => r.risk.level === "critical").length;
  return {
    atRisk: hits.length,
    critical,
    warning: hits.length - critical,
    rows: hits.slice(0, RISK_CAP).map((r) => ({
      ...(withId ? { id: r.id } : {}),
      name: r.name,
      status: r.status,
      risk: r.risk.level,
      label: r.risk.label,
      detail: r.detail,
      ...(r.overdue ? { verificationOverdue: true } : {}),
    })),
    ...(hits.length > RISK_CAP
      ? { truncated: `showing the worst ${RISK_CAP} of ${hits.length}` }
      : {}),
  };
}

const getInfraRisk: AgentTool = {
  label: "infra risk",
  requires: "admin",
  definition: {
    name: "get_infra_risk",
    description:
      'Ban-resilience summary of the whole infrastructure registry — Facebook profiles, Business Managers, ad accounts, pixels and pages — i.e. "how exposed are we if Meta bans something?". ' +
      RISK_RULE +
      " Returns `counts` (how many of each kind are registered; `counts.adAccounts` includes retired ones, while the at-risk list below excludes them, because a retired account with no access path is not a problem to solve), `atRisk` (total non-safe assets across BMs + ad accounts + pixels + pages), and a section per kind — `bms`, `adAccounts`, `pixels`, `pages` — each holding `atRisk`/`critical`/`warning` counts plus `rows`, the worst " +
      String(RISK_CAP) +
      ' of them. Every row carries `name`, `status` (the asset\'s OWN status, a different question from its risk — for an ad account this is the operator lifecycle in_use/spare/retired, not a Meta status), `risk` (critical|warning|safe), `label` (the human verdict) and `detail` (the access paths behind that verdict, e.g. "2 usable profiles", "via BM Alpha, BM Beta", "root BM Alpha · 1 share", "3 BMs · 0 extra profiles"). BM rows may add `verificationOverdue: true`, meaning nobody has attested that BM in 30+ days. Use this for any question about redundancy, single points of failure, what is exposed, or registry totals. For the blast radius of ONE named BM use preview_bm_ban; for spare-account inventory use list_spare_accounts.',
    input_schema: { type: "object", properties: {} },
  },
  async run() {
    const map = await buildRiskMap();
    return {
      counts: map.counts,
      atRisk: map.atRisk,
      bms: riskSection(map.bms),
      adAccounts: riskSection(map.adAccounts, true),
      pixels: riskSection(map.pixels),
      pages: riskSection(map.pages),
      note: "Only non-safe assets are listed; anything absent is redundant. Profiles get no risk table of their own — they are the access paths that make everything else safe or not.",
    };
  },
};

/* -------------------------------------------------------------- BM ban preview */

/** Fuzzy-match a BM by registry id, Meta BM id, or name. Ambiguity comes back as data, never a throw. */
async function resolveBm(query: string): Promise<BmView | ResolveError> {
  const bms = await fetchBms();
  if (bms.length === 0)
    return { error: "No Business Managers are registered yet. Add them under Infrastructure." };
  const q = query.trim().toLowerCase();
  const names = bms.map((b) => b.name);
  if (!q) return { error: "Which Business Manager?", candidates: names.slice(0, 25) };

  const exact = bms.find(
    (b) => b.id === q || b.bmId.toLowerCase() === q || b.name.toLowerCase() === q,
  );
  if (exact) return exact;

  // Punctuation/spacing-insensitive, so "DOTMedia3" still finds "DOT Media 3".
  const nq = q.replace(/[^a-z0-9]+/g, "");
  const matches = bms.filter(
    (b) =>
      b.name.toLowerCase().includes(q) ||
      b.bmId.includes(q) ||
      (nq !== "" &&
        b.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "")
          .includes(nq)),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1)
    return {
      error: `Multiple Business Managers match "${query}". Ask the user which one.`,
      candidates: matches.map((m) => `${m.name} (${m.bmId})`).slice(0, 10),
    };
  return { error: `No Business Manager matches "${query}".`, candidates: names.slice(0, 25) };
}

/* `reachedFrom` in `@/lib/infra-graph` is the blast-radius traversal — the screen's risk matrix and
 * this preview call the same function, so a ban preview can never disagree with the drawn map. */

const previewBmBanTool: AgentTool = {
  label: "BM ban preview",
  requires: "admin",
  definition: {
    name: "preview_bm_ban",
    description:
      "Blast radius of losing ONE Business Manager: what we could no longer reach if Meta banned it today. This is the sharpest question in the infrastructure domain — prefer it over get_infra_risk whenever the user names a specific BM. " +
      RISK_RULE +
      " Returns `bm` (the matched BM: `name`, Meta `bmId`, `status`, `type`, `verifiedAt`), `impact` — `adAccountsLosingAPath` (registered ad accounts linked to this BM), `adAccountsLeftWithNoPath` (of those, how many would have NO usable BM left: the real damage number) and `profileLinksLost` (admin profiles that lose their route in) — and `admins`, the profiles administering it, where `usable: false` marks one that is already a dead path. `stranded` names the assets this BM is the ONLY live path to, split into `adAccounts`, `pixels` and `pages`, each row carrying `name`, `id`, `risk`, `detail` and `otherLivePaths: 0`. `alsoLosesAPath` lists, by name only, the assets that would survive through another live BM or profile. Empty `stranded` plus a full `alsoLosesAPath` means the ban would hurt but lock us out of nothing. Note that retired ad accounts are absent from the NAMED lists (they are excluded from the risk graph) yet still counted in `impact`, so the two can legitimately differ. The BM is fuzzy-matched on name or Meta id; an ambiguous name returns `error` + `candidates` — ask the user which one instead of guessing.",
    input_schema: {
      type: "object",
      properties: {
        bm: { type: "string", description: "Business Manager name or Meta BM id. Fuzzy-matched." },
      },
      required: ["bm"],
    },
  },
  async run(input) {
    const bm = await resolveBm(String(input.bm ?? ""));
    if (isResolveError(bm)) return bm;

    const [impact, map, detail] = await Promise.all([
      previewBmBan({ id: bm.id }),
      buildRiskMap(),
      fetchBmDetail(bm.id),
    ]);
    const radius = reachedFrom(map.graph, nodeId("bm", bm.id));

    const truncated: string[] = [];
    const take = <T>(label: string, rows: T[], cap = LOSS_CAP): T[] => {
      if (rows.length > cap) truncated.push(`${label}: showing ${cap} of ${rows.length}`);
      return rows.slice(0, cap);
    };

    return {
      bm: {
        name: bm.name,
        bmId: bm.bmId,
        status: bm.status,
        type: bm.type,
        verifiedAt: bm.verifiedAt,
        ...(bm.notes ? { notes: bm.notes } : {}),
      },
      impact: {
        adAccountsLosingAPath: impact.accountsLosingAPath,
        adAccountsLeftWithNoPath: impact.accountsLeftWithNone,
        profileLinksLost: impact.profiles,
      },
      admins: take(
        "admins",
        (detail?.profiles ?? []).map((p) => ({
          name: p.name,
          usable: p.usable,
          statuses: p.statuses,
        })),
        25,
      ),
      stranded: {
        adAccounts: take(
          "stranded adAccounts",
          radius.adAccount.filter((a) => !a.otherLivePaths),
        ),
        pixels: take(
          "stranded pixels",
          radius.pixel.filter((a) => !a.otherLivePaths),
        ),
        pages: take(
          "stranded pages",
          radius.page.filter((a) => !a.otherLivePaths),
        ),
      },
      alsoLosesAPath: {
        adAccounts: take(
          "alsoLosesAPath adAccounts",
          radius.adAccount.filter((a) => a.otherLivePaths > 0).map((a) => a.name),
        ),
        pixels: take(
          "alsoLosesAPath pixels",
          radius.pixel.filter((a) => a.otherLivePaths > 0).map((a) => a.name),
        ),
        pages: take(
          "alsoLosesAPath pages",
          radius.page.filter((a) => a.otherLivePaths > 0).map((a) => a.name),
        ),
      },
      ...(truncated.length ? { truncated } : {}),
    };
  },
};

/* --------------------------------------------------------------- ad accounts */

const listSpareAccounts: AgentTool = {
  label: "ad account registry",
  requires: "admin",
  definition: {
    name: "list_spare_accounts",
    description:
      'Inventory of the operator-owned ad-account registry by lifecycle state — the answer to "how many spare accounts do we have?" and "what could we move a client onto?". `usage_state` is OUR lifecycle, not a Meta status: `in_use` (running), `spare` (held in reserve), `retired` (finished with). Defaults to `spare`; pass `all` for the whole registry. Always returns `counts` for all three states plus `total`, then `matched` and `accounts` for the requested state. Each account carries `id` (act_… — the join key to every performance tool), `label`, `usageState`, `bms` (the NAMES of the Business Managers that can reach it: an empty list means the account is registered but unreachable, and a single entry is a single point of failure — ' +
      RISK_RULE +
      " ), `notes`, and `synced`, the live facts joined from the hourly Meta sync: `name`, `status` (ACTIVE/PAUSED/DISABLED), `disableReason` (humanised, present only when disabled), `spendCap` and `balance` in whole currency units, and `currency`. `synced` is ABSENT when the account is not in our synced book — our token cannot see it, which matters before promising it as a usable spare. Capped at " +
      String(ACCOUNT_CAP) +
      " rows. For per-account redundancy verdicts use get_infra_risk; for spend and delivery use list_accounts or get_overview.",
    input_schema: {
      type: "object",
      properties: {
        usage_state: {
          type: "string",
          enum: [...AD_ACCOUNT_USAGE, "all"],
          description: "Lifecycle filter. Default 'spare'. Use 'all' for the whole registry.",
        },
      },
    },
  },
  async run(input) {
    const raw =
      typeof input.usage_state === "string" && input.usage_state ? input.usage_state : "spare";
    const state: AdAccountUsage | "all" | null =
      raw === "all" ? "all" : isAdAccountUsage(raw) ? raw : null;
    if (state === null)
      return {
        error: `Unknown usage_state "${raw}". Use one of: ${AD_ACCOUNT_USAGE.join(", ")}, all.`,
      };

    const [accounts, bms] = await Promise.all([fetchAdAccounts(), fetchBms()]);
    const bmName = new Map(bms.map((b) => [b.id, b.name]));

    const counts = { in_use: 0, spare: 0, retired: 0, total: accounts.length };
    // A row whose lifecycle is not in the vocabulary is corrupt data, and hiding it would be worse
    // than a stray key: the totals would silently stop adding up.
    let unrecognisedState = 0;
    for (const a of accounts) {
      if (isAdAccountUsage(a.usageState)) counts[a.usageState]++;
      else unrecognisedState++;
    }

    const rows = accounts.filter((a) => state === "all" || a.usageState === state);
    return {
      usageState: state,
      counts: { ...counts, ...(unrecognisedState ? { unrecognisedState } : {}) },
      matched: rows.length,
      accounts: rows.slice(0, ACCOUNT_CAP).map((a) => ({
        id: a.id,
        ...(a.label ? { label: a.label } : {}),
        usageState: a.usageState,
        bms: a.bmIds.map((id) => bmName.get(id) ?? id),
        ...(a.notes ? { notes: a.notes } : {}),
        ...(a.synced
          ? {
              synced: {
                name: a.synced.name,
                status: a.synced.status,
                ...(disableReasonLabel(a.synced.disableReason)
                  ? { disableReason: disableReasonLabel(a.synced.disableReason) }
                  : {}),
                // Meta reports money in minor units; every screen divides by 100 before showing it.
                ...(a.synced.spendCap == null
                  ? {}
                  : { spendCap: Math.round(a.synced.spendCap) / 100 }),
                ...(a.synced.balance == null
                  ? {}
                  : { balance: Math.round(a.synced.balance) / 100 }),
                currency: a.synced.currency,
              },
            }
          : {}),
      })),
      ...(rows.length > ACCOUNT_CAP
        ? { truncated: `showing ${ACCOUNT_CAP} of ${rows.length}` }
        : {}),
    };
  },
};

/** Ban resilience: the infra registry, access paths and blast radius. */
export const infraTools: AgentTool[] = [getInfraRisk, previewBmBanTool, listSpareAccounts];
