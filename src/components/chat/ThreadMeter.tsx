import { MessageSquarePlus, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { HIGH_COST, WARN_COST, fmtCost } from "./thread-cost";

/**
 * Cost feedback for a conversation.
 *
 * Built from a real incident: one thread reached 212 questions and $59.16 — 74% of everything the
 * assistant had ever cost — because nothing in the UI said a thread was getting expensive, or why.
 * Measured on that data, a question at depth 21+ costs 2.6x one at depth 1-2 ($0.289 vs $0.109),
 * because every question re-sends the thread it lives in.
 *
 * So the fix is not a bigger "New chat" button. It is telling people the number while it is still
 * small, and explaining the mechanism at the moment it starts to matter.
 */

const tone = (usd: number): string =>
  usd >= HIGH_COST
    ? "text-destructive"
    : usd >= WARN_COST
      ? "text-warning"
      : "text-muted-foreground";

/** Always-visible running total for the open thread. */
export function ThreadMeter({ turns, costUsd }: { turns: number; costUsd: number }) {
  if (turns === 0) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px]"
      title={
        "What this conversation has cost so far.\n" +
        "Every question re-sends the whole thread, so a long thread costs more per question than a short one."
      }
    >
      <span className="text-muted-foreground">
        {turns} Q{turns === 1 ? "" : "s"}
      </span>
      <span className="text-border">·</span>
      <span className={cn("font-semibold tabular-nums", tone(costUsd))}>{fmtCost(costUsd)}</span>
    </span>
  );
}

/**
 * The intervention. Appears once a thread crosses a threshold and explains the mechanism, because
 * the person who ran up $59 did not know that asking in the same thread was what made it expensive.
 */
export function ThreadNudge({
  turns,
  costUsd,
  onNewChat,
  onDismiss,
}: {
  turns: number;
  costUsd: number;
  onNewChat: () => void;
  onDismiss: () => void;
}) {
  const severe = costUsd >= HIGH_COST;
  return (
    <div
      className={cn(
        "mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3.5 py-2.5",
        severe
          ? "border-destructive/50 bg-destructive/[0.07]"
          : "border-warning/50 bg-warning/[0.06]",
      )}
    >
      <TriangleAlert
        className={cn("size-4 shrink-0", severe ? "text-destructive" : "text-warning")}
      />
      <div className="min-w-0 flex-1 text-xs">
        <span className="font-medium">
          {turns} questions in this chat · {fmtCost(costUsd)} so far
        </span>
        <span className="text-muted-foreground">
          {" "}
          — each new question re-sends the whole conversation, so this one is getting expensive.
          Start a fresh chat for a new topic.
        </span>
      </div>
      <button
        type="button"
        onClick={onNewChat}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground"
      >
        <MessageSquarePlus className="size-3.5" /> Start fresh chat
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        Not now
      </button>
    </div>
  );
}
