import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { PROFILE_STATUSES, isProfileStatus } from "@/lib/infra-status";
import { audit, requireAdmin } from "../auth";
import { logInfraEvent } from "./events";

export interface ProfileView {
  id: string;
  name: string;
  status: string;
  geo: string | null;
  browser: string | null;
  proxyProvider: string | null;
  notes: string | null;
  bmIds: string[];
  statusChangedAt: string;
}

export async function fetchProfiles(): Promise<ProfileView[]> {
  await requireAdmin();
  const [rows, links] = await Promise.all([
    db.select().from(schema.infraProfiles),
    db.select().from(schema.infraProfileBm),
  ]);
  const bmsByProfile = new Map<string, string[]>();
  for (const link of links) {
    const list = bmsByProfile.get(link.profileId) ?? [];
    list.push(link.bmId);
    bmsByProfile.set(link.profileId, list);
  }
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      geo: r.geo,
      browser: r.browser,
      proxyProvider: r.proxyProvider,
      notes: r.notes,
      bmIds: bmsByProfile.get(r.id) ?? [],
      statusChangedAt: r.statusChangedAt.toISOString(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface SaveProfileInput {
  id?: string | null;
  name: string;
  status: string;
  geo?: string | null;
  browser?: string | null;
  proxyProvider?: string | null;
  notes?: string | null;
}

export async function saveProfile(
  input: SaveProfileInput,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const user = await requireAdmin();
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Name is required" };
  if (!isProfileStatus(input.status)) {
    return { ok: false, error: `Status must be one of: ${PROFILE_STATUSES.join(", ")}` };
  }

  const fields = {
    name,
    geo: input.geo?.trim() || null,
    browser: input.browser?.trim() || null,
    proxyProvider: input.proxyProvider?.trim() || null,
    notes: input.notes?.trim() || null,
    updatedAt: new Date(),
  };

  if (input.id) {
    const [existing] = await db
      .select()
      .from(schema.infraProfiles)
      .where(eq(schema.infraProfiles.id, input.id));
    if (!existing) return { ok: false, error: "Profile not found" };

    const statusChanged = existing.status !== input.status;
    await db
      .update(schema.infraProfiles)
      .set({
        ...fields,
        status: input.status,
        ...(statusChanged ? { statusChangedAt: new Date() } : {}),
      })
      .where(eq(schema.infraProfiles.id, input.id));

    if (statusChanged) {
      await logInfraEvent({
        kind: "profile",
        entityId: input.id,
        event: "status_change",
        fromStatus: existing.status,
        toStatus: input.status,
        actorEmail: user.email,
      });
    }
    await audit("infra.profile.update", `${name} (${input.id})`);
    return { ok: true, id: input.id };
  }

  const id = randomUUID();
  await db.insert(schema.infraProfiles).values({ ...fields, id, status: input.status });
  await audit("infra.profile.create", `${name} (${id})`);
  return { ok: true, id };
}

/**
 * Change status on its own, with an optional reason.
 *
 * Separate from `saveProfile` because a status change is the event worth recording precisely, and the
 * list screen changes it inline without opening the form.
 */
export async function setProfileStatus(input: {
  id: string;
  status: string;
  reason?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  if (!isProfileStatus(input.status)) {
    return { ok: false, error: `Status must be one of: ${PROFILE_STATUSES.join(", ")}` };
  }
  const [existing] = await db
    .select()
    .from(schema.infraProfiles)
    .where(eq(schema.infraProfiles.id, input.id));
  if (!existing) return { ok: false, error: "Profile not found" };
  if (existing.status === input.status) return { ok: true };

  await db
    .update(schema.infraProfiles)
    .set({ status: input.status, statusChangedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.infraProfiles.id, input.id));
  await logInfraEvent({
    kind: "profile",
    entityId: input.id,
    event: "status_change",
    fromStatus: existing.status,
    toStatus: input.status,
    reason: input.reason?.trim() || null,
    actorEmail: user.email,
  });
  await audit("infra.profile.status", `${existing.name}: ${existing.status} → ${input.status}`);
  return { ok: true };
}

/**
 * Delete a profile.
 *
 * Postgres refuses this when the profile owns a page (`ON DELETE RESTRICT`). The dependency is checked
 * first so the operator gets a sentence naming the blocking pages instead of a constraint-violation
 * stack trace.
 */
export async function deleteProfile(input: {
  id: string;
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const owned = await db
    .select({ name: schema.infraPages.name })
    .from(schema.infraPages)
    .where(eq(schema.infraPages.ownerProfileId, input.id));
  if (owned.length > 0) {
    return {
      ok: false,
      error: `Owns ${owned.length} page(s): ${owned.map((p) => p.name).join(", ")}. Reassign them first.`,
    };
  }
  await db.delete(schema.infraProfiles).where(eq(schema.infraProfiles.id, input.id));
  await audit("infra.profile.delete", input.id);
  return { ok: true };
}

export async function linkProfileBm(input: {
  profileId: string;
  bmId: string;
  action: "add" | "remove";
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  if (input.action === "add") {
    await db
      .insert(schema.infraProfileBm)
      .values({ profileId: input.profileId, bmId: input.bmId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(schema.infraProfileBm)
      .where(
        and(
          eq(schema.infraProfileBm.profileId, input.profileId),
          eq(schema.infraProfileBm.bmId, input.bmId),
        ),
      );
  }
  await audit("infra.profile.link", `${input.action} ${input.profileId} ↔ ${input.bmId}`);
  return { ok: true };
}
