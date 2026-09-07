import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { parseProfileStatuses, type ProfileStatus } from "@/lib/infra-status";
import { audit, requireAdmin } from "../auth";
import { logInfraEvent } from "./events";

export interface ProfileView {
  id: string;
  /** A set, not one value — see PROFILE_STATUSES. Always ordered and non-empty. */
  statuses: ProfileStatus[];
  name: string;
  geo: string | null;
  browser: string | null;
  notes: string | null;
  bmIds: string[];
  /** Operator priority marker. Display only — see infra_profiles.is_main. */
  isMain: boolean;
  statusChangedAt: string;
}

/** History stores a set as one readable string, so `from -> to` still reads as a sentence. */
const joinStatuses = (statuses: readonly string[]) => statuses.join(", ");

/** Set comparison independent of tick order; both sides are vocabulary-ordered by the parser. */
const sameStatuses = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

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
      statuses: parseProfileStatuses(r.statuses),
      geo: r.geo,
      browser: r.browser,
      notes: r.notes,
      bmIds: bmsByProfile.get(r.id) ?? [],
      isMain: r.isMain,
      statusChangedAt: r.statusChangedAt.toISOString(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Marks a profile as one of the ones that matter, or unmarks it.
 *
 * Its own action, not a field on `saveProfile`, for the same reason as `setBmMain`: a priority marker
 * must not be flipped as a side effect of an unrelated edit. `audit()` only — the per-asset event
 * trail is for status, and this changes nothing about what the profile can do.
 */
export async function setProfileMain(input: {
  id: string;
  main: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const [existing] = await db
    .select()
    .from(schema.infraProfiles)
    .where(eq(schema.infraProfiles.id, input.id));
  if (!existing) return { ok: false, error: "Profile not found" };
  if (existing.isMain === input.main) return { ok: true };

  await db
    .update(schema.infraProfiles)
    .set({ isMain: input.main, updatedAt: new Date() })
    .where(eq(schema.infraProfiles.id, input.id));
  await audit(input.main ? "infra.profile.main.set" : "infra.profile.main.clear", existing.name);
  return { ok: true };
}

export interface SaveProfileInput {
  id?: string | null;
  name: string;
  statuses: string[];
  geo?: string | null;
  browser?: string | null;
  notes?: string | null;
}

export async function saveProfile(
  input: SaveProfileInput,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const user = await requireAdmin();
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Name is required" };
  // At least one real status: an empty set would parse to `suspended` and silently mislabel the row.
  if (!Array.isArray(input.statuses) || input.statuses.length === 0) {
    return { ok: false, error: "Pick at least one status" };
  }
  const statuses = parseProfileStatuses(input.statuses);

  const fields = {
    name,
    geo: input.geo?.trim() || null,
    browser: input.browser?.trim() || null,
    notes: input.notes?.trim() || null,
    updatedAt: new Date(),
  };

  if (input.id) {
    const [existing] = await db
      .select()
      .from(schema.infraProfiles)
      .where(eq(schema.infraProfiles.id, input.id));
    if (!existing) return { ok: false, error: "Profile not found" };

    const before = parseProfileStatuses(existing.statuses);
    const changed = !sameStatuses(before, statuses);
    await db
      .update(schema.infraProfiles)
      .set({ ...fields, statuses, ...(changed ? { statusChangedAt: new Date() } : {}) })
      .where(eq(schema.infraProfiles.id, input.id));

    if (changed) {
      await logInfraEvent({
        kind: "profile",
        entityId: input.id,
        event: "status_change",
        fromStatus: joinStatuses(before),
        toStatus: joinStatuses(statuses),
        actorEmail: user.email,
      });
    }
    await audit("infra.profile.update", `${name} (${input.id})`);
    return { ok: true, id: input.id };
  }

  const id = randomUUID();
  await db.insert(schema.infraProfiles).values({ ...fields, id, statuses });
  await audit("infra.profile.create", `${name} (${id})`);
  return { ok: true, id };
}

/**
 * Replace the status set, with an optional reason.
 *
 * Separate from `saveProfile` because a status change is the event worth recording precisely, and the
 * list screen edits the set without opening the form.
 */
export async function setProfileStatuses(input: {
  id: string;
  statuses: string[];
  reason?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  if (!Array.isArray(input.statuses) || input.statuses.length === 0) {
    return { ok: false, error: "Pick at least one status" };
  }
  const statuses = parseProfileStatuses(input.statuses);
  const [existing] = await db
    .select()
    .from(schema.infraProfiles)
    .where(eq(schema.infraProfiles.id, input.id));
  if (!existing) return { ok: false, error: "Profile not found" };

  const before = parseProfileStatuses(existing.statuses);
  if (sameStatuses(before, statuses)) return { ok: true };

  await db
    .update(schema.infraProfiles)
    .set({ statuses, statusChangedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.infraProfiles.id, input.id));
  await logInfraEvent({
    kind: "profile",
    entityId: input.id,
    event: "status_change",
    fromStatus: joinStatuses(before),
    toStatus: joinStatuses(statuses),
    reason: input.reason?.trim() || null,
    actorEmail: user.email,
  });
  await audit(
    "infra.profile.status",
    `${existing.name}: ${joinStatuses(before)} → ${joinStatuses(statuses)}`,
  );
  return { ok: true };
}

/**
 * Delete a profile.
 *
 * Postgres refuses this when the profile owns a page (`ON DELETE RESTRICT`). The dependency is checked
 * first so the operator gets a sentence naming the blocking pages instead of a constraint violation.
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
