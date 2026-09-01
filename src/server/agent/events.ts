/**
 * The wire contract between the agent loop and the Ask UI.
 *
 * A turn used to be one request/response: the browser posted a question and waited on a spinner while
 * up to five model round-trips ran server-side, with no way to see progress or stop. These events are
 * what the loop emits as it goes; the server fn forwards them as newline-delimited JSON and the UI
 * renders them live.
 *
 * Shared by both sides on purpose — the previous design had the UI keep its own table of tool names,
 * which had already fallen out of date. Labels now travel with the event.
 */
import type { Kpis } from "@/lib/types";
import type { ReportPayload } from "./report";

export interface ToolTrace {
  name: string;
  label: string;
  ok: boolean;
  /** Milliseconds the tool itself took — the honest answer to "why is this slow". */
  ms: number;
  /** One-line description of what was asked for, e.g. `client: Wild · last_7d`. */
  detail?: string;
}

export type ChatEvent =
  /** Always first. Carries the id so a brand-new thread can be selected before the answer lands. */
  | { type: "start"; conversationId: string }
  /** The model is thinking (no token text — thinking blocks are not shown verbatim). */
  | { type: "status"; text: string }
  | { type: "tool_start"; name: string; label: string; detail?: string }
  | { type: "tool_end"; name: string; label: string; ok: boolean; ms: number; detail?: string }
  /** Incremental answer text. */
  | { type: "delta"; text: string }
  | { type: "cards"; title: string; kpis: Kpis }
  | { type: "series"; title: string; unit: string; points: SeriesPoint[] }
  | { type: "report"; report: ReportPayload }
  | { type: "done"; costUsd: number; toolCalls: ToolTrace[] }
  | { type: "error"; message: string };

/** A dated value for an in-chat chart. */
export interface SeriesPoint {
  date: string;
  value: number;
}

/** What the UI keeps per assistant message; also the shape persisted to `chat_messages.payload`. */
export interface MessageExtras {
  cards: { title: string; kpis: Kpis } | null;
  series: { title: string; unit: string; points: SeriesPoint[] } | null;
  report: ReportPayload | null;
  toolCalls: ToolTrace[];
  error?: string;
}

export const emptyExtras = (): MessageExtras => ({
  cards: null,
  series: null,
  report: null,
  toolCalls: [],
});
