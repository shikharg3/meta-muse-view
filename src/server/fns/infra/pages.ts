import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { PAGE_STATUSES, isPageStatus } from "@/lib/infra-status";
import { audit, requireAdmin } from "../auth";
import { logInfraEvent } from "./events";

export interface PageView {
  id: string;
  pageId: string | null;
  pageUrl: string;
  name: string;
  ownerProfileId: string;
  status: string;
  verifiedAt: string | null;
  notes: string | null;
  bmIds: string[];
  profileIds: string[];
}

export async function fetchPages(): Promise<PageView[]> {
  await requireAdmin();
  const [rows, bmLinks, profileLinks] = await Promise.all([
    db.select().from(schema.infraPages),
    db.select().from(schema.infraPageBm),
    db.select().from(schema.infraPageProfile),
  ]);
  const bmsByPage = new Map<string, string[]>();
  for (const link of bmLinks) {
    const list = bmsByPage.get(link.pageId) ?? [];
    list.push(link.bmId);
    bmsByPage.set(link.pageId, list);
  }
  const profilesByPage = new Map<string, string[]>();
  for (const link of profileLinks) {
    const list = profilesByPage.get(link.pageId) ?? [];
    list.push(link.profileId);
    profilesByPage.set(link.pageId, list);
  }
  return rows
    .map((r) => ({
      id: r.id,
      pageId: r.pageId,
      pageUrl: r.pageUrl,
      name: r.name,
      ownerProfileId: r.ownerProfileId,
      status: r.status,
      verifiedAt: r.verifiedAt?.toISOString() ?? null,
      notes: r.notes,
      bmIds: bmsByPage.get(r.id) ?? [],
      profileIds: profilesByPage.get(r.id) ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Create or update a page.
 *
 * The row key is a `randomUUID()`, not the Meta page id: a page is often registered before anyone has
 * dug its numeric id out of Business Manager, so `page_id` is optional and cannot be the key.
 */
export async function savePage(input: {
  id?: string | null;
  pageId?: string | null;
  pageUrl: string;
  name: string;
  ownerProfileId: string;
  status: string;
  notes?: string | null;
}): Promise<{ ok: boolean; error?: string; id?: string }> {
  const user = await requireAdmin();
  const name = input.name.trim();
  const pageUrl = input.pageUrl.trim();
  if (!name) return { ok: false, error: "Name is required" };
  if (!pageUrl) return { ok: false, error: "Page URL is required" };
  if (!isPageStatus(input.status)) {
    return { ok: false, error: `Status must be one of: ${PAGE_STATUSES.join(", ")}` };
  }
  const [owner] = await db
    .select({ id: schema.infraProfiles.id })
    .from(schema.infraProfiles)
    .where(eq(schema.infraProfiles.id, input.ownerProfileId));
  if (!owner) return { ok: false, error: "Owner must be a registered profile" };

  const fields = {
    pageId: input.pageId?.trim() || null,
    pageUrl,
    name,
    ownerProfileId: input.ownerProfileId,
    notes: input.notes?.trim() || null,
    updatedAt: new Date(),
  };

  const created = !input.id;
  let id: string;
  if (input.id) {
    const [existing] = await db
      .select()
      .from(schema.infraPages)
      .where(eq(schema.infraPages.id, input.id));
    if (!existing) return { ok: false, error: "Page not found" };

    id = input.id;
    const statusChanged = existing.status !== input.status;
    await db
      .update(schema.infraPages)
      .set({
        ...fields,
        status: input.status,
        ...(statusChanged ? { statusChangedAt: new Date() } : {}),
      })
      .where(eq(schema.infraPages.id, id));

    if (statusChanged) {
      await logInfraEvent({
        kind: "page",
        entityId: id,
        event: "status_change",
        fromStatus: existing.status,
        toStatus: input.status,
        actorEmail: user.email,
      });
    }
  } else {
    id = randomUUID();
    await db
      .insert(schema.infraPages)
      .values({ ...fields, id, status: input.status, verifiedAt: new Date() });
  }

  // The invariant: the owner is never also an additional profile. Enforced once, here.
  await db
    .delete(schema.infraPageProfile)
    .where(
      and(
        eq(schema.infraPageProfile.pageId, id),
        eq(schema.infraPageProfile.profileId, input.ownerProfileId),
      ),
    );

  await audit(created ? "infra.page.create" : "infra.page.update", `${name} (${id})`);
  return { ok: true, id };
}

export async function setPageStatus(input: {
  id: string;
  status: string;
  reason?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  if (!isPageStatus(input.status)) {
    return { ok: false, error: `Status must be one of: ${PAGE_STATUSES.join(", ")}` };
  }
  const [existing] = await db
    .select()
    .from(schema.infraPages)
    .where(eq(schema.infraPages.id, input.id));
  if (!existing) return { ok: false, error: "Page not found" };
  if (existing.status === input.status) return { ok: true };

  await db
    .update(schema.infraPages)
    .set({ status: input.status, statusChangedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.infraPages.id, input.id));
  await logInfraEvent({
    kind: "page",
    entityId: input.id,
    event: "status_change",
    fromStatus: existing.status,
    toStatus: input.status,
    reason: input.reason?.trim() || null,
    actorEmail: user.email,
  });
  await audit("infra.page.status", `${existing.name}: ${existing.status} → ${input.status}`);
  return { ok: true };
}

export async function verifyPage(input: { id: string }): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  const [existing] = await db
    .select()
    .from(schema.infraPages)
    .where(eq(schema.infraPages.id, input.id));
  if (!existing) return { ok: false, error: "Page not found" };
  await db
    .update(schema.infraPages)
    .set({ verifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.infraPages.id, input.id));
  await logInfraEvent({
    kind: "page",
    entityId: input.id,
    event: "verify",
    actorEmail: user.email,
  });
  await audit("infra.page.verify", `${existing.name} (${input.id})`);
  return { ok: true };
}

/** No dependency check: both link tables cascade and nothing else references a page. */
export async function deletePage(input: { id: string }): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  await db.delete(schema.infraPages).where(eq(schema.infraPages.id, input.id));
  await audit("infra.page.delete", input.id);
  return { ok: true };
}

export async function linkPageBm(input: {
  pageId: string;
  bmId: string;
  action: "add" | "remove";
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  if (input.action === "add") {
    await db
      .insert(schema.infraPageBm)
      .values({ pageId: input.pageId, bmId: input.bmId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(schema.infraPageBm)
      .where(
        and(eq(schema.infraPageBm.pageId, input.pageId), eq(schema.infraPageBm.bmId, input.bmId)),
      );
  }
  await audit("infra.page.link", `${input.action} ${input.pageId} ↔ ${input.bmId}`);
  return { ok: true };
}

export async function linkPageProfile(input: {
  pageId: string;
  profileId: string;
  action: "add" | "remove";
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const [page] = await db
    .select({ ownerProfileId: schema.infraPages.ownerProfileId })
    .from(schema.infraPages)
    .where(eq(schema.infraPages.id, input.pageId));
  if (!page) return { ok: false, error: "Page not found" };
  if (input.action === "add") {
    if (page.ownerProfileId === input.profileId) {
      return {
        ok: false,
        error: "The owner already has access and cannot also be an additional profile",
      };
    }
    await db
      .insert(schema.infraPageProfile)
      .values({ pageId: input.pageId, profileId: input.profileId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(schema.infraPageProfile)
      .where(
        and(
          eq(schema.infraPageProfile.pageId, input.pageId),
          eq(schema.infraPageProfile.profileId, input.profileId),
        ),
      );
  }
  await audit("infra.page.link", `${input.action} ${input.pageId} ↔ ${input.profileId}`);
  return { ok: true };
}
