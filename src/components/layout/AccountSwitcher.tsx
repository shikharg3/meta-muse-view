import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/** Business-manager chip that opens a searchable account list and jumps to the detail page. */
export function AccountSwitcher({
  business,
  accounts,
}: {
  business: { businessId: string; accountCount: number };
  accounts: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="hidden @min-[1160px]:flex items-center gap-2 shrink-0 whitespace-nowrap rounded-md border border-border bg-card hover:bg-accent px-3 h-9 text-xs transition-colors">
          <span className="text-muted-foreground">BM</span>
          <span className="font-medium">{business.businessId || "Not configured"}</span>
          {/* First thing to go when the bar tightens: the count is the least load-bearing part. */}
          <span className="hidden @min-[1250px]:inline text-muted-foreground font-mono">
            · {business.accountCount} accts
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-72">
        <Command>
          <CommandInput placeholder="Switch account…" className="text-xs" />
          <CommandList>
            <CommandEmpty>No accounts found.</CommandEmpty>
            <CommandGroup>
              {accounts.map((a) => (
                <CommandItem
                  key={a.id}
                  value={`${a.name} ${a.id}`}
                  className="text-xs gap-2"
                  onSelect={() => {
                    setOpen(false);
                    navigate({ to: "/accounts/$id", params: { id: a.id } });
                  }}
                >
                  <span className="truncate">{a.name}</span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {a.id.replace("act_", "")}
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
