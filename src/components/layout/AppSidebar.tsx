import { useEffect, useRef } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Building2,
  Megaphone,
  Images,
  FileText,
  Users,
  Settings,
  Activity,
  Bell,
  Briefcase,
  Sparkles,
  UserCog,
  RefreshCw,
  LogOut,
  DollarSign,
  MessagesSquare,
  Network,
  IdCard,
  Building,
  CreditCard,
  Crosshair,
  Flag,
  Loader2,
  ChevronRight,
  Server,
  type LucideIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PublicUser } from "@/lib/auth/users";
import { isAdmin, isSuperadmin } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";
import { MetaStatus } from "./MetaStatus";

interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
}

const main = [
  { title: "Ask", url: "/", icon: Sparkles },
  { title: "Overview", url: "/overview", icon: LayoutDashboard },
  { title: "Ad Accounts", url: "/accounts", icon: Building2 },
  { title: "Clients", url: "/clients", icon: Briefcase },
  { title: "Campaigns", url: "/campaigns", icon: Megaphone },
  { title: "Audiences", url: "/audiences", icon: Users },
  { title: "Creatives", url: "/creatives", icon: Images },
  { title: "Reports", url: "/reports", icon: FileText },
  { title: "Alerts", url: "/alerts", icon: Bell },
  { title: "Activity", url: "/activity", icon: Activity },
];

/**
 * Operator-owned asset registry, nested under one parent row. Admin-only: ban state and the rented
 * supply chain are sensitive.
 *
 * "Account Registry", NOT "Ad Accounts": the top-level `/accounts` entry above already owns that
 * label, and two rows reading "Ad Accounts" pointed at different pages — one performance, one asset
 * inventory. The duplicate was the single most confusing thing in this nav.
 */
const infrastructure = [
  { title: "Risk Map", url: "/infrastructure", icon: Network },
  { title: "Profiles", url: "/infrastructure/profiles", icon: IdCard },
  { title: "Business Managers", url: "/infrastructure/business-managers", icon: Building },
  { title: "Account Registry", url: "/infrastructure/ad-accounts", icon: CreditCard },
  { title: "Pixels", url: "/infrastructure/pixels", icon: Crosshair },
  { title: "Pages", url: "/infrastructure/pages", icon: Flag },
];

/**
 * Nav row with instant click feedback. TanStack `Link` sets
 * `data-transitioning="transitioning"` inside a `flushSync` on click and clears
 * it on the router's `onResolved` event, so the pressed style and the spinner
 * paint on the very next frame even while the target route's loader is still
 * running.
 */
function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
        <Link
          to={item.url}
          className={cn(
            "group/nav",
            "data-[transitioning=transitioning]:bg-sidebar-accent",
            "data-[transitioning=transitioning]:text-sidebar-accent-foreground",
            "data-[transitioning=transitioning]:font-medium",
            "data-[transitioning=transitioning]:ring-1",
            "data-[transitioning=transitioning]:ring-sidebar-ring/40",
          )}
        >
          <item.icon className="group-data-[transitioning=transitioning]/nav:hidden" />
          <Loader2 className="hidden animate-spin text-primary group-data-[transitioning=transitioning]/nav:block" />
          <span>{item.title}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * Infrastructure as ONE row that expands, instead of six competing with the main nav.
 *
 * Two renderings, because `SidebarMenuSub` is `group-data-[collapsible=icon]:hidden` — nesting simply
 * does not paint in the icon rail. Without the dropdown branch, collapsing the sidebar would make all
 * six pages unreachable, which is a regression on today's six always-visible icons rather than a
 * simplification.
 *
 * The parent toggles and never navigates. A row that both expands and goes somewhere makes the click
 * target ambiguous, and `/infrastructure` is already reachable as "Risk Map", its first child.
 */
function InfrastructureNav({
  items,
  isActive,
  sectionActive,
}: {
  items: NavItem[];
  isActive: (url: string) => boolean;
  sectionActive: boolean;
}) {
  const { state, isMobile } = useSidebar();
  // The mobile sidebar renders inside a Sheet, where it is always expanded.
  const iconOnly = state === "collapsed" && !isMobile;
  // Ten main rows plus six children overflow the nav on a laptop, and `SidebarContent` scrolls, so
  // landing on an Infrastructure page would otherwise highlight a child that is below the fold. Only
  // `block: "nearest"` — it must not yank the whole list when the row is already on screen.
  const activeItemRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (sectionActive && !iconOnly) activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [sectionActive, iconOnly]);

  if (iconOnly) {
    return (
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton isActive={sectionActive} tooltip="Infrastructure">
              <Server />
              <span>Infrastructure</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="min-w-44">
            {items.map((item) => (
              <DropdownMenuItem key={item.url} asChild>
                <Link to={item.url} className="gap-2">
                  <item.icon className="size-4" />
                  <span>{item.title}</span>
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    );
  }

  return (
    // Opens itself when you are already inside the section, so the active child is never hidden
    // behind a collapsed parent after a full page load.
    <Collapsible defaultOpen={sectionActive} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton isActive={sectionActive} tooltip="Infrastructure">
            <Server />
            <span>Infrastructure</span>
            <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {items.map((item) => {
              const active = isActive(item.url);
              return (
                <SidebarMenuSubItem key={item.url} ref={active ? activeItemRef : undefined}>
                  <SidebarMenuSubButton asChild isActive={active}>
                    <Link to={item.url}>
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

export function AppSidebar({ user }: { user: PublicUser }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Exact match for section roots, prefix match otherwise: `/infrastructure` would otherwise stay lit
  // on every child route alongside the child's own entry.
  const isActive = (url: string) =>
    url === "/" || url === "/infrastructure" ? pathname === url : pathname.startsWith(url);
  // System nav: Users/Sync/Settings for admins (+ superadmins); Finance/Chat History superadmin-only.
  const systemItems = [
    ...(isAdmin(user.role)
      ? [
          { title: "Users", url: "/users", icon: UserCog },
          { title: "Sync", url: "/sync", icon: RefreshCw },
          { title: "Settings", url: "/settings", icon: Settings },
        ]
      : []),
    ...(isSuperadmin(user.role)
      ? [
          { title: "Finance", url: "/finance", icon: DollarSign },
          { title: "Chat History", url: "/chat-history", icon: MessagesSquare },
        ]
      : []),
  ];

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <div className="size-8 rounded-md bg-primary grid place-items-center">
            <Activity className="size-4 text-primary-foreground" />
          </div>
          <div className="group-data-[collapsible=icon]:hidden">
            <div className="text-sm font-semibold tracking-tight leading-none">MetaConsole</div>
            <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
              v1.0.0 · internal
            </div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Intelligence</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {main.map((item) => (
                <NavLink key={item.url} item={item} active={isActive(item.url)} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {isAdmin(user.role) && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <InfrastructureNav
                  items={infrastructure}
                  isActive={isActive}
                  sectionActive={pathname.startsWith("/infrastructure")}
                />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        <MetaStatus />
        {/*
          System pages live behind the identity card rather than in a fourth nav group. Users, Sync,
          Settings, Finance and Chat History are occasional admin plumbing, and at top level they
          carried the same visual weight as the pages people open every morning. The avatar is also
          where a reader already looks for "my account and its settings", and it keeps working in the
          icon rail, where a nav group would have collapsed to five anonymous glyphs.
        */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Account and system settings"
              className="flex w-full items-center gap-2.5 rounded-md bg-sidebar-accent/40 p-2 text-left hover:bg-sidebar-accent group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0"
            >
              <div className="size-8 rounded-full bg-muted grid place-items-center text-[10px] font-semibold shrink-0 uppercase">
                {(user.name || user.email).slice(0, 2)}
              </div>
              <div className="text-xs leading-tight overflow-hidden flex-1 group-data-[collapsible=icon]:hidden">
                <div className="font-semibold truncate">{user.name || user.email}</div>
                <div className="text-muted-foreground truncate text-[10px] capitalize">
                  {user.role}
                </div>
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="min-w-52">
            {systemItems.map((item) => (
              <DropdownMenuItem key={item.url} asChild>
                <Link to={item.url} className="gap-2">
                  <item.icon className="size-4" />
                  <span>{item.title}</span>
                </Link>
              </DropdownMenuItem>
            ))}
            {systemItems.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem asChild>
              {/* A real navigation, not a router Link: logout is a server route that clears the cookie. */}
              <a href="/auth/logout" className="gap-2">
                <LogOut className="size-4" />
                <span>Sign out</span>
              </a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
