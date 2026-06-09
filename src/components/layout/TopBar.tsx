import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Calendar, ChevronDown, Download, RefreshCw, Search } from "lucide-react";

export function TopBar({ business }: { business: { businessId: string; accountCount: number } }) {
  return (
    <header className="h-14 border-b border-border bg-background/80 backdrop-blur-md sticky top-0 z-20 flex items-center gap-3 px-4 md:px-6">
      <SidebarTrigger className="-ml-1" />
      <div className="h-6 w-px bg-border mx-1" />

      <button className="hidden md:flex items-center gap-2 rounded-md border border-border bg-card hover:bg-accent px-3 h-9 text-xs transition-colors">
        <span className="text-muted-foreground">BM</span>
        <span className="font-medium">{business.businessId || "Not configured"}</span>
        <span className="text-muted-foreground font-mono">· {business.accountCount} accts</span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </button>

      <div className="relative hidden lg:block flex-1 max-w-xs ml-2">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <input
          placeholder="Search accounts, campaigns, ads…"
          className="w-full h-9 rounded-md border border-border bg-card pl-8 pr-3 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      <div className="flex-1 lg:hidden" />

      <button className="flex items-center gap-2 rounded-md border border-border bg-card hover:bg-accent px-3 h-9 text-xs transition-colors">
        <Calendar className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Last 30 days</span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </button>

      <Button variant="outline" size="sm" className="hidden sm:inline-flex h-9 text-xs">
        <RefreshCw className="size-3.5" /> Refresh
      </Button>
      <Button size="sm" className="h-9 text-xs">
        <Download className="size-3.5" /> Export
      </Button>
    </header>
  );
}
