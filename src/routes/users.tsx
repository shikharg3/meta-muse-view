import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { listUsers, setUserStatus } from "@/lib/api/auth";
import { cn } from "@/lib/utils";
import type { UserStatus } from "@/lib/auth/users";

export const Route = createFileRoute("/users")({
  head: () => ({ meta: [{ title: "Users — MetaConsole" }] }),
  loader: async () => await listUsers(),
  component: UsersAdmin,
});

const STATUS_TONE: Record<string, string> = {
  approved: "bg-success/10 text-success",
  pending: "bg-warning/10 text-warning",
  rejected: "bg-destructive/10 text-destructive",
};

function UsersAdmin() {
  const data = Route.useLoaderData();
  const router = useRouter();

  if ("error" in data) {
    return (
      <div className="p-6 md:p-8">
        <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
          You don't have access to this page.
        </div>
      </div>
    );
  }

  const update = async (id: string, status: UserStatus) => {
    await setUserStatus({ data: { id, status } });
    await router.invalidate();
  };

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1100px]">
      <PageHeader
        title="Users"
        description="Approve or revoke dashboard access. New sign-ups stay pending until approved."
      />
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
              <th className="text-left px-5 py-2.5">User</th>
              <th className="text-left px-3 py-2.5">Role</th>
              <th className="text-left px-3 py-2.5">Status</th>
              <th className="text-right px-5 py-2.5">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.users.map((u) => (
              <tr key={u.id} className="hover:bg-accent/40">
                <td className="px-5 py-3">
                  <div className="font-medium">{u.name || "—"}</div>
                  <div className="text-[11px] text-muted-foreground font-mono">{u.email}</div>
                </td>
                <td className="px-3 py-3 capitalize text-muted-foreground">{u.role}</td>
                <td className="px-3 py-3">
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
                      STATUS_TONE[u.status],
                    )}
                  >
                    {u.status}
                  </span>
                </td>
                <td className="px-5 py-3 text-right space-x-1.5">
                  {u.status !== "approved" && (
                    <button
                      onClick={() => void update(u.id, "approved")}
                      className="h-7 px-2.5 rounded-md bg-primary text-primary-foreground text-xs font-medium"
                    >
                      Approve
                    </button>
                  )}
                  {u.status === "approved" && (
                    <button
                      onClick={() => void update(u.id, "pending")}
                      className="h-7 px-2.5 rounded-md border border-border text-xs font-medium hover:bg-accent"
                    >
                      Revoke
                    </button>
                  )}
                  {u.status !== "rejected" && (
                    <button
                      onClick={() => void update(u.id, "rejected")}
                      className="h-7 px-2.5 rounded-md text-xs font-medium text-destructive hover:bg-destructive/10"
                    >
                      Reject
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
