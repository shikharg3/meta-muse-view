import { AlertTriangle, CheckCircle2, ShieldAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Risk, RiskLevel } from "@/lib/infra-risk";

const tone: Record<RiskLevel, string> = {
  critical: "bg-destructive/10 text-destructive ring-destructive/20",
  warning: "bg-warning/10 text-warning ring-warning/20",
  safe: "bg-success/10 text-success ring-success/20",
};

const icon: Record<RiskLevel, LucideIcon> = {
  critical: ShieldAlert,
  warning: AlertTriangle,
  safe: CheckCircle2,
};

/** The label carries the reason ("No backup", "Not shared"), so no numeric score is needed. */
export function RiskBadge({ risk, className }: { risk: Risk; className?: string }) {
  const Icon = icon[risk.level];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 uppercase tracking-wider",
        tone[risk.level],
        className,
      )}
    >
      <Icon className="size-3" />
      {risk.label}
    </span>
  );
}
