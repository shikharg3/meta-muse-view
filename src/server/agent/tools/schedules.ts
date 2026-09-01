import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { AgentTool } from "./kit";

const CADENCES = ["daily", "weekdays", "weekly"] as const;
type Cadence = (typeof CADENCES)[number];
const isCadence = (v: unknown): v is Cadence => CADENCES.includes(v as Cadence);

const WEEKDAY_NAME: Record<number, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};

const clockOf = (h: number, m: number) =>
  `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

const describe = (r: {
  cadence: string;
  weekday: number | null;
  hour: number;
  minute: number;
}): string => {
  const at = `${clockOf(r.hour, r.minute)} Berlin`;
  if (r.cadence === "weekdays") return `every weekday at ${at}`;
  if (r.cadence === "weekly") return `every ${WEEKDAY_NAME[r.weekday ?? 1]} at ${at}`;
  return `every day at ${at}`;
};

const listSchedules: AgentTool = {
  label: "schedules",
  definition: {
    name: "list_scheduled_questions",
    description:
      "List the questions this user has scheduled to be re-answered automatically and posted to the Telegram report channel. Each row carries the question, when it runs (cadence + Berlin time), whether it is active, when it last ran, and the last error if one occurred. Use before creating a schedule so you do not duplicate one that already exists.",
    input_schema: { type: "object", properties: {} },
  },
  async run(_input, ctx) {
    if (!ctx.userId) return { error: "No signed-in user, so there are no schedules to list." };
    const rows = await db
      .select()
      .from(schema.askSchedules)
      .where(eq(schema.askSchedules.userId, ctx.userId));
    if (rows.length === 0)
      return { schedules: [], note: "Nothing scheduled yet. schedule_question creates one." };
    return {
      schedules: rows.map((r) => ({
        id: r.id,
        question: r.question,
        runs: describe(r),
        active: r.active,
        lastRunDate: r.lastRunDate,
        lastError: r.lastError,
      })),
    };
  },
};

const scheduleQuestion: AgentTool = {
  label: "schedule",
  definition: {
    name: "schedule_question",
    description:
      "Save a question to be re-answered automatically and posted to the Telegram report channel. The answer is produced by a fresh assistant turn at run time, so write the question so it stands alone WITHOUT the current conversation for context — e.g. 'Which clients spent the most in the last 7 days?' rather than 'do that again for last week'. Times are on the Berlin clock, matching every other scheduled job. PREVIEW-BY-DEFAULT: called without confirm=true it returns what WOULD be created and sets confirmationRequired — show the user the exact question, cadence and time, and only call again with confirm=true after they agree. Never pass confirm=true on the user's behalf.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The standalone question to re-ask. Must make sense with no prior context.",
        },
        cadence: {
          type: "string",
          enum: [...CADENCES],
          description: "daily (default), weekdays (Mon-Fri), or weekly (needs `weekday`).",
        },
        weekday: {
          type: "integer",
          description: "1=Monday … 7=Sunday. Required when cadence is 'weekly'.",
        },
        hour: { type: "integer", description: "Berlin hour, 0-23. Default 9." },
        minute: { type: "integer", description: "Berlin minute, 0-59. Default 0." },
        confirm: {
          type: "boolean",
          description: "Only true after the user has explicitly agreed to the previewed schedule.",
        },
      },
      required: ["question"],
    },
  },
  async run(input, ctx) {
    if (!ctx.userId) return { error: "You must be signed in to schedule a question." };
    const question = String(input.question ?? "").trim();
    if (!question) return { error: "What question should be scheduled?" };

    const cadence: Cadence = isCadence(input.cadence) ? input.cadence : "daily";
    const weekday = Number.isFinite(Number(input.weekday)) ? Number(input.weekday) : null;
    if (cadence === "weekly" && (weekday === null || weekday < 1 || weekday > 7))
      return { error: "A weekly schedule needs `weekday` (1=Monday … 7=Sunday)." };
    const hour = clamp(input.hour, 0, 23, 9);
    const minute = clamp(input.minute, 0, 59, 0);
    const runs = describe({ cadence, weekday, hour, minute });

    if (input.confirm !== true) {
      return {
        confirmationRequired: true,
        wouldCreate: { question, runs, destination: "Telegram report channel" },
        message: `Show the user this exactly and ask them to confirm: "${question}" would be answered ${runs} and posted to the Telegram report channel. Call again with confirm=true only if they agree.`,
      };
    }

    const id = crypto.randomUUID();
    await db.insert(schema.askSchedules).values({
      id,
      userId: ctx.userId,
      question,
      cadence,
      weekday,
      hour,
      minute,
    });
    return { created: { id, question, runs, destination: "Telegram report channel" } };
  },
};

const cancelSchedule: AgentTool = {
  label: "unschedule",
  definition: {
    name: "cancel_scheduled_question",
    description:
      "Deactivate a scheduled question by its id (get ids from list_scheduled_questions). Deactivates rather than deletes, so the history of what was scheduled survives. Confirm with the user which one before calling if more than one could match.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Schedule id." } },
      required: ["id"],
    },
  },
  async run(input, ctx) {
    if (!ctx.userId) return { error: "You must be signed in to change schedules." };
    const id = String(input.id ?? "");
    const updated = await db
      .update(schema.askSchedules)
      .set({ active: false })
      .where(and(eq(schema.askSchedules.id, id), eq(schema.askSchedules.userId, ctx.userId)))
      .returning({ id: schema.askSchedules.id, question: schema.askSchedules.question });
    if (updated.length === 0)
      return {
        error: `No schedule ${id} belongs to you. Call list_scheduled_questions for the ids.`,
      };
    return { cancelled: updated[0] };
  },
};

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Recurring saved questions delivered to Telegram. */
export const scheduleTools: AgentTool[] = [listSchedules, scheduleQuestion, cancelSchedule];
