import { useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface LinkOption {
  id: string;
  label: string;
  /** Dimmed with a marker — e.g. a banned BM, which is a real link but not an access path. */
  unusable?: boolean;
}

/**
 * The universal M:N link editor, shared by every registry screen.
 *
 * `onChange` returns the server's verdict, so a refused link (root BM as a share, page owner as an
 * additional profile) shows its reason instead of silently doing nothing. The reference implementation
 * writes blind and needs an optimistic-draft protocol with a monotonic version counter to recover;
 * awaiting the server and surfacing the error removes all of that.
 */
export function LinkChips({
  linked,
  options,
  onChange,
  emptyLabel = "none",
}: {
  linked: string[];
  options: LinkOption[];
  onChange: (id: string, action: "add" | "remove") => Promise<{ ok: boolean; error?: string }>;
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const optionById = new Map(options.map((o) => [o.id, o]));
  const linkedIds = new Set(linked);
  const available = options.filter((o) => !linkedIds.has(o.id));

  const apply = async (id: string, action: "add" | "remove") => {
    setBusy(true);
    setError(null);
    const result = await onChange(id, action);
    setBusy(false);
    if (result.ok) setOpen(false);
    else setError(result.error ?? "Failed");
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        {linked.length === 0 && (
          <span className="text-[11px] text-muted-foreground">{emptyLabel}</span>
        )}
        {linked.map((id) => {
          const option = optionById.get(id);
          return (
            <span
              key={id}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px]",
                option?.unusable && "opacity-60 line-through",
              )}
            >
              {option?.label ?? id}
              <button
                type="button"
                disabled={busy}
                onClick={() => apply(id, "remove")}
                className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                aria-label={`Unlink ${option?.label ?? id}`}
              >
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        {available.length > 0 && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={busy}
                className="inline-flex items-center rounded-md border border-dashed border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
                aria-label="Add link"
              >
                <Plus className="size-3" />
              </button>
            </PopoverTrigger>
            {/*
             * Portaled, not `absolute`: these chips live inside a table whose wrapper is
             * `overflow-x-auto`, and per spec a non-visible overflow on one axis forces the other to
             * `auto` too — so an absolutely-positioned panel gets clipped by the scroll box and
             * painted under the table footer. Radix's portal escapes the container entirely.
             */}
            <PopoverContent align="start" className="max-h-64 w-56 overflow-y-auto p-1">
              {available.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={busy}
                  onClick={() => apply(option.id, "add")}
                  className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-accent disabled:opacity-40"
                >
                  {option.label}
                  {option.unusable && (
                    <span className="ml-1 text-muted-foreground">(unusable)</span>
                  )}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        )}
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
