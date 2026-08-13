import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { AD_ACCOUNT_USAGE, isAdAccountUsage } from "@/lib/infra-status";
import { audit, requireAdmin } from "../auth";

/** `act_` followed by digits. The join key across every system, per the CLAUDE.md invariant. */
const AD_ACCOUNT_ID = /^act_\d+$/;

export interface AdAccountView {
  id: string;
  label: string | null;
  usageState: string;
  notes: string | null;
  bmIds: string[];
  /** Null when the account is not (yet) in the synced book — rendered as a "not in sync" badge. */
  synced: {
    name: string;
    status: string | null;
    disableReason: number | null;
    spendCap: number | null;
    balance: number | null;
    currency: string;
  } | null;
}

export async function fetchAdAccounts(): Promise<AdAccountView[]> {
  await requireAdmin();
  const [rows, links] = await Promise.all([
    db
      .select({
        id: schema.infraAdAccounts.id,
        label: schema.infraAdAccounts.label,
        usageState: schema.infraAdAccounts.usageState,
        notes: schema.infraAdAccounts.notes,
        syncedName: schema.accounts.name,
        syncedStatus: schema.accounts.status,
        disableReason: schema.accounts.disableReason,
        spendCap: schema.accounts.spendCap,
        balance: schema.accounts.balance,
        currency: schema.accounts.currency,
      })
      .from(schema.infraAdAccounts)
      .leftJoin(schema.accounts, eq(schema.accounts.id, schema.infraAdAccounts.id)),
    db.select().from(schema.infraBmAdAccount),
  ]);
  const bmsByAccount = new Map<string, string[]>();
  for (const l of links) {
    const list = bmsByAccount.get(l.adAccountId) ?? [];
    list.push(l.bmId);
    bmsByAccount.set(l.adAccountId, list);
  }
  return rows
    .map((r) => ({
      id: r.id,
      label: r.label,
      usageState: r.usageState,
      notes: r.notes,
      bmIds: bmsByAccount.get(r.id) ?? [],
      synced: r.syncedName
        ? {
            name: r.syncedName,
            status: r.syncedStatus,
            disableReason: r.disableReason,
            spendCap: r.spendCap,
            balance: r.balance,
            currency: r.currency ?? "USD",
          }
        : null,
    }))
    .sort((a, b) => (a.label ?? a.id).localeCompare(b.label ?? b.id));
}

/** Accounts in the synced book that are not yet registered — the pick list for "add". */
export async function fetchUnregisteredAccounts(): Promise<{ id: string; name: string }[]> {
  await requireAdmin();
  const [synced, registered] = await Promise.all([
    db.select({ id: schema.accounts.id, name: schema.accounts.name }).from(schema.accounts),
    db.select({ id: schema.infraAdAccounts.id }).from(schema.infraAdAccounts),
  ]);
  const have = new Set(registered.map((r) => r.id));
  return synced.filter((a) => !have.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveAdAccount(input: {
  id: string;
  label?: string | null;
  usageState: string;
  notes?: string | null;
  isNew?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const id = input.id.trim();
  if (!AD_ACCOUNT_ID.test(id)) {
    return { ok: false, error: "Ad account id must look like act_1234567890" };
  }
  if (!isAdAccountUsage(input.usageState)) {
    return { ok: false, error: `Usage must be one of: ${AD_ACCOUNT_USAGE.join(", ")}` };
  }
  const fields = {
    label: input.label?.trim() || null,
    usageState: input.usageState,
    notes: input.notes?.trim() || null,
    updatedAt: new Date(),
  };
  await db
    .insert(schema.infraAdAccounts)
    .values({ id, ...fields })
    .onConflictDoUpdate({ target: schema.infraAdAccounts.id, set: fields });
  await audit("infra.account.save", `${id} (${input.usageState})`);
  return { ok: true };
}

export async function deleteAdAccount(input: {
  id: string;
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  // BM memberships cascade; nothing else depends on an account row.
  await db.delete(schema.infraAdAccounts).where(eq(schema.infraAdAccounts.id, input.id));
  await audit("infra.account.delete", input.id);
  return { ok: true };
}

export async function linkAdAccountBm(input: {
  adAccountId: string;
  bmId: string;
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
  await audit("infra.account.link", `${input.action} ${input.adAccountId} ↔ ${input.bmId}`);
  return { ok: true };
}
