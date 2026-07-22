import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PageHeader } from "@/components/dashboard/PageHeader";
import {
  listUsers,
  listAudit,
  setUserStatus,
  setUserRole,
  deleteUser,
  resetPassword,
  getCurrentUser,
} from "@/lib/api/auth";
import { cn } from "@/lib/utils";
import type { UserStatus, UserRole } from "@/lib/auth/users";
import { isSuperadmin } from "@/lib/auth/roles";

export const Route = createFileRoute("/users")({
  head: () => ({ meta: [{ title: "Users — MetaConsole" }] }),
  loader: async () => {
    const [users, audit, me] = await Promise.all([listUsers(), listAudit(), getCurrentUser()]);
    return { users, audit, meId: me?.id ?? null, meRole: me?.role ?? null };
  },
  component: UsersAdmin,
});

const STATUS_TONE: Record<string, string> = {
  approved: "bg-success/10 text-success",
  pending: "bg-warning/10 text-warning",
  rejected: "bg-destructive/10 text-destructive",
};

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

function UsersAdmin() {
  const { users, audit, meId, meRole } = Route.useLoaderData();
  const router = useRouter();

  if ("error" in users) {
    return (
      <div className="p-6 md:p-8">
        <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
          You don't have access to this page.
        </div>
      </div>
    );
  }

  const setStatus = async (id: string, status: UserStatus) => {
    await setUserStatus({ data: { id, status } });
    await router.invalidate();
  };
  const setRole = async (id: string, role: UserRole) => {
    await setUserRole({ data: { id, role } });
    await router.invalidate();
  };
  const remove = async (id: string, email: string) => {
    if (!window.confirm(`Delete ${email}? This removes their account and access.`)) return;
    await deleteUser({ data: { id } });
    await router.invalidate();
  };
  const doResetPassword = async (id: string, email: string) => {
    const pw = window.prompt(
      `New password for ${email} (min 8 characters).\nShare it with them over a secure channel; they stay signed in on existing sessions until those expire.`,
    );
    if (pw == null) return;
    const r = await resetPassword({ data: { id, newPassword: pw } });
    window.alert(r.ok ? `Password for ${email} was reset.` : (r.error ?? "Reset failed."));
    await router.invalidate();
  };

  return (
    <div className="p-6 md:p-8 space-y-8 max-w-[1100px]">
      <PageHeader
        title="Users"
        description="Approve or revoke dashboard access and manage roles. New sign-ups stay pending until approved."
      />

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
              <th className="text-left px-5 py-2.5">User</th>
              <th className="text-left px-3 py-2.5">Role</th>
              <th className="text-left px-3 py-2.5">Status</th>
              <th className="text-left px-3 py-2.5">Last login</th>
              <th className="text-right px-5 py-2.5">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.users.map((u) => {
              const self = u.id === meId;
              return (
                <tr key={u.id} className="hover:bg-accent/40">
                  <td className="px-5 py-3">
                    <div className="font-medium">
                      {u.name || "—"}
                      {self && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground">(you)</span>
                      )}
                    </div>
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
                  <td className="px-3 py-3 text-muted-foreground text-xs">
                    {fmtTime(u.lastLoginAt)}
                  </td>
                  <td className="px-5 py-3 text-right space-x-1.5 whitespace-nowrap">
                    {u.status !== "approved" && (
                      <button
                        onClick={() => void setStatus(u.id, "approved")}
                        className="h-7 px-2.5 rounded-md bg-primary text-primary-foreground text-xs font-medium"
                      >
                        Approve
                      </button>
                    )}
                    {u.status === "approved" && !self && (
                      <button
                        onClick={() => void setStatus(u.id, "pending")}
                        className="h-7 px-2.5 rounded-md border border-border text-xs font-medium hover:bg-accent"
                      >
                        Revoke
                      </button>
                    )}
                    {!self && !isSuperadmin(u.role) && (
                      <button
                        onClick={() => void setRole(u.id, u.role === "admin" ? "member" : "admin")}
                        className="h-7 px-2.5 rounded-md border border-border text-xs font-medium hover:bg-accent"
                      >
                        {u.role === "admin" ? "Make member" : "Make admin"}
                      </button>
                    )}
                    {!self && u.status !== "rejected" && (
                      <button
                        onClick={() => void setStatus(u.id, "rejected")}
                        className="h-7 px-2.5 rounded-md text-xs font-medium text-destructive hover:bg-destructive/10"
                      >
                        Reject
                      </button>
                    )}
                    {!self && (
                      <button
                        onClick={() => void remove(u.id, u.email)}
                        className="h-7 px-2.5 rounded-md text-xs font-medium text-destructive hover:bg-destructive/10"
                      >
                        Delete
                      </button>
                    )}
                    {isSuperadmin(meRole) && !self && (
                      <button
                        onClick={() => void doResetPassword(u.id, u.email)}
                        className="h-7 px-2.5 rounded-md border border-border text-xs font-medium hover:bg-accent"
                      >
                        Reset password
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <section>
        <h3 className="text-sm font-semibold mb-3">Activity log</h3>
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          {"error" in audit || audit.entries.length === 0 ? (
            <div className="px-5 py-6 text-center text-xs text-muted-foreground">
              No recorded activity yet.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {audit.entries.map((e) => (
                <li key={e.id} className="px-5 py-2.5 flex items-center gap-3 text-xs">
                  <span className="font-mono text-[10px] text-muted-foreground w-36 shrink-0">
                    {fmtTime(e.createdAt)}
                  </span>
                  <span className="font-medium shrink-0">{e.actorEmail}</span>
                  <span className="text-muted-foreground truncate">{e.detail}</span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground shrink-0">
                    {e.action}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
