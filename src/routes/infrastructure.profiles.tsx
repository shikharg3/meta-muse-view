import { useMemo, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { ChevronDown, Plus, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  setInfraProfileStatuses,
} from "@/lib/api/infrastructure";
import { bmIssue } from "@/lib/infra-risk";
import {
  INFRA_STATUS_LABEL,
  PROFILE_STATUSES,
  isBmStatus,
  type ProfileStatus,
} from "@/lib/infra-status";
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
  const [status, setStatus] = useState<"all" | ProfileStatus>("all");
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
        issue: isBmStatus(bm.status) ? (bmIssue(bm.status) ?? undefined) : bm.status,
      })),
    [bms],
  );

  // Multi-hop: a profile matches on its own fields, its status labels, or an assigned BM's name / ID.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return profiles.filter((r: ProfileView) => {
      if (status !== "all" && !r.statuses.includes(status)) return false;
      if (!needle) return true;
      // Labels, not keys, so the operator can search the words they see: "read only", "ads manager".
      const statusText = r.statuses.map((s) => INFRA_STATUS_LABEL[s] ?? s).join(" ");
      if (
        r.name.toLowerCase().includes(needle) ||
        (r.geo?.toLowerCase().includes(needle) ?? false) ||
        (r.notes?.toLowerCase().includes(needle) ?? false) ||
        statusText.toLowerCase().includes(needle)
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
      statuses: (r) => r.statuses.join(","),
      bms: (r) => r.bmIds.length,
    },
    "name",
    "asc",
  );

  const changeStatuses = async (r: ProfileView, next: ProfileStatus[]) => {
    const res = await setInfraProfileStatuses({ data: { id: r.id, statuses: next } });
    if (!res.ok) {
      setMsg(res.error ?? "Could not change statuses");
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
            placeholder="Search profiles, status, geo, notes, assigned BMs…"
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
              {s === "all" ? "all" : (INFRA_STATUS_LABEL[s] ?? s)}
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
                  sortKey="statuses"
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
                    <div className="flex items-start gap-2">
                      <div className="flex flex-wrap gap-1">
                        {r.statuses.map((s) => (
                          <StatusPill key={s} status={s} />
                        ))}
                      </div>
                      <StatusPicker
                        statuses={r.statuses}
                        name={r.name}
                        onChange={(next) => changeStatuses(r, next)}
                      />
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
                  <td colSpan={6} className="px-5 py-12 text-center text-sm text-muted-foreground">
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

/**
 * The row's set editor: a count trigger over the shared checkbox list. A `<select>` cannot express a
 * set, and every row needs its own open state, so the popover lives here and not in the table cell.
 * Each tick posts on its own and the panel stays open, so swapping a status reads as two steps.
 */
function StatusPicker({
  statuses,
  name,
  onChange,
}: {
  statuses: readonly ProfileStatus[];
  name: string;
  onChange: (next: ProfileStatus[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const apply = async (next: ProfileStatus[]) => {
    setBusy(true);
    await onChange(next);
    setBusy(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={busy}
          aria-label={`Statuses for ${name}`}
          className="inline-flex items-center gap-1 h-7 rounded-md border border-border bg-card px-1.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          {statuses.length}
          <ChevronDown className="size-3" />
        </button>
      </PopoverTrigger>
      {/*
       * Portaled, not `absolute`: this sits inside a table whose wrapper is `overflow-x-auto`, and
       * per spec a non-visible overflow on one axis forces the other to `auto`, so an absolutely
       * positioned panel is clipped by the scroll box and painted under the table footer — the
       * checkboxes become unclickable. Radix's portal escapes the container.
       */}
      <PopoverContent align="start" className="w-56 p-1">
        <StatusCheckboxes
          statuses={statuses}
          disabled={busy}
          requireOne
          onChange={(next) => void apply(next)}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The status set as checkboxes, shared by the row popover and the dialog.
 *
 * `requireOne` locks the last ticked box for the row editor, which posts on every tick and would
 * otherwise send the empty set the server refuses. The dialog leaves it unlocked and renders that
 * refusal, since a form submission is one deliberate act the operator can correct.
 */
function StatusCheckboxes({
  className = "",
  statuses,
  disabled = false,
  requireOne = false,
  onChange,
}: {
  className?: string;
  statuses: readonly string[];
  disabled?: boolean;
  requireOne?: boolean;
  onChange: (next: ProfileStatus[]) => void;
}) {
  return (
    <div className={className}>
      {PROFILE_STATUSES.map((s) => {
        const checked = statuses.includes(s);
        const locked = requireOne && checked && statuses.length === 1;
        return (
          <label
            key={s}
            title={locked ? "A profile needs at least one status" : undefined}
            className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent"
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled || locked}
              // Filtering the vocabulary instead of splicing keeps the set ordered and deduped the
              // way `parseProfileStatuses` returns it, so the pills never reshuffle on the round trip.
              onChange={() =>
                onChange(
                  PROFILE_STATUSES.filter((v) => (v === s ? !checked : statuses.includes(v))),
                )
              }
              className="size-3.5 accent-primary disabled:opacity-40"
            />
            {INFRA_STATUS_LABEL[s] ?? s}
          </label>
        );
      })}
    </div>
  );
}

interface ProfileForm {
  name: string;
  /** A set — see PROFILE_STATUSES. An empty one is refused by the server, not hidden by the form. */
  statuses: string[];
  geo: string;
  browser: string;
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
    // A new profile is healthy until told otherwise; an edit seeds from the stored set.
    statuses: editing ? [...editing.statuses] : ["active"],
    geo: editing?.geo ?? "",
    browser: editing?.browser ?? "",
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
          {/* Nested <label>s are invalid, so the group is a <div> with its own caption. */}
          <div className="space-y-1">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Status
            </span>
            <StatusCheckboxes
              className="rounded-md border border-border bg-card p-1"
              statuses={form.statuses}
              onChange={(statuses) => setForm({ ...form, statuses })}
            />
          </div>
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
