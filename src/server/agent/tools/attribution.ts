/**
 * Campaign→client attribution: explaining one campaign's owner, and the guarded write that settles
 * it.
 *
 * The assistant could already report the unassigned-spend BACKLOG (a total and a list) but had no way
 * to answer "why is THIS campaign not counted for anyone?" — the ownership ladder lives in
 * `loadCampaignOwnership` and returns only a decision, never a reason. `explain_attribution`
 * reconstructs the reason from the same inputs the ladder uses, so the answer can never disagree with
 * the totals.
 *
 * `assign_campaign_client` is the only write in the tool registry that changes whose money a campaign
 * is. It is preview-by-default and refuses ambiguity: see its description for the confirmation
 * protocol.
 */
import { searchEntities, fetchCampaigns } from "@/server/fns/dashboard";
import { fetchClients, setCampaignClient, listCampaignOverrides } from "@/server/fns/clients";
import {
  loadCampaignOwnership,
  type CampaignOwnership,
  type CampaignRef,
} from "@/server/fns/campaign-attribution";
import {
  attributeCampaign,
  brandVocab,
  nameTokens,
  normalizeName,
  type BrandVocab,
} from "@/lib/attribution";
import { scanUnassignedSpend } from "@/sync/alerts";
import {
  WINDOW_PROPS,
  isResolveError,
  resolveClient,
  toolWindow,
  type AgentTool,
  type DateWindow,
  type ResolveError,
} from "./kit";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The rung of the ownership ladder that decided this campaign. */
type AttributionReason =
  | "manual_override"
  | "brand_name_match"
  | "sole_account_claimant"
  | "active_account_tiebreak"
  | "contested_unattributed"
  | "unclaimed_account";

interface Attribution {
  ownerId: string | null;
  ownerName: string | null;
  reason: AttributionReason;
  /** Prose the model can quote to the user verbatim. */
  explanation: string;
  /** Every current client claiming the ad account. Length > 1 = contested. */
  claimants: { id: string; name: string }[];
  contested: boolean;
  /** For a brand-name match: the exact brand strings/tokens that linked the campaign to the client. */
  matchedOn?: { keys?: string[]; tokens?: string[] };
}

/**
 * Re-derive the ownership DECISION together with the rung that produced it.
 *
 * `ownerOf` deliberately exposes no reason, and duplicating the ladder here would be a second source
 * of truth, so this runs the same ordered checks over the same data and then asserts nothing about
 * the outcome: the owner reported is always `ownership.ownerOf(...)`, never this function's guess.
 */
function describeAttribution(
  campaign: CampaignRef,
  ownership: CampaignOwnership,
  overrides: Record<string, string>,
  vocabById: Map<string, BrandVocab>,
): Attribution {
  const claimants = ownership.claimantsOf(campaign.accountId);
  const contested = claimants.length > 1;
  const ownerId = ownership.ownerOf(campaign);
  const ownerName = ownerId ? ownership.nameOf(ownerId) : null;
  const base = { ownerId, ownerName, claimants, contested };
  const overrideClientId = overrides[campaign.id];

  if (overrideClientId) {
    const name = ownership.nameOf(overrideClientId) ?? overrideClientId;
    return {
      ...base,
      reason: "manual_override",
      explanation: `A manual override assigns "${campaign.name}" to ${name}. Overrides are set by an admin and beat every automatic rule, so the campaign name and the ad account's claimants are ignored here.`,
    };
  }

  if (claimants.length === 0) {
    return {
      ...base,
      reason: "unclaimed_account",
      explanation: `No current client claims ad account ${campaign.accountId}, so nothing can own "${campaign.name}". This is a Notion MAPPING gap (the account is not listed on any live client's board row), not an attribution dispute — fixing it means adding the account to the right client in Notion, not setting an override.`,
    };
  }

  if (claimants.length === 1) {
    return {
      ...base,
      reason: "sole_account_claimant",
      explanation: `Ad account ${campaign.accountId} is claimed by exactly one current client, ${claimants[0].name}, so every campaign on it — including "${campaign.name}" — belongs to that client. No name matching was needed.`,
    };
  }

  // Contested account: the campaign NAME decides, exactly as the ladder does it.
  const vocabs = claimants
    .map((c) => vocabById.get(c.id))
    .filter((v): v is BrandVocab => v !== undefined);
  const byName = attributeCampaign(campaign.name, vocabs);
  const claimantList = claimants.map((c) => c.name).join(", ");

  if (byName) {
    const vocab = vocabById.get(byName);
    const norm = normalizeName(campaign.name);
    const toks = new Set(nameTokens(campaign.name));
    const keys = vocab ? vocab.keys.filter((k) => norm.includes(k)) : [];
    const tokens = keys.length === 0 && vocab ? vocab.tokens.filter((t) => toks.has(t)) : [];
    const how =
      keys.length > 0
        ? `the brand name ${keys.map((k) => `"${k}"`).join(" / ")} appears inside the campaign name`
        : `the campaign name shares the distinctive brand token(s) ${tokens.map((t) => `"${t}"`).join(", ")} with that client's Notion brand titles`;
    return {
      ...base,
      reason: "brand_name_match",
      matchedOn: keys.length > 0 ? { keys } : { tokens },
      explanation: `Ad account ${campaign.accountId} is CONTESTED — ${claimants.length} current clients claim it (${claimantList}) because it has been reused across clients over time — so ownership is decided by the campaign NAME. "${campaign.name}" was matched to ${ownerName ?? byName} because ${how}.`,
    };
  }

  if (ownerId) {
    return {
      ...base,
      reason: "active_account_tiebreak",
      explanation: `Ad account ${campaign.accountId} is CONTESTED (${claimants.length} clients claim it: ${claimantList}) and the campaign name "${campaign.name}" matches none of them distinctly. It falls to ${ownerName ?? ownerId} because that client designates this account as its Notion "Active Account ID" while the others only list it under "Other ad accounts".`,
    };
  }

  return {
    ...base,
    reason: "contested_unattributed",
    explanation: `UNATTRIBUTED. Ad account ${campaign.accountId} is contested by ${claimants.length} clients (${claimantList}), the campaign name "${campaign.name}" matches none of them distinctly (or matches several equally), and no single client designates the account as its Notion "Active Account ID". Its spend is therefore counted for NOBODY — it is excluded from every client's totals and reports until an admin sets an override.`,
  };
}

interface ResolvedCampaign {
  id: string;
  name: string;
  accountId: string;
}

/**
 * Fuzzy-resolve a campaign name/id to exactly ONE campaign, or return candidates to disambiguate.
 *
 * Never guesses between several matches: the write built on top of this moves money between clients,
 * so picking "the first match" would be a silent mis-assignment.
 */
async function resolveCampaign(query: string): Promise<ResolvedCampaign | ResolveError> {
  const q = query.trim();
  if (!q) return { error: "No campaign given. Ask the user which campaign they mean." };
  const ents = await searchEntities(q);
  const found = ents.campaigns;
  if (found.length === 0) {
    return {
      error: `No campaign matches "${query}". Try search_entities with a shorter fragment of the name, or list_unassigned_spend / get_client_stats to see the exact campaign names.`,
    };
  }
  const lower = q.toLowerCase();
  const exact = found.filter((c) => c.id === q || c.name.toLowerCase() === lower);
  const pool = exact.length > 0 ? exact : found;
  if (pool.length === 1) {
    return { id: pool[0].id, name: pool[0].name, accountId: pool[0].accountId };
  }
  return {
    error: `"${query}" matches ${pool.length} campaigns. Ask the user which one (or pass the exact campaign name or campaign id).`,
    candidates: pool.map((c) => `${c.name} (id ${c.id}, account ${c.accountId})`).slice(0, 10),
  };
}

/** Brand recognition vocabulary per client, built from the same sources the ladder uses. */
async function loadVocab(): Promise<Map<string, BrandVocab>> {
  const clients = await fetchClients();
  return new Map<string, BrandVocab>(
    clients
      .filter((c) => c.removedAt == null)
      .map((c) => [c.id, brandVocab(c.id, c.name, c.brands)]),
  );
}

/** One campaign's window spend + account name, scoped to its own ad account (one cheap fetch). */
async function campaignFacts(
  campaign: ResolvedCampaign,
  window: DateWindow,
): Promise<{ spend: number | null; accountName: string | null; status: string | null }> {
  const rows = await fetchCampaigns(window, [campaign.accountId]);
  const row = rows.find((c) => c.id === campaign.id);
  if (!row) return { spend: null, accountName: null, status: null };
  return { spend: round2(row.spend), accountName: row.accountName, status: row.status };
}

export const explainAttribution: AgentTool = {
  label: "attribution",
  definition: {
    name: "explain_attribution",
    description:
      "WHY a single campaign's spend is counted for the client it is counted for — or for nobody. Fuzzy-matches the campaign by name (or id) and returns: `campaign` (id, name, ad account id + name, status), `attributedTo` (the owning client, or null when nothing owns it), `reason` — one of manual_override (an admin pinned it), brand_name_match (a contested account split by campaign name), sole_account_claimant (only one client claims the ad account), active_account_tiebreak (name matching failed; the account is that client's designated Notion 'Active Account ID'), contested_unattributed (several clients claim the account, the name settles nothing, so the spend counts for NOBODY), or unclaimed_account (no live client lists the account at all — a Notion mapping gap, not an attribution dispute) — plus `explanation` (a full sentence you can relay to the user verbatim), `accountClaimants` (every current client claiming that ad account; more than one = contested), `matchedOn` (the exact brand strings/tokens that produced a brand_name_match), and `spend` over the window. When the campaign is unattributed it also returns `unassignedBacklog` (its 90-day unassigned spend and the candidate owners) and `fix`, naming the assign_campaign_client tool. Use this whenever a user asks why a campaign shows under a given client, why it is missing from a client's totals, or drills into ONE row from list_unassigned_spend. Use list_unassigned_spend instead for the book-wide backlog, and get_client_stats for a client's numbers — this tool explains one campaign and returns no performance breakdown.",
    input_schema: {
      type: "object",
      properties: {
        campaign: {
          type: "string",
          description:
            "Campaign name (fuzzy substring) or exact campaign id. Ambiguous names come back as candidates rather than a guess.",
        },
        ...WINDOW_PROPS,
      },
      required: ["campaign"],
    },
  },
  async run(input) {
    const campaign = await resolveCampaign(String(input.campaign ?? ""));
    if (isResolveError(campaign)) return campaign;

    const window = toolWindow(input);
    const [ownership, overrides, vocabById, facts] = await Promise.all([
      loadCampaignOwnership(),
      listCampaignOverrides(),
      loadVocab(),
      campaignFacts(campaign, window),
    ]);
    const a = describeAttribution(campaign, ownership, overrides, vocabById);

    const payload: Record<string, unknown> = {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        accountId: campaign.accountId,
        ...(facts.accountName ? { accountName: facts.accountName } : {}),
        ...(facts.status ? { status: facts.status } : {}),
      },
      attributedTo: a.ownerId ? { id: a.ownerId, name: a.ownerName ?? a.ownerId } : null,
      reason: a.reason,
      explanation: a.explanation,
      contestedAccount: a.contested,
      accountClaimants: a.claimants,
      ...(a.matchedOn ? { matchedOn: a.matchedOn } : {}),
      ...(facts.spend === null
        ? {}
        : { spend: { since: window.since, until: window.until, amount: facts.spend } }),
    };

    if (a.ownerId === null) {
      // Only worth a book-wide scan once we know this campaign counts for nobody.
      const backlog = await scanUnassignedSpend();
      const row = backlog.find((r) => r.id === campaign.id);
      payload.unassignedBacklog = row
        ? {
            spendLast90Days: round2(row.spend),
            candidateOwners: row.claimants,
            inAlertBacklog: true,
          }
        : {
            inAlertBacklog: false,
            note: "Below the $1 / 90-day alert threshold, so it is not in the unassigned-spend alert list.",
          };
      payload.fix =
        a.reason === "unclaimed_account"
          ? "An override cannot fix a mapping gap cleanly: the ad account needs adding to the correct client's Notion board row. Say so rather than offering an assignment."
          : "An admin can settle this with assign_campaign_client (campaign + client). That tool previews the change first and only writes after the user confirms.";
    }
    return payload;
  },
};

export const assignCampaignClient: AgentTool = {
  label: "assign campaign",
  requires: "admin",
  definition: {
    name: "assign_campaign_client",
    description:
      "WRITE — pins a campaign to a client with a manual override, which permanently changes whose spend it is in every total, report, client page and alert. Admin only. TWO-STEP AND CONFIRMED BY THE USER, ALWAYS:\n" +
      "STEP 1 (default): call it with `campaign` and `client` and NO `confirm`. Nothing is written. You get back `confirmationRequired: true` plus the resolved campaign (id, name, ad account), the resolved client, `currentlyAttributedTo` with the `reason` it is attributed that way today, and `spendThatWouldMove` (the campaign's last-90-day spend, which stops counting where it counts now and starts counting for the target client). Show the user those exact details — campaign name, current owner, new owner, dollar amount — and ASK them to confirm.\n" +
      "STEP 2: only after the user has said yes IN THE CONVERSATION, call again with the identical `campaign` and `client` plus `confirm: true`. You then get `{ ok: true, changed, nowAttributedTo }`.\n" +
      "NEVER pass `confirm: true` on the user's behalf. Not on a first call, not because the preview looked correct, not because the user asked you to 'fix the unassigned spend' in general, and not to save a round trip: the user must have seen the preview and agreed to that specific campaign→client move. If they have not, do STEP 1 and wait.\n" +
      "Both `campaign` and `client` are required and each is fuzzy-matched. If either matches more than one thing you get `{ error, candidates }` and NOTHING is written — ask the user which one instead of picking. If the campaign is already attributed to that client you get `noChange: true` and no write happens. Use explain_attribution first when you do not already know why the campaign is unattributed, and prefer telling the user to fix Notion when the reason is unclaimed_account (a mapping gap) — an override there just papers over a missing account mapping. This tool cannot clear an existing override; that is a UI action.",
    input_schema: {
      type: "object",
      properties: {
        campaign: {
          type: "string",
          description:
            "Campaign name (fuzzy substring) or exact campaign id. Required. Ambiguous = refused with candidates.",
        },
        client: {
          type: "string",
          description:
            "Client name, client id, or Notion brand title. Required. Ambiguous = refused with candidates.",
        },
        confirm: {
          type: "boolean",
          description:
            "Omit (or false) to PREVIEW without writing. Pass true ONLY after the user has seen the preview in this conversation and explicitly agreed to this campaign→client move.",
        },
      },
      required: ["campaign", "client"],
    },
  },
  async run(input) {
    const campaignQ = String(input.campaign ?? "").trim();
    const clientQ = String(input.client ?? "").trim();
    if (!campaignQ || !clientQ) {
      return {
        error:
          "Both `campaign` and `client` are required. Ask the user which campaign and which client before calling again.",
      };
    }

    const [campaign, client] = await Promise.all([
      resolveCampaign(campaignQ),
      resolveClient(clientQ),
    ]);
    // Ambiguity or a miss on EITHER side aborts before any write.
    if (isResolveError(campaign)) return campaign;
    if (isResolveError(client)) return client;

    const window = toolWindow({ days: 90 });
    const [ownership, overrides, vocabById, facts] = await Promise.all([
      loadCampaignOwnership(),
      listCampaignOverrides(),
      loadVocab(),
      campaignFacts(campaign, window),
    ]);
    const before = describeAttribution(campaign, ownership, overrides, vocabById);
    const target = {
      id: client.id,
      name: client.name,
      ...(client.matchedBrand ? { matchedBrand: client.matchedBrand } : {}),
    };
    const resolvedCampaign = {
      id: campaign.id,
      name: campaign.name,
      accountId: campaign.accountId,
      ...(facts.accountName ? { accountName: facts.accountName } : {}),
    };
    const spendThatWouldMove = {
      since: window.since,
      until: window.until,
      amount: facts.spend ?? 0,
    };

    if (before.ownerId === client.id) {
      return {
        noChange: true,
        campaign: resolvedCampaign,
        client: target,
        reason: before.reason,
        explanation: before.explanation,
        message: `"${campaign.name}" already counts for ${client.name} (${before.reason}). Nothing was written. Tell the user no change is needed.`,
      };
    }

    if (input.confirm !== true) {
      return {
        confirmationRequired: true,
        written: false,
        action: "assign_campaign_client",
        campaign: resolvedCampaign,
        client: target,
        currentlyAttributedTo: before.ownerId
          ? { id: before.ownerId, name: before.ownerName ?? before.ownerId }
          : null,
        reason: before.reason,
        explanation: before.explanation,
        accountClaimants: before.claimants,
        spendThatWouldMove,
        effect: `Setting this override makes $${spendThatWouldMove.amount} of last-90-day spend on "${campaign.name}" count for ${client.name}${before.ownerName ? ` instead of ${before.ownerName}` : " (it currently counts for nobody)"}, in every total, report, client page and alert, from now on and retroactively.`,
        message:
          "NOTHING HAS BEEN WRITTEN. Show the user the campaign, its ad account, the current owner, the new owner and the dollar amount above, and ask them to confirm. Only if they explicitly agree, call assign_campaign_client again with the same campaign and client plus confirm: true. Do not confirm on their behalf.",
      };
    }

    const res = await setCampaignClient(campaign.id, client.id);
    if (!res.ok) {
      return {
        written: false,
        error: res.error ?? "The assignment was rejected.",
        campaign: resolvedCampaign,
        client: target,
      };
    }

    // Re-read the ladder so the reported outcome is the stored state, not an assumption.
    const after = await loadCampaignOwnership();
    const nowOwnerId = after.ownerOf(campaign);
    return {
      ok: true,
      written: true,
      campaign: resolvedCampaign,
      changed: {
        from: before.ownerId
          ? { id: before.ownerId, name: before.ownerName ?? before.ownerId }
          : null,
        to: target,
        previousReason: before.reason,
      },
      nowAttributedTo: nowOwnerId
        ? { id: nowOwnerId, name: after.nameOf(nowOwnerId) ?? nowOwnerId }
        : null,
      spendMoved: spendThatWouldMove,
      note: `Manual override recorded and audited. "${campaign.name}" now counts for ${client.name} everywhere, and its unassigned-spend alert (if any) clears on the next reconcile. Clearing this override is a UI action, not a tool.`,
    };
  },
};

/** Campaign→client attribution, including the write that clears unassigned spend. */
export const attributionTools: AgentTool[] = [explainAttribution, assignCampaignClient];
