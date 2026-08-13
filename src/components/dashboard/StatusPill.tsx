import { cn } from "@/lib/utils";

const styles: Record<string, string> = {
  ACTIVE: "bg-success/10 text-success ring-success/20",
  LEARNING: "bg-warning/10 text-warning ring-warning/20",
  PAUSED: "bg-muted text-muted-foreground ring-border",
  COMPLETED: "bg-primary/10 text-primary ring-primary/20",
  DISABLED: "bg-destructive/10 text-destructive ring-destructive/20",
  PENDING: "bg-warning/10 text-warning ring-warning/20",
  // Infrastructure registry — profile status set.
  VIDEO_SELFIE: "bg-warning/10 text-warning ring-warning/20",
  IN_REVIEW: "bg-warning/10 text-warning ring-warning/20",
  SUSPENDED: "bg-destructive/10 text-destructive ring-destructive/20",
  CANNOT_USE_PAGE: "bg-destructive/10 text-destructive ring-destructive/20",
  CANNOT_USE_ADS_MANAGER: "bg-destructive/10 text-destructive ring-destructive/20",
  READ_ONLY: "bg-destructive/10 text-destructive ring-destructive/20",
  // BM type.
  VERIFIED: "bg-success/10 text-success ring-success/20",
  NON_VERIFIED: "bg-muted text-muted-foreground ring-border",
  USED_FOR_DOT_APPS: "bg-primary/10 text-primary ring-primary/20",
  // Pixel / page / ad-account usage.
  RESTRICTED: "bg-destructive/10 text-destructive ring-destructive/20",
  BANNED: "bg-destructive/20 text-destructive ring-destructive/30",
  INACTIVE: "bg-muted text-muted-foreground ring-border",
  UNPUBLISHED: "bg-warning/10 text-warning ring-warning/20",
  IN_USE: "bg-success/10 text-success ring-success/20",
  SPARE: "bg-primary/10 text-primary ring-primary/20",
  RETIRED: "bg-muted text-muted-foreground ring-border",
};
const dots: Record<string, string> = {
  ACTIVE: "bg-success",
  LEARNING: "bg-warning",
  PAUSED: "bg-muted-foreground",
  COMPLETED: "bg-primary",
  DISABLED: "bg-destructive",
  PENDING: "bg-warning",
  VIDEO_SELFIE: "bg-warning",
  IN_REVIEW: "bg-warning",
  SUSPENDED: "bg-destructive",
  CANNOT_USE_PAGE: "bg-destructive",
  CANNOT_USE_ADS_MANAGER: "bg-destructive",
  READ_ONLY: "bg-destructive",
  VERIFIED: "bg-success",
  NON_VERIFIED: "bg-muted-foreground",
  USED_FOR_DOT_APPS: "bg-primary",
  RESTRICTED: "bg-destructive",
  BANNED: "bg-destructive",
  INACTIVE: "bg-muted-foreground",
  UNPUBLISHED: "bg-warning",
  IN_USE: "bg-success",
  SPARE: "bg-primary",
  RETIRED: "bg-muted-foreground",
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
      {/* Underscores read as identifiers; `cannot_use_ads_manager` should say "cannot use ads
          manager". The wrapper is `uppercase`, so casing here is cosmetic. */}
      {s.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}
