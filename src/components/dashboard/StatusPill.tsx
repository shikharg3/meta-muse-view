import { cn } from "@/lib/utils";

const styles: Record<string, string> = {
  ACTIVE: "bg-success/10 text-success ring-success/20",
  LEARNING: "bg-warning/10 text-warning ring-warning/20",
  PAUSED: "bg-muted text-muted-foreground ring-border",
  COMPLETED: "bg-primary/10 text-primary ring-primary/20",
  DISABLED: "bg-destructive/10 text-destructive ring-destructive/20",
  PENDING: "bg-warning/10 text-warning ring-warning/20",
};
const dots: Record<string, string> = {
  ACTIVE: "bg-success",
  LEARNING: "bg-warning",
  PAUSED: "bg-muted-foreground",
  COMPLETED: "bg-primary",
  DISABLED: "bg-destructive",
  PENDING: "bg-warning",
};

export function StatusPill({ status }: { status: string }) {
  const s = status.toUpperCase();
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 uppercase tracking-wider",
      styles[s] ?? styles.PAUSED
    )}>
      <span className={cn("size-1.5 rounded-full", dots[s] ?? dots.PAUSED)} />
      {s.toLowerCase()}
    </span>
  );
}
