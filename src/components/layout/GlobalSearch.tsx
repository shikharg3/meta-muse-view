import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { runSearch } from "@/lib/api/dashboard";

type Results = {
  clients: { id: string; name: string; status: string | null }[];
  accounts: { id: string; name: string }[];
  campaigns: { id: string; name: string; accountId: string }[];
  brands: { brand: string; clientId: string; clientName: string }[];
};
const EMPTY: Results = { clients: [], accounts: [], campaigns: [], brands: [] };

type Scope = "all" | "clients" | "accounts" | "campaigns";
const SCOPES: { key: Scope; label: string }[] = [
  { key: "all", label: "All" },
  { key: "clients", label: "Clients" },
  { key: "accounts", label: "Accounts" },
  { key: "campaigns", label: "Campaigns" },
];

/** Global search palette (⌘K) over clients, accounts, and campaigns; navigates on select. */
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [res, setRes] = useState<Results>(EMPTY);
  const navigate = useNavigate();

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setRes(EMPTY);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await runSearch({ data: term });
        if (!cancelled) setRes(r);
      } catch {
        /* ignore transient errors while typing */
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const close = () => {
    setOpen(false);
    setQ("");
  };
  const goClient = (id: string) => {
    close();
    navigate({ to: "/clients", search: (s) => ({ ...s, client: id }) });
  };
  const goAccount = (id: string) => {
    close();
    navigate({ to: "/accounts/$id", params: { id } });
  };

  const show = (s: Scope) => scope === "all" || scope === s;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Search clients, accounts, campaigns"
        title="Search clients, accounts, campaigns (⌘K)"
        // Icon-only once there is room for it at all, and only becomes the elastic labelled box
        // when the bar is wide enough to spare ~320px. ⌘K works regardless of which form is shown.
        className="hidden @min-[720px]:flex items-center gap-2 shrink-0 h-9 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground hover:bg-accent transition-colors @min-[1430px]:ml-2 @min-[1430px]:min-w-0 @min-[1430px]:flex-1 @min-[1430px]:shrink @min-[1430px]:max-w-xs"
      >
        <Search className="size-3.5 shrink-0" />
        <span className="hidden @min-[1430px]:block truncate">Search clients, accounts…</span>
        <kbd className="hidden @min-[1430px]:inline ml-auto text-[10px] font-mono opacity-60">
          ⌘K
        </kbd>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="overflow-hidden p-0" aria-describedby={undefined}>
          <DialogTitle className="sr-only">Search</DialogTitle>
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search clients, accounts, campaigns…"
              value={q}
              onValueChange={setQ}
            />
            <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border">
              {SCOPES.map((s) => (
                <button
                  key={s.key}
                  onClick={() => setScope(s.key)}
                  className={cn(
                    "rounded px-2 h-6 text-[11px] font-medium transition-colors",
                    scope === s.key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <CommandList>
              <CommandEmpty>{q.trim() ? "No results." : "Type to search."}</CommandEmpty>
              {show("clients") && res.clients.length > 0 && (
                <CommandGroup heading="Clients">
                  {res.clients.map((c) => (
                    <CommandItem key={c.id} value={`cl:${c.id}`} onSelect={() => goClient(c.id)}>
                      <span className="truncate">{c.name}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        {c.status ?? "client"}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {show("clients") && res.brands.length > 0 && (
                <CommandGroup heading="Brands">
                  {res.brands.map((b) => (
                    <CommandItem
                      key={`br:${b.clientId}:${b.brand}`}
                      value={`br:${b.clientId}:${b.brand}`}
                      onSelect={() => goClient(b.clientId)}
                    >
                      <span className="truncate">{b.brand}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        {b.clientName}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {show("accounts") && res.accounts.length > 0 && (
                <CommandGroup heading="Ad accounts">
                  {res.accounts.map((a) => (
                    <CommandItem key={a.id} value={`a:${a.id}`} onSelect={() => goAccount(a.id)}>
                      <span className="truncate">{a.name}</span>
                      <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                        {a.id.replace("act_", "")}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {show("campaigns") && res.campaigns.length > 0 && (
                <CommandGroup heading="Campaigns">
                  {res.campaigns.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={`c:${c.id}`}
                      onSelect={() => goAccount(c.accountId)}
                    >
                      <span className="truncate">{c.name}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        open account
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
