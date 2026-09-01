import type { ToolTrace } from "@/server/agent/events";

/**
 * A tool as the trace sees it. Wider than the wire {@link ToolTrace} in two ways, both about data
 * that legitimately lacks fields: `ok`/`ms` are absent while a call is still in flight (a
 * `tool_start` with no `tool_end` yet), and `label` is absent on messages persisted before labels
 * travelled with the event — those rows fall back to the raw tool name.
 */
export type TraceItem = Omit<ToolTrace, "label" | "ok" | "ms"> & {
  label?: string;
  ok?: boolean;
  ms?: number;
};

/**
 * Fold a `tool_end` into the running list: close out the matching in-flight row rather than
 * appending, so a tool that runs twice in a turn shows two rows and not four.
 */
export function closeTrace(items: TraceItem[], end: ToolTrace): TraceItem[] {
  const i = items.findIndex((t) => t.name === end.name && t.ok === undefined);
  const closed: TraceItem = {
    name: end.name,
    label: end.label,
    detail: end.detail ?? (i === -1 ? undefined : items[i].detail),
    ok: end.ok,
    ms: end.ms,
  };
  if (i === -1) return [...items, closed];
  const next = items.slice();
  next[i] = closed;
  return next;
}
