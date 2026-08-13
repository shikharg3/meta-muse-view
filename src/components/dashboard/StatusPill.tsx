import { cn } from "@/lib/utils";

const styles: Record<string, string> = {
  ACTIVE: "bg-success/10 text-success ring-success/20",
  LEARNING: "bg-warning/10 text-warning ring-warning/20",
  PAUSED: "bg-muted text-muted-foreground ring-border",
  COMPLETED: "bg-primary/10 text-primary ring-primary/20",
  DISABLED: "bg-destructive/10 text-destructive ring-destructive/20",
  PENDING: "bg-warning/10 text-warning ring-warning/20",
  // Infrastructure registry statuses.
  NEW: "bg-primary/10 text-primary ring-primary/20",
  IN_REVIEW: "bg-warning/10 text-warning ring-warning/20",
  PENDING_VERIFICATION: "bg-warning/10 text-warning ring-warning/20",
  SUSPENDED: "bg-destructive/10 text-destructive ring-destructive/20",
  RESTRICTED: "bg-destructive/10 text-destructive ring-destructive/20",
  BANNED: "bg-destructive/20 text-destructive ring-destructive/30",
  RETIRED: "bg-muted text-muted-foreground ring-border",
  INACTIVE: "bg-muted text-muted-foreground ring-border",
  UNPUBLISHED: "bg-warning/10 text-warning ring-warning/20",
  IN_USE: "bg-success/10 text-success ring-success/20",
  SPARE: "bg-primary/10 text-primary ring-primary/20",
};
const dots: Record<string, string> = {
  ACTIVE: "bg-success",
  LEARNING: "bg-warning",
  PAUSED: "bg-muted-foreground",
  COMPLETED: "bg-primary",
  DISABLED: "bg-destructive",
  PENDING: "bg-warning",
  NEW: "bg-primary",
  IN_REVIEW: "bg-warning",
  PENDING_VERIFICATION: "bg-warning",
  SUSPENDED: "bg-destructive",
  RESTRICTED: "bg-destructive",
  BANNED: "bg-destructive",
  RETIRED: "bg-muted-foreground",
  INACTIVE: "bg-muted-foreground",
  UNPUBLISHED: "bg-warning",
  IN_USE: "bg-success",
  SPARE: "bg-primary",
};

export function StatusPill({ status }: { status: string }) {
  const s = status.toUpperCase();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 uppercase tracking-wider",
        styles[s] ?? styles.PAUSED,
      )}
    >
      <span className={cn("size-1.5 rounded-full", dots[s] ?? dots.PAUSED)} />
      {s.toLowerCase()}
    </span>
  );
}
