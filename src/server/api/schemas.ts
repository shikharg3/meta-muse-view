import { z } from "zod";
import { isYmd } from "@/lib/range";

/**
 * Input schemas shared by more than one op.
 *
 * These are the first real validation this surface has ever had: 99 of the 100 `createServerFn`
 * wrappers used an identity lambda (`(d: T) => d`) as their "validator", which type-checked the
 * in-repo caller and checked nothing at runtime. That was survivable while the only client was
 * bundled from the same tree; it is not once a request can arrive over HTTP.
 */

export const ymd = z.string().refine(isYmd, "Expected a YYYY-MM-DD date");

/** A trailing preset day-count, or an explicit custom from/to. Mirrors `lib/range.RangeSpec`. */
export const rangeSpec = z.object({
  days: z.number().int().positive().max(400),
  from: ymd.optional(),
  to: ymd.optional(),
});

export const idOnly = z.object({ id: z.string().min(1) });

/** `add` / `remove` link mutations, shared by every infra join table. */
export const linkAction = z.enum(["add", "remove"]);

/** Free-text notes columns: absent, explicitly cleared, or a value. */
export const nullableText = z.string().nullable().optional();

/**
 * Infra status strings are validated by the delegates against their own domain vocabularies
 * (`infra_status_events` records whatever they accept), so the schema only enforces shape.
 */
export const statusString = z.string().min(1).max(64);
