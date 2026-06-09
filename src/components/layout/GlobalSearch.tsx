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
import { runSearch } from "@/lib/api/dashboard";

type Results = {
  accounts: { id: string; name: string }[];
  campaigns: { id: string; name: string; accountId: string }[];
};
const EMPTY: Results = { accounts: [], campaigns: [] };

/** Global search palette (⌘K) querying accounts + campaigns server-side; navigates on select. */
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
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

  function goAccount(id: string) {
    setOpen(false);
    setQ("");
    navigate({ to: "/accounts/$id", params: { id } });
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="hidden lg:flex items-center gap-2 flex-1 max-w-xs ml-2 h-9 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground hover:bg-accent transition-colors"
      >
        <Search className="size-3.5" />
        <span>Search accounts, campaigns…</span>
        <kbd className="ml-auto text-[10px] font-mono opacity-60">⌘K</kbd>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="overflow-hidden p-0" aria-describedby={undefined}>
          <DialogTitle className="sr-only">Search</DialogTitle>
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search accounts, campaigns…" value={q} onValueChange={setQ} />
            <CommandList>
              <CommandEmpty>{q.trim() ? "No results." : "Type to search."}</CommandEmpty>
              {res.accounts.length > 0 && (
                <CommandGroup heading="Accounts">
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
              {res.campaigns.length > 0 && (
                <CommandGroup heading="Campaigns">
                  {res.campaigns.map((c) => (
                    <CommandItem key={c.id} value={`c:${c.id}`} onSelect={() => goAccount(c.accountId)}>
                      <span className="truncate">{c.name}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground">view account</span>
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
