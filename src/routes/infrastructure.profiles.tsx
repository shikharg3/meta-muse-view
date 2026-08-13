import { useMemo, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Plus, Search } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { PagePendingSkeleton } from "@/components/dashboard/TableSkeleton";
import { StatusPill } from "@/components/dashboard/StatusPill";
import { useSort, SortHeader } from "@/components/dashboard/SortableTable";
import { LinkChips, type LinkOption } from "@/components/infra/LinkChips";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getCurrentUser } from "@/lib/api/auth";
import { isAdmin } from "@/lib/auth/roles";
import {
  listInfraProfiles,
  listInfraBms,
  saveInfraProfile,
  deleteInfraProfile,
  linkInfraProfileBm,
  setInfraProfileStatus,
} from "@/lib/api/infrastructure";
import { usableBm } from "@/lib/infra-risk";
import { PROFILE_STATUSES, isBmStatus } from "@/lib/infra-status";
import { cn } from "@/lib/utils";
import type { ProfileView } from "@/server/fns/infra/profiles";
import type { BmView } from "@/server/fns/infra/bms";

export const Route = createFileRoute("/infrastructure/profiles")({
  head: () => ({ meta: [{ title: "Profiles — MetaConsole" }] }),
  loader: async () => {
    const me = await getCurrentUser();
    if (!isAdmin(me?.role)) throw redirect({ to: "/" });
    const [profiles, bms] = await Promise.all([listInfraProfiles(), listInfraBms()]);
    return { profiles, bms };
  },
  component: ProfilesPage,
  pendingComponent: () => <PagePendingSkeleton rows={10} kpis={0} />,
});

const INPUT_CLASS =
  "h-9 w-full rounded-md border border-border bg-card px-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring";

/** `ProfileView | "new"` — an existing row to edit, or the blank-form sentinel. */
type DialogTarget = ProfileView | "new";

function ProfilesPage() {
  const { profiles, bms } = Route.useLoaderData();
  const router = useRouter();

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [target, setTarget] = useState<DialogTarget | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Runtime keyed collection (UUIDs from the DB), used for the multi-hop BM search below.
  const bmById = useMemo(
    () => new Map<string, BmView>(bms.map((bm: BmView) => [bm.id, bm])),
    [bms],
  );

  const bmOptions = useMemo<LinkOption[]>(
    () =>
      bms.map((bm: BmView) => ({
        id: bm.id,
        label: bm.name,
        unusable: !(isBmStatus(bm.status) && usableBm(bm.status)),
      })),
    [bms],
  );

  // Multi-hop: a profile matches on its own fields, or on any assigned BM's name / BM ID.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return profiles.filter((r: ProfileView) => {
      if (status !== "all" && r.status !== status) return false;
      if (!needle) return true;
      if (
        r.name.toLowerCase().includes(needle) ||
        (r.geo?.toLowerCase().includes(needle) ?? false) ||
        (r.notes?.toLowerCase().includes(needle) ?? false)
      ) {
        return true;
      }
      return r.bmIds.some((id: string) => {
        const bm = bmById.get(id);
        if (!bm) return false;
        return bm.name.toLowerCase().includes(needle) || bm.bmId.toLowerCase().includes(needle);
      });
    });
  }, [profiles, bmById, q, status]);

  const { sorted, key, dir, toggle } = useSort<ProfileView>(
    filtered,
    {
      name: (r) => r.name,
      status: (r) => r.status,
      bms: (r) => r.bmIds.length,
    },
    "name",
    "asc",
  );

  const changeStatus = async (r: ProfileView, next: string) => {
    const res = await setInfraProfileStatus({ data: { id: r.id, status: next } });
    if (!res.ok) {
      setMsg(res.error ?? "Could not change status");
      return;
    }
    setMsg(null);
    await router.invalidate();
  };

  const remove = async (r: ProfileView) => {
    if (!window.confirm(`Delete ${r.name}?`)) return;
    const res = await deleteInfraProfile({ data: { id: r.id } });
    if (!res.ok) {
      // A profile owning a page is refused by the database — the operator needs the reason.
      setMsg(res.error ?? "Could not delete profile");
      return;
    }
    setMsg(null);
    await router.invalidate();
  };

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1600px]">
      <PageHeader
        title="Profiles"
        description="Facebook personal profiles that administer your Business Managers. A BM with no usable profile is unreachable."
      >
        <button
          onClick={() => setTarget("new")}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium"
        >
          <Plus className="size-3.5" /> Add profile
        </button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search profiles, geo, notes, assigned BMs…"
            className="w-full h-9 rounded-md border border-border bg-card pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex rounded-md border border-border bg-card overflow-hidden text-xs">
          {(["all", ...PROFILE_STATUSES] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={cn(
                "px-3 h-9 font-medium uppercase tracking-wider text-[10px] transition-colors",
                status === s
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              {s.replace("_", " ")}
            </button>
          ))}
        </div>
      </div>

      {msg && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span>{msg}</span>
          <button onClick={() => setMsg(null)} className="font-medium hover:underline shrink-0">
            Dismiss
          </button>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
                <SortHeader label="Name" sortKey="name" active={key} dir={dir} onSort={toggle} />
                <SortHeader
                  label="Status"
                  sortKey="status"
                  active={key}
                  dir={dir}
                  onSort={toggle}
                />
                <SortHeader
                  label="Assigned BMs"
                  sortKey="bms"
                  active={key}
                  dir={dir}
                  onSort={toggle}
                />
                <th className="text-left px-3 py-2.5">Geo</th>
                <th className="text-left px-3 py-2.5">Browser</th>
                <th className="text-left px-3 py-2.5">Proxy</th>
                <th className="text-right px-5 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((r) => (
                <tr key={r.id} className="hover:bg-accent/40 transition-colors">
                  <td className="px-5 py-3">
                    <div className="font-medium">{r.name}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{r.id}</div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <StatusPill status={r.status} />
                      <select
                        value={r.status}
                        onChange={(e) => void changeStatus(r, e.target.value)}
                        aria-label={`Status for ${r.name}`}
                        className="h-7 rounded-md border border-border bg-card px-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        {PROFILE_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s.replace("_", " ")}
                          </option>
                        ))}
                      </select>
                    </div>
                  </td>
                  <td className="px-3 py-3 min-w-[240px]">
                    <LinkChips
                      linked={r.bmIds}
                      options={bmOptions}
                      emptyLabel="spare"
                      onChange={async (id: string, action: "add" | "remove") => {
                        const res = await linkInfraProfileBm({
                          data: { profileId: r.id, bmId: id, action },
                        });
                        if (res.ok) await router.invalidate();
                        return res;
                      }}
                    />
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{r.geo ?? "—"}</td>
                  <td className="px-3 py-3 text-muted-foreground">{r.browser ?? "—"}</td>
                  <td className="px-3 py-3 text-muted-foreground">{r.proxyProvider ?? "—"}</td>
                  <td className="px-5 py-3 text-right space-x-1.5 whitespace-nowrap">
                    <button
                      onClick={() => setTarget(r)}
                      className="h-7 px-2.5 rounded-md border border-border text-xs font-medium hover:bg-accent"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => void remove(r)}
                      className="h-7 px-2.5 rounded-md text-xs font-medium text-destructive hover:bg-destructive/10"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-sm text-muted-foreground">
                    No profiles match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-3 border-t border-border text-[11px] text-muted-foreground font-mono">
          {sorted.length} of {profiles.length} profiles
        </div>
      </div>

      {target && (
        <ProfileDialog
          target={target}
          onClose={() => setTarget(null)}
          onSaved={async () => {
            setTarget(null);
            await router.invalidate();
          }}
        />
      )}
    </div>
  );
}

interface ProfileForm {
  name: string;
  status: string;
  geo: string;
  browser: string;
  proxyProvider: string;
  notes: string;
}

/**
 * Mounted only while a target exists, so the form seeds from `target` without an effect to sync it.
 */
function ProfileDialog({
  target,
  onClose,
  onSaved,
}: {
  target: DialogTarget;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const editing = target === "new" ? null : target;
  const [form, setForm] = useState<ProfileForm>({
    name: editing?.name ?? "",
    status: editing?.status ?? PROFILE_STATUSES[0],
    geo: editing?.geo ?? "",
    browser: editing?.browser ?? "",
    proxyProvider: editing?.proxyProvider ?? "",
    notes: editing?.notes ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await saveInfraProfile({ data: { id: editing?.id ?? null, ...form } });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Could not save profile");
      return;
    }
    await onSaved();
  };

  return (
    <Dialog open onOpenChange={(open: boolean) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>{editing ? `Edit ${editing.name}` : "Add profile"}</DialogTitle>
        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
          <label className="block space-y-1">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Name
            </span>
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Maria Silva"
              className={INPUT_CLASS}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Status
            </span>
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
              className={INPUT_CLASS}
            >
              {PROFILE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Geo
              </span>
              <input
                value={form.geo}
                onChange={(e) => setForm({ ...form, geo: e.target.value })}
                placeholder="e.g. BR"
                className={INPUT_CLASS}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Browser
              </span>
              <input
                value={form.browser}
                onChange={(e) => setForm({ ...form, browser: e.target.value })}
                placeholder="e.g. Dolphin"
                className={INPUT_CLASS}
              />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Proxy provider
            </span>
            <input
              value={form.proxyProvider}
              onChange={(e) => setForm({ ...form, proxyProvider: e.target.value })}
              placeholder="e.g. Bright Data"
              className={INPUT_CLASS}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Notes
            </span>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={3}
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-3 rounded-md border border-border text-xs font-medium hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !form.name.trim()}
              className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
            >
              {busy ? "Saving…" : editing ? "Save changes" : "Create profile"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
