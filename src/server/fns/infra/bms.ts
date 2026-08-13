import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { usableBm, usableProfile } from "@/lib/infra-risk";
import {
  BM_STATUSES,
  BM_TYPES,
  isBmStatus,
  isBmType,
  parseProfileStatuses,
  type ProfileStatus,
} from "@/lib/infra-status";
import { audit, requireAdmin } from "../auth";
import { logInfraEvent } from "./events";

export interface BmView {
  id: string;
  bmId: string;
  name: string;
  status: string;
  type: string;
  verifiedAt: string | null;
  notes: string | null;
  profileIds: string[];
  adAccountIds: string[];
}

export async function fetchBms(): Promise<BmView[]> {
  await requireAdmin();
  const [rows, profileLinks, accountLinks] = await Promise.all([
    db.select().from(schema.infraBusinessManagers),
    db.select().from(schema.infraProfileBm),
    db.select().from(schema.infraBmAdAccount),
  ]);
  const profilesByBm = new Map<string, string[]>();
  for (const link of profileLinks) {
    const list = profilesByBm.get(link.bmId) ?? [];
    list.push(link.profileId);
    profilesByBm.set(link.bmId, list);
  }
  const accountsByBm = new Map<string, string[]>();
  for (const link of accountLinks) {
    const list = accountsByBm.get(link.bmId) ?? [];
    list.push(link.adAccountId);
    accountsByBm.set(link.bmId, list);
  }
  return rows
    .map((r) => ({
      id: r.id,
      bmId: r.bmId,
      name: r.name,
      status: r.status,
      type: r.type,
      verifiedAt: r.verifiedAt?.toISOString() ?? null,
      notes: r.notes,
      profileIds: profilesByBm.get(r.id) ?? [],
      adAccountIds: accountsByBm.get(r.id) ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface BmHistoryEntry {
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  actorEmail: string;
  at: string;
}

export interface BmDetail {
  bm: BmView;
  /** Profiles administering this BM, with usability already resolved for the access chain. */
  profiles: { id: string; name: string; statuses: ProfileStatus[]; usable: boolean }[];
  adAccounts: { id: string; label: string | null }[];
  history: BmHistoryEntry[];
}

export async function fetchBmDetail(id: string): Promise<BmDetail | null> {
  await requireAdmin();
  const [row] = await db
    .select()
    .from(schema.infraBusinessManagers)
    .where(eq(schema.infraBusinessManagers.id, id));
  if (!row) return null;

  const [profileRows, accountRows, historyRows] = await Promise.all([
    db
      .select({
        id: schema.infraProfiles.id,
        name: schema.infraProfiles.name,
        statuses: schema.infraProfiles.statuses,
      })
      .from(schema.infraProfileBm)
      .innerJoin(schema.infraProfiles, eq(schema.infraProfiles.id, schema.infraProfileBm.profileId))
      .where(eq(schema.infraProfileBm.bmId, id)),
    db
      .select({ id: schema.infraAdAccounts.id, label: schema.infraAdAccounts.label })
      .from(schema.infraBmAdAccount)
      .innerJoin(
        schema.infraAdAccounts,
        eq(schema.infraAdAccounts.id, schema.infraBmAdAccount.adAccountId),
      )
      .where(eq(schema.infraBmAdAccount.bmId, id)),
    db
      .select()
      .from(schema.infraStatusEvents)
      .where(
        and(eq(schema.infraStatusEvents.kind, "bm"), eq(schema.infraStatusEvents.entityId, id)),
      )
      .orderBy(desc(schema.infraStatusEvents.at))
      .limit(100),
  ]);

  return {
    bm: {
      id: row.id,
      bmId: row.bmId,
      name: row.name,
      status: row.status,
      type: row.type,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      notes: row.notes,
      profileIds: profileRows.map((p) => p.id),
      adAccountIds: accountRows.map((a) => a.id),
    },
    profiles: profileRows.map((p) => {
      const statuses = parseProfileStatuses(p.statuses);
      return { id: p.id, name: p.name, statuses, usable: usableProfile(statuses) };
    }),
    adAccounts: accountRows,
    history: historyRows.map((h) => ({
      event: h.event,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      reason: h.reason,
      actorEmail: h.actorEmail,
      at: h.at.toISOString(),
    })),
  };
}

export async function saveBm(input: {
  id?: string | null;
  bmId: string;
  name: string;
  status: string;
  type: string;
  notes?: string | null;
}): Promise<{ ok: boolean; error?: string; id?: string }> {
  const user = await requireAdmin();
  const name = input.name.trim();
  const bmId = input.bmId.trim();
  if (!name) return { ok: false, error: "Name is required" };
  if (!bmId) return { ok: false, error: "BM ID is required" };
  if (!isBmStatus(input.status)) {
    return { ok: false, error: `Status must be one of: ${BM_STATUSES.join(", ")}` };
  }
  if (!isBmType(input.type)) {
    return { ok: false, error: `Type must be one of: ${BM_TYPES.join(", ")}` };
  }

  // Checked explicitly so the operator gets a sentence rather than a unique-violation stack trace.
  const [clash] = await db
    .select({ id: schema.infraBusinessManagers.id, name: schema.infraBusinessManagers.name })
    .from(schema.infraBusinessManagers)
    .where(eq(schema.infraBusinessManagers.bmId, bmId));
  if (clash && clash.id !== input.id) {
    return { ok: false, error: `BM ID ${bmId} is already registered as "${clash.name}"` };
  }

  const fields = {
    bmId,
    name,
    type: input.type,
    notes: input.notes?.trim() || null,
    updatedAt: new Date(),
  };

  if (input.id) {
    const [existing] = await db
      .select()
      .from(schema.infraBusinessManagers)
      .where(eq(schema.infraBusinessManagers.id, input.id));
    if (!existing) return { ok: false, error: "Business Manager not found" };

    const statusChanged = existing.status !== input.status;
    await db
      .update(schema.infraBusinessManagers)
      .set({
        ...fields,
        status: input.status,
        ...(statusChanged ? { statusChangedAt: new Date() } : {}),
      })
      .where(eq(schema.infraBusinessManagers.id, input.id));

    if (statusChanged) {
      await logInfraEvent({
        kind: "bm",
        entityId: input.id,
        event: "status_change",
        fromStatus: existing.status,
        toStatus: input.status,
        actorEmail: user.email,
      });
    }
    await audit("infra.bm.update", `${name} (${bmId})`);
    return { ok: true, id: input.id };
  }

  const id = randomUUID();
  await db
    .insert(schema.infraBusinessManagers)
    .values({ ...fields, id, status: input.status, verifiedAt: new Date() });
  await audit("infra.bm.create", `${name} (${bmId})`);
  return { ok: true, id };
}

export interface BmBanImpact {
  accountsLosingAPath: number;
  accountsLeftWithNone: number;
  profiles: number;
}

/**
 * Impact preview for banning a BM.
 *
 * Reports paths LOST, which is the only true statement under a flat access list: there is no primary
 * BM to re-point, so claiming that accounts "need reassignment" would be false. The reference
 * implementation says exactly that, and it became a lie the moment the primary-BM concept was dropped.
 */
export async function previewBmBan(input: { id: string }): Promise<BmBanImpact> {
  await requireAdmin();
  const [ownLinks, allLinks, bms, profileLinks] = await Promise.all([
    db.select().from(schema.infraBmAdAccount).where(eq(schema.infraBmAdAccount.bmId, input.id)),
    db.select().from(schema.infraBmAdAccount),
    db.select().from(schema.infraBusinessManagers),
    db.select().from(schema.infraProfileBm).where(eq(schema.infraProfileBm.bmId, input.id)),
  ]);

  const statusById = new Map(bms.map((b) => [b.id, b.status]));
  const affected = new Set(ownLinks.map((l) => l.adAccountId));
  let leftWithNone = 0;
  for (const accountId of affected) {
    const survivingPaths = allLinks.filter((l) => {
      if (l.adAccountId !== accountId || l.bmId === input.id) return false;
      const status = statusById.get(l.bmId);
      return isBmStatus(status) && usableBm(status);
    });
    if (survivingPaths.length === 0) leftWithNone++;
  }

  return {
    accountsLosingAPath: affected.size,
    accountsLeftWithNone: leftWithNone,
    profiles: profileLinks.length,
  };
}

export async function setBmStatus(input: {
  id: string;
  status: string;
  reason?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  if (!isBmStatus(input.status)) {
    return { ok: false, error: `Status must be one of: ${BM_STATUSES.join(", ")}` };
  }
  const [existing] = await db
    .select()
    .from(schema.infraBusinessManagers)
    .where(eq(schema.infraBusinessManagers.id, input.id));
  if (!existing) return { ok: false, error: "Business Manager not found" };
  if (existing.status === input.status) return { ok: true };

  await db
    .update(schema.infraBusinessManagers)
    .set({ status: input.status, statusChangedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.infraBusinessManagers.id, input.id));
  await logInfraEvent({
    kind: "bm",
    entityId: input.id,
    event: "status_change",
    fromStatus: existing.status,
    toStatus: input.status,
    reason: input.reason?.trim() || null,
    actorEmail: user.email,
  });
  await audit("infra.bm.status", `${existing.name}: ${existing.status} → ${input.status}`);
  return { ok: true };
}

/**
 * Human attestation: records that someone confirmed this BM still looks right.
 *
 * Written as history rather than only overwriting `verifiedAt`, so "when was this last checked, and by
 * whom, and how often" is answerable. No API can attest this — it is why the button exists.
 */
export async function verifyBm(input: { id: string }): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  const [existing] = await db
    .select()
    .from(schema.infraBusinessManagers)
    .where(eq(schema.infraBusinessManagers.id, input.id));
  if (!existing) return { ok: false, error: "Business Manager not found" };

  await db
    .update(schema.infraBusinessManagers)
    .set({ verifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.infraBusinessManagers.id, input.id));
  await logInfraEvent({ kind: "bm", entityId: input.id, event: "verify", actorEmail: user.email });
  await audit("infra.bm.verify", `${existing.name} (${existing.bmId})`);
  return { ok: true };
}

export async function deleteBm(input: { id: string }): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const rooted = await db
    .select({ name: schema.infraPixels.name })
    .from(schema.infraPixels)
    .where(eq(schema.infraPixels.rootBmId, input.id));
  if (rooted.length > 0) {
    return {
      ok: false,
      error: `Roots ${rooted.length} pixel(s): ${rooted.map((p) => p.name).join(", ")}. Re-root them first.`,
    };
  }
  await db
    .delete(schema.infraBusinessManagers)
    .where(eq(schema.infraBusinessManagers.id, input.id));
  await audit("infra.bm.delete", input.id);
  return { ok: true };
}

export async function linkBmAdAccount(input: {
  bmId: string;
  adAccountId: string;
  action: "add" | "remove";
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  if (input.action === "add") {
    await db
      .insert(schema.infraBmAdAccount)
      .values({ bmId: input.bmId, adAccountId: input.adAccountId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(schema.infraBmAdAccount)
      .where(
        and(
          eq(schema.infraBmAdAccount.bmId, input.bmId),
          eq(schema.infraBmAdAccount.adAccountId, input.adAccountId),
        ),
      );
  }
  await audit("infra.bm.account_link", `${input.action} ${input.bmId} ↔ ${input.adAccountId}`);
  return { ok: true };
}
