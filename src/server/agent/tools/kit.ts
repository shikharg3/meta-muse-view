/**
 * Shared foundation for every agent tool.
 *
 * Tools used to be one 560-line file with an eight-case switch. They are a registry of one module per
 * domain instead, because the switch was the single choke point on everything the assistant could
 * learn to do: adding a domain meant editing the same function every other domain lived in. Each
 * module now owns its file and declares itself; `tools/index.ts` only collects them.
 *
 * The other thing that changed is identity. `runTool` had none — it could not have offered an
 * admin-only capability even if one existed, because it did not know who was asking. Tools now
 * declare `requires`, and the registry both hides the definition from the model and refuses the call.
 * Hiding matters as much as refusing: a tool the model can see but cannot use is a tool it will
 * promise the user.
 */
import { fetchClients, fetchClientDetail, type ClientDetail } from "@/server/fns/clients";
import { searchEntities, resolveAdScopeSubject, type AdScope } from "@/server/fns/dashboard";
import { getClientRow, effectiveAccountIds } from "@/sync/jobs/clients";
import { ownedCampaignIds } from "@/server/fns/campaign-attribution";
import { resolvePreset } from "@/lib/date-presets";
import { windowFromDays, windowFromDates, isYmd, type DateWindow } from "@/lib/range";
import type { AnthropicTool } from "../anthropic";

export type ToolRole = "user" | "admin" | "superadmin";

/** Who is asking. Threaded from the session so a tool can be gated or scoped. */
export interface ToolContext {
  userId: string | null;
  role: string | null;
}

export interface AgentTool {
  definition: AnthropicTool;
  /**
   * Human label for the UI trace. Lives here so it cannot drift: the old client-side lookup table
   * was already missing `get_ad_sets`, which rendered raw at users.
   */
  label: string;
  /** Minimum role. Omitted = any signed-in user. */
  requires?: ToolRole;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

const RANK: Record<ToolRole, number> = { user: 0, admin: 1, superadmin: 2 };

export function meetsRole(role: string | null, required: ToolRole | undefined): boolean {
  if (!required || required === "user") return true;
  const held = role === "superadmin" ? 2 : role === "admin" ? 1 : 0;
  return held >= RANK[required];
}

// Cap trailing windows at the insights retention target (≈37 months) — accounts are backfilled to
// their creation date, so anything within this window that exists is synced. (Explicit since/until
// ranges are not clamped.)
export const MAX_DAYS = 1125;

export function clampDays(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(n, MAX_DAYS);
}

/**
 * Window for the aggregate tools. Precedence: explicit since+until, then a named preset, then a
 * trailing `days` count.
 *
 * The preset arm is the reason this is worth a shared helper. `resolveRange` in the report engine has
 * always accepted the twenty `DATE_PRESETS` keys, but no tool schema advertised them, so the model
 * hand-computed "last month" from today's date on every call — arithmetic it has no business doing
 * and gets wrong around month boundaries.
 */
export function toolWindow(input: Record<string, unknown>): DateWindow {
  if (isYmd(input.since) && isYmd(input.until)) {
    return windowFromDates(String(input.since), String(input.until));
  }
  if (typeof input.preset === "string" && input.preset) {
    const resolved = resolvePreset(input.preset, new Date().toISOString().slice(0, 10));
    if (resolved) return windowFromDates(resolved.since, resolved.until);
  }
  return windowFromDays(clampDays(input.days));
}

/** The date-range properties every windowed tool shares, so their schemas cannot drift apart. */
export const WINDOW_PROPS = {
  preset: {
    type: "string",
    description:
      "Named range — PREFER THIS over hand-computing dates. One of: today, yesterday, last_7d, last_14d, last_30d, last_60d, last_90d, this_week_mon_today, last_week_mon_sun, this_month, last_month, this_quarter, last_quarter, this_year, last_year, maximum.",
  },
  days: {
    type: "integer",
    description:
      "Trailing window ending TODAY (default 30; history goes back to each account's creation, ≈37 months). days=1 = today only.",
  },
  since: { type: "string", description: "Start date YYYY-MM-DD. Overrides preset and days." },
  until: { type: "string", description: "End date YYYY-MM-DD inclusive (use with since)." },
} as const;

export interface ResolvedClient {
  id: string;
  name: string;
  /** Set when resolved by a Notion campaign-row (brand) title rather than the client's own name. */
  matchedBrand?: string;
  /** Other brands grouped under this (agency) client — lets the model add a per-brand caveat. */
  siblingBrands?: string[];
  /** The matched brand row's OWN ad accounts (∩ the client's effective accounts) — lets stats be
   * scoped to just that campaign/brand instead of the whole client. Empty/absent = row carries none. */
  brandAccountIds?: string[];
}

export interface ResolveError {
  error: string;
  candidates?: string[];
}

export const isResolveError = (v: unknown): v is ResolveError =>
  typeof v === "object" && v !== null && "error" in v;

/** Fuzzy-resolve a client name/id to a single client, or return candidates to disambiguate. */
export async function resolveClient(query: string): Promise<ResolvedClient | ResolveError> {
  const clients = (await fetchClients()).filter((c) => c.removedAt == null);
  if (clients.length === 0)
    return { error: "No clients are synced yet. Configure Notion in Settings." };
  const q = query.trim().toLowerCase();
  if (!q)
    return { error: "No client name given.", candidates: clients.map((c) => c.name).slice(0, 20) };

  const exact = clients.find((c) => c.id === q || c.name.toLowerCase() === q);
  if (exact) return { id: exact.id, name: exact.name };

  const slug = q.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const matches = clients.filter((c) => c.name.toLowerCase().includes(q) || c.id.includes(slug));
  if (matches.length === 1) return { id: matches[0].id, name: matches[0].name };
  if (matches.length > 1)
    return {
      error: `Multiple clients match "${query}". Ask the user which one.`,
      candidates: matches.map((m) => m.name).slice(0, 10),
    };

  // No client-NAME match: fall back to Notion brand (campaign-row) titles. Agency clients group
  // several brands under one name (e.g. brand "Lucky Rebel" lives under client "OneAgency"), so a
  // brand query must resolve to its holding client instead of dead-ending as "no client".
  const findBrandHits = (match: (b: string) => boolean) => {
    const hits: { id: string; name: string; brand: string; brands: string[] }[] = [];
    for (const c of clients) {
      const brand = c.brands.find(match);
      if (brand) hits.push({ id: c.id, name: c.name, brand, brands: c.brands });
    }
    return hits;
  };
  // Match punctuation/spacing-insensitively so "LuckyRebel" finds the brand "Lucky Rebel".
  const nq = q.replace(/[^a-z0-9]+/g, "");
  const bnorm = (b: string) => b.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const exactBrands = findBrandHits((b) => b.toLowerCase() === q || (nq !== "" && bnorm(b) === nq));
  const brandHits = exactBrands.length
    ? exactBrands
    : findBrandHits((b) => b.toLowerCase().includes(q) || (nq !== "" && bnorm(b).includes(nq)));
  if (brandHits.length === 1) {
    const h = brandHits[0];
    // Scope to the matched row's own accounts: pages in clients.raw carry per-row accountIds.
    const row = await getClientRow(h.id);
    const effective = new Set(row ? effectiveAccountIds(row) : []);
    const bn = bnorm(h.brand);
    const pages = (row?.raw as { title?: string; accountIds?: string[] }[] | null) ?? [];
    const brandAccountIds = [
      ...new Set(
        pages
          .filter((p) => typeof p.title === "string" && bnorm(p.title) === bn)
          .flatMap((p) => p.accountIds ?? [])
          .filter((a) => effective.has(a)),
      ),
    ];
    return {
      id: h.id,
      name: h.name,
      matchedBrand: h.brand,
      siblingBrands: h.brands.filter((b) => b !== h.brand),
      ...(brandAccountIds.length ? { brandAccountIds } : {}),
    };
  }
  if (brandHits.length > 1)
    return {
      error: `"${query}" matches brands under multiple clients. Ask the user which client.`,
      candidates: brandHits.map((h) => `${h.brand} → ${h.name}`).slice(0, 10),
    };
  return {
    error: `No client matches "${query}".`,
    candidates: clients.map((c) => c.name).slice(0, 20),
  };
}

/** Resolve a subject string to a client (preferred) or single ad account. */
export type SubjectResolution = { name: string; accountIds: string[] } | ResolveError;

export async function resolveSubject(subject: string): Promise<SubjectResolution> {
  const s = subject.trim();
  if (!s) return { error: "Which client or ad account?" };
  const client = await resolveClient(s);
  if (!isResolveError(client)) {
    const row = await getClientRow(client.id);
    return { name: client.name, accountIds: row ? effectiveAccountIds(row) : [] };
  }
  const ents = await searchEntities(s);
  if (ents.accounts.length === 1)
    return { name: ents.accounts[0].name, accountIds: [ents.accounts[0].id] };
  if (ents.accounts.length > 1)
    return {
      error: `Multiple accounts match "${s}". Ask the user which one.`,
      candidates: ents.accounts.map((a) => a.name).slice(0, 10),
    };
  return client; // client-resolution error + candidates
}

/** Resolve an ad-set/ad subject to a scope: a client's accounts, or one campaign/account. */
export async function resolveAdScope(
  subject: string,
): Promise<{ scope: AdScope; label: string } | ResolveError> {
  const s = subject.trim();
  if (!s) return { error: "Which client, campaign, or ad account?" };
  const client = await resolveClient(s);
  if (!isResolveError(client)) {
    // A brand match scopes to that row's own accounts (when it has any), not the whole client.
    if (client.brandAccountIds?.length)
      return {
        scope: { accountIds: client.brandAccountIds },
        label: `${client.matchedBrand} (its own accounts, under client ${client.name})`,
      };
    const row = await getClientRow(client.id);
    const accountIds = row ? effectiveAccountIds(row) : [];
    // Exclude campaigns on shared accounts that belong to a different client.
    const owned = await ownedCampaignIds(client.id, accountIds);
    return {
      scope: { accountIds, ...(owned ? { campaignIds: owned } : {}) },
      label: client.matchedBrand
        ? `${client.matchedBrand} (under client ${client.name})`
        : `client ${client.name}`,
    };
  }
  const found = await resolveAdScopeSubject(s);
  if (found && "scope" in found) return found;
  if (found)
    return {
      error: `"${subject}" matches multiple campaigns/accounts. Ask the user which one.`,
      candidates: found.candidates,
    };
  return client; // client-resolution error + candidates
}

/** A client's effective ad accounts, for tools that need ids rather than a detail payload. */
export async function clientAccountIds(clientId: string): Promise<string[]> {
  const row = await getClientRow(clientId);
  return row ? effectiveAccountIds(row) : [];
}

export type { ClientDetail, DateWindow, AdScope };
