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
  SidebarFooter,
} from "@/components/ui/sidebar";
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

/** Operator-owned asset registry. Admin-only: ban state and the rented supply chain are sensitive. */
const infrastructure = [
  { title: "Risk Map", url: "/infrastructure", icon: Network },
  { title: "Profiles", url: "/infrastructure/profiles", icon: IdCard },
  { title: "Business Managers", url: "/infrastructure/business-managers", icon: Building },
  { title: "Ad Accounts", url: "/infrastructure/ad-accounts", icon: CreditCard },
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
            <SidebarGroupLabel>Infrastructure</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {infrastructure.map((item) => (
                  <NavLink key={item.url} item={item} active={isActive(item.url)} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        {systemItems.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>System</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {systemItems.map((item) => (
                  <NavLink key={item.url} item={item} active={isActive(item.url)} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        <MetaStatus />
        <div className="flex items-center gap-2.5 rounded-md bg-sidebar-accent/40 p-2 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0">
          <div className="size-8 rounded-full bg-muted grid place-items-center text-[10px] font-semibold shrink-0 uppercase">
            {(user.name || user.email).slice(0, 2)}
          </div>
          <div className="text-xs leading-tight overflow-hidden flex-1 group-data-[collapsible=icon]:hidden">
            <div className="font-semibold truncate">{user.name || user.email}</div>
            <div className="text-muted-foreground truncate text-[10px] capitalize">{user.role}</div>
          </div>
          <a
            href="/auth/logout"
            title="Sign out"
            className="size-7 grid place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground shrink-0 group-data-[collapsible=icon]:hidden"
          >
            <LogOut className="size-4" />
          </a>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
