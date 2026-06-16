import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Building2,
  Megaphone,
  Images,
  Users,
  Settings,
  Activity,
  Target,
  Database,
  Bell,
  Briefcase,
  Sparkles,
  UserCog,
  LogOut,
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

const main = [
  { title: "Ask", url: "/", icon: Sparkles },
  { title: "Overview", url: "/overview", icon: LayoutDashboard },
  { title: "Ad Accounts", url: "/accounts", icon: Building2 },
  { title: "Campaigns", url: "/campaigns", icon: Megaphone },
  { title: "Creatives", url: "/creatives", icon: Images },
  { title: "Audiences", url: "/audiences", icon: Users },
  { title: "Targeting", url: "/targeting", icon: Target },
  { title: "Library", url: "/library", icon: Database },
  { title: "Clients", url: "/clients", icon: Briefcase },
  { title: "Alerts", url: "/alerts", icon: Bell },
  { title: "Activity", url: "/activity", icon: Activity },
];

export function AppSidebar({ user }: { user: PublicUser }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (url: string) => (url === "/" ? pathname === "/" : pathname.startsWith(url));
  // Settings + Users are admin-only.
  const systemItems =
    user.role === "admin"
      ? [
          { title: "Users", url: "/users", icon: UserCog },
          { title: "Settings", url: "/settings", icon: Settings },
        ]
      : [];

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
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild isActive={isActive(item.url)} tooltip={item.title}>
                    <Link to={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {systemItems.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>System</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {systemItems.map((item) => (
                  <SidebarMenuItem key={item.url}>
                    <SidebarMenuButton asChild isActive={isActive(item.url)} tooltip={item.title}>
                      <Link to={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
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
