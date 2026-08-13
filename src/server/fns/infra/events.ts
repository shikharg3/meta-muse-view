import { randomUUID } from "node:crypto";
import { db, schema } from "@/db/client";
import type { InfraKind } from "@/lib/infra-status";

export interface InfraEventInput {
  kind: InfraKind;
  entityId: string;
  event: "status_change" | "verify";
  fromStatus?: string | null;
  toStatus?: string | null;
  reason?: string | null;
  actorEmail: string;
}

/**
 * Append one history row.
 *
 * Records old -> new and the real acting user. The reference implementation logs changed field NAMES
 * with no values and hardcodes every actor as "Admin" — which is the exact spreadsheet failure it was
 * built to replace — so this is the one piece of bookkeeping worth being strict about.
 *
 * Called by every mutation that changes a status or records an attestation. Deliberately separate
 * from `audit()`: that is the cross-app admin trail keyed by actor, this is the per-asset history
 * keyed by entity, and the two are read for different questions.
 */
export async function logInfraEvent(input: InfraEventInput): Promise<void> {
  await db.insert(schema.infraStatusEvents).values({
    id: randomUUID(),
    kind: input.kind,
    entityId: input.entityId,
    event: input.event,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    reason: input.reason ?? null,
    actorEmail: input.actorEmail,
  });
}
