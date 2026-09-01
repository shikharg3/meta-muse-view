export function fmtCurrency(n: number, currency = "USD", maximumFractionDigits = 0) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits,
  }).format(n);
}
export function fmtNumber(n: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}
export function fmtCompact(n: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    n,
  );
}
export function fmtPct(n: number, digits = 2) {
  return `${n.toFixed(digits)}%`;
}
/** Coarse relative age ("just now", "12m ago", "3h ago", "2d ago") for sync freshness. */
export function fmtRelTime(iso: string, now = new Date()): string {
  const mins = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const DISABLE_REASONS: Record<number, string> = {
  1: "Ads integrity policy",
  2: "Advertiser IP review",
  3: "Risk payment",
  4: "Gray account shutdown",
  5: "AFC review",
  6: "Business integrity review",
  7: "Permanently closed",
  8: "Unused reseller account",
  9: "Unused account",
};
/** Human label for a Meta account disable_reason; null when active (0) or unknown. */
export function disableReasonLabel(code: number | null | undefined): string | null {
  if (code == null || code === 0) return null;
  return DISABLE_REASONS[code] ?? `Disabled (reason ${code})`;
}
