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
  CommandSeparator,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

export interface FilterClient {
  id: string;
  name: string;
  accountIds: string[];
}

/**
 * Global header filter: pick whole clients (→ all their ad accounts) and/or
 * individual ad accounts. Both write the selected accounts to `?accounts=`,
 * which (via retainSearchParams on the root) persists across pages and scopes
 * the Accounts / Campaigns / Creatives / Audiences views.
 */
export function GlobalClientFilter({
  clients,
  accounts,
}: {
  clients: FilterClient[];
  accounts: { id: string; name: string }[];
}) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { accounts?: string };
  const selected = new Set((search.accounts ?? "").split(",").filter(Boolean));
  const count = selected.size;

  const clientOn = (c: FilterClient) =>
    c.accountIds.length > 0 && c.accountIds.every((id) => selected.has(id));

  const apply = (next: Set<string>) =>
    navigate({
      to: ".",
      search: (prev) => ({ ...prev, accounts: [...next].join(",") || undefined }),
    });
  const toggleClient = (c: FilterClient) => {
    const next = new Set(selected);
    if (clientOn(c)) c.accountIds.forEach((id) => next.delete(id));
    else c.accountIds.forEach((id) => next.add(id));
    apply(next);
  };
  const toggleAccount = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="hidden @min-[660px]:flex items-center gap-2 shrink-0 whitespace-nowrap rounded-md border border-border bg-card hover:bg-accent px-3 h-9 text-xs transition-colors">
          <Filter className="size-3.5 text-muted-foreground" />
          <span className="font-medium">
            {count === 0 ? "All accounts" : `${count} account${count > 1 ? "s" : ""}`}
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-72">
        <Command>
          <CommandInput placeholder="Filter by client or account…" className="text-xs" />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            {count > 0 && (
              <CommandGroup>
                <CommandItem
                  value="__clear__"
                  onSelect={() =>
                    navigate({ to: ".", search: (p) => ({ ...p, accounts: undefined }) })
                  }
                  className="text-xs text-muted-foreground"
                >
                  Clear filter ({count})
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading="Clients">
              {clients.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`client ${c.name}`}
                  className="text-xs gap-2"
                  onSelect={() => toggleClient(c)}
                >
                  <Check className={cn("size-3.5", clientOn(c) ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{c.name}</span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {c.accountIds.length}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Ad accounts">
              {accounts.map((a) => (
                <CommandItem
                  key={a.id}
                  value={`account ${a.name} ${a.id}`}
                  className="text-xs gap-2"
                  onSelect={() => toggleAccount(a.id)}
                >
                  <Check
                    className={cn("size-3.5", selected.has(a.id) ? "opacity-100" : "opacity-0")}
                  />
                  <span className="truncate">{a.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
