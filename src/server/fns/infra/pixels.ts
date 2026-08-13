import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { PIXEL_STATUSES, isPixelStatus } from "@/lib/infra-status";
import { audit, requireAdmin } from "../auth";
import { logInfraEvent } from "./events";

export interface PixelView {
  id: string;
  name: string;
  rootBmId: string;
  status: string;
  verifiedAt: string | null;
  notes: string | null;
  sharedBmIds: string[];
}

export async function fetchPixels(): Promise<PixelView[]> {
  await requireAdmin();
  const [rows, links] = await Promise.all([
    db.select().from(schema.infraPixels),
    db.select().from(schema.infraPixelBm),
  ]);
  const sharesByPixel = new Map<string, string[]>();
  for (const l of links) {
    const list = sharesByPixel.get(l.pixelId) ?? [];
    list.push(l.bmId);
    sharesByPixel.set(l.pixelId, list);
  }
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      rootBmId: r.rootBmId,
      status: r.status,
      verifiedAt: r.verifiedAt?.toISOString() ?? null,
      notes: r.notes,
      sharedBmIds: sharesByPixel.get(r.id) ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function savePixel(input: {
  id: string;
  name: string;
  rootBmId: string;
  status: string;
  notes?: string | null;
  isNew?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  const id = input.id.trim();
  const name = input.name.trim();
  if (!id) return { ok: false, error: "Pixel ID is required" };
  if (!name) return { ok: false, error: "Name is required" };
  if (!isPixelStatus(input.status)) {
    return { ok: false, error: `Status must be one of: ${PIXEL_STATUSES.join(", ")}` };
  }
  const [rootBm] = await db
    .select({ id: schema.infraBusinessManagers.id })
    .from(schema.infraBusinessManagers)
    .where(eq(schema.infraBusinessManagers.id, input.rootBmId));
  if (!rootBm) return { ok: false, error: "Root BM must be a registered Business Manager" };

  const [existing] = await db
    .select()
    .from(schema.infraPixels)
    .where(eq(schema.infraPixels.id, id));
  const fields = {
    name,
    rootBmId: input.rootBmId,
    notes: input.notes?.trim() || null,
    updatedAt: new Date(),
  };

  if (existing) {
    const statusChanged = existing.status !== input.status;
    await db
      .update(schema.infraPixels)
      .set({
        ...fields,
        status: input.status,
        ...(statusChanged ? { statusChangedAt: new Date() } : {}),
      })
      .where(eq(schema.infraPixels.id, id));
    if (statusChanged) {
      await logInfraEvent({
        kind: "pixel",
        entityId: id,
        event: "status_change",
        fromStatus: existing.status,
        toStatus: input.status,
        actorEmail: user.email,
      });
    }
  } else {
    await db
      .insert(schema.infraPixels)
      .values({ ...fields, id, status: input.status, verifiedAt: new Date() });
  }

  // The invariant: the root BM is never also a share. Enforced once, here.
  await db
    .delete(schema.infraPixelBm)
    .where(and(eq(schema.infraPixelBm.pixelId, id), eq(schema.infraPixelBm.bmId, input.rootBmId)));

  await audit(existing ? "infra.pixel.update" : "infra.pixel.create", `${name} (${id})`);
  return { ok: true };
}

export async function setPixelStatus(input: {
  id: string;
  status: string;
  reason?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  if (!isPixelStatus(input.status)) {
    return { ok: false, error: `Status must be one of: ${PIXEL_STATUSES.join(", ")}` };
  }
  const [existing] = await db
    .select()
    .from(schema.infraPixels)
    .where(eq(schema.infraPixels.id, input.id));
  if (!existing) return { ok: false, error: "Pixel not found" };
  if (existing.status === input.status) return { ok: true };
  await db
    .update(schema.infraPixels)
    .set({ status: input.status, statusChangedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.infraPixels.id, input.id));
  await logInfraEvent({
    kind: "pixel",
    entityId: input.id,
    event: "status_change",
    fromStatus: existing.status,
    toStatus: input.status,
    reason: input.reason?.trim() || null,
    actorEmail: user.email,
  });
  await audit("infra.pixel.status", `${existing.name}: ${existing.status} → ${input.status}`);
  return { ok: true };
}

export async function verifyPixel(input: { id: string }): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  const [existing] = await db
    .select()
    .from(schema.infraPixels)
    .where(eq(schema.infraPixels.id, input.id));
  if (!existing) return { ok: false, error: "Pixel not found" };
  await db
    .update(schema.infraPixels)
    .set({ verifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.infraPixels.id, input.id));
  await logInfraEvent({
    kind: "pixel",
    entityId: input.id,
    event: "verify",
    actorEmail: user.email,
  });
  await audit("infra.pixel.verify", `${existing.name} (${input.id})`);
  return { ok: true };
}

export async function deletePixel(input: { id: string }): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  await db.delete(schema.infraPixels).where(eq(schema.infraPixels.id, input.id));
  await audit("infra.pixel.delete", input.id);
  return { ok: true };
}

export async function linkPixelBm(input: {
  pixelId: string;
  bmId: string;
  action: "add" | "remove";
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const [pixel] = await db
    .select({ rootBmId: schema.infraPixels.rootBmId })
    .from(schema.infraPixels)
    .where(eq(schema.infraPixels.id, input.pixelId));
  if (!pixel) return { ok: false, error: "Pixel not found" };
  if (input.action === "add") {
    if (pixel.rootBmId === input.bmId) {
      return { ok: false, error: "The root BM is already the owner and cannot also be a share" };
    }
    await db
      .insert(schema.infraPixelBm)
      .values({ pixelId: input.pixelId, bmId: input.bmId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(schema.infraPixelBm)
      .where(
        and(
          eq(schema.infraPixelBm.pixelId, input.pixelId),
          eq(schema.infraPixelBm.bmId, input.bmId),
        ),
      );
  }
  await audit("infra.pixel.link", `${input.action} ${input.pixelId} ↔ ${input.bmId}`);
  return { ok: true };
}
