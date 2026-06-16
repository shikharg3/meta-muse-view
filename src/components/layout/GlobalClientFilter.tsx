import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronDown, Check, Filter } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

export interface FilterClient {
  id: string;
  name: string;
  accountIds: string[];
}

/**
 * Global header filter: multi-select clients → writes their accounts to `?accounts=`,
 * which (via retainSearchParams on the root) persists across pages and scopes the
 * Accounts / Campaigns / Creatives lists.
 */
export function GlobalClientFilter({ clients }: { clients: FilterClient[] }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { accounts?: string };
  const selected = new Set((search.accounts ?? "").split(",").filter(Boolean));

  const isOn = (c: FilterClient) =>
    c.accountIds.length > 0 && c.accountIds.every((id) => selected.has(id));
  const onCount = clients.filter(isOn).length;

  const apply = (next: Set<string>) =>
    navigate({
      to: ".",
      search: (prev) => ({ ...prev, accounts: [...next].join(",") || undefined }),
    });
  const toggle = (c: FilterClient) => {
    const next = new Set(selected);
    if (isOn(c)) c.accountIds.forEach((id) => next.delete(id));
    else c.accountIds.forEach((id) => next.add(id));
    apply(next);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="hidden md:flex items-center gap-2 rounded-md border border-border bg-card hover:bg-accent px-3 h-9 text-xs transition-colors">
          <Filter className="size-3.5 text-muted-foreground" />
          <span className="font-medium">
            {onCount === 0 ? "All clients" : `${onCount} client${onCount > 1 ? "s" : ""}`}
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-72">
        <Command>
          <CommandInput placeholder="Filter by client…" className="text-xs" />
          <CommandList>
            <CommandEmpty>No clients found.</CommandEmpty>
            <CommandGroup>
              {onCount > 0 && (
                <CommandItem
                  value="__clear__"
                  onSelect={() =>
                    navigate({ to: ".", search: (p) => ({ ...p, accounts: undefined }) })
                  }
                  className="text-xs text-muted-foreground"
                >
                  Clear filter ({onCount})
                </CommandItem>
              )}
              {clients.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.name}
                  className="text-xs gap-2"
                  onSelect={() => toggle(c)}
                >
                  <Check className={cn("size-3.5", isOn(c) ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{c.name}</span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {c.accountIds.length}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
