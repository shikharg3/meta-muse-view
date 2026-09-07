import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The one control that sets an operator's priority marker, shared by the BM and profile registries so
 * the two cannot drift on affordance or wording.
 *
 * A `button` with `aria-pressed`, not a checkbox: it is a toggle on an existing row, and the label has
 * to name the row for a screen reader hearing forty of these in a table. Unstarred is drawn at
 * `/40` rather than hidden — an affordance nobody can see is not an affordance.
 */
export function MainStar({
  on,
  label,
  hint,
  onToggle,
}: {
  on: boolean;
  /** The row's own name, so the accessible label says which one this is. */
  label: string;
  hint: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      aria-label={on ? `Unmark ${label} as main` : `Mark ${label} as main`}
      title={hint}
      className={cn(
        "shrink-0 transition-colors",
        on ? "text-primary" : "text-muted-foreground/40 hover:text-muted-foreground",
      )}
    >
      <Star className={cn("size-3.5", on && "fill-primary")} />
    </button>
  );
}
