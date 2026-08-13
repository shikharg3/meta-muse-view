import { useMemo, useState } from "react";
import { createFileRoute, redirect, Link, useRouter } from "@tanstack/react-router";
import { Check, Copy, Search } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { PagePendingSkeleton } from "@/components/dashboard/TableSkeleton";
import { StatusPill } from "@/components/dashboard/StatusPill";
import { useSort, SortHeader } from "@/components/dashboard/SortableTable";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { LinkChips, type LinkOption } from "@/components/infra/LinkChips";
import {
  deleteInfraBm,
  getInfraBmBanPreview,
  linkInfraBmAdAccount,
  linkInfraProfileBm,
  listInfraAdAccounts,
  listInfraBms,
  listInfraProfiles,
  saveInfraBm,
  setInfraBmStatus,
  verifyInfraBm,
} from "@/lib/api/infrastructure";
import { getCurrentUser } from "@/lib/api/auth";
import { isAdmin } from "@/lib/auth/roles";
import { fmtRelTime } from "@/lib/format";
import { isVerificationOverdue, usableProfile } from "@/lib/infra-risk";
import { BM_STATUSES, isBmStatus, isProfileStatus } from "@/lib/infra-status";
import { cn } from "@/lib/utils";
import type { BmBanImpact, BmView } from "@/server/fns/infra/bms";

export const Route = createFileRoute("/infrastructure/business-managers/")({
  head: () => ({
    meta: [
      { title: "Business Managers — MetaConsole" },
      {
        name: "description",
        content:
          "Business Manager registry: the profiles that can administer each BM, the ad accounts it holds, and its verification state.",
      },
    ],
  }),
  loader: async () => {
    const me = await getCurrentUser();
    if (!isAdmin(me?.role)) throw redirect({ to: "/" });
    const [bms, profiles, adAccounts] = await Promise.all([
      listInfraBms(),
      listInfraProfiles(),
      listInfraAdAccounts(),
    ]);
    return { bms, profiles, adAccounts };
  },
  component: BusinessManagersPage,
  pendingComponent: () => <PagePendingSkeleton rows={10} kpis={0} />,
});

const INPUT =
  "w-full h-9 rounded-md border border-border bg-card px-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring";
const LABEL = "block text-[11px] font-medium text-muted-foreground mb-1";
const ROW_ACTION = "text-[11px] font-medium text-muted-foreground hover:text-foreground";

/**
 * The dialog's whole state, including which record it edits. `null` means closed, so there is no
 * separate open flag to fall out of sync; `id: null` is a create.
 */
interface BmForm {
  id: string | null;
  name: string;
  bmId: string;
  status: string;
  notes: string;
}

/**
 * A ban is the one status change that is not fire-and-forget.
 *
 * The impact is fetched BEFORE anything is written, so the operator sees which access paths the ban
 * costs while the `<select>` still shows the old value — cancelling therefore needs no undo. The
 * counts are reported as paths lost, never as accounts "needing reassignment": access is a flat list
 * here, so there is no primary BM to re-point.
 */
interface BanPrompt {
  bm: BmView;
  impact: BmBanImpact;
}

function BusinessManagersPage() {
  const { bms, profiles, adAccounts } = Route.useLoaderData();
  const router = useRouter();

  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [msg, setMsg] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [form, setForm] = useState<BmForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [ban, setBan] = useState<BanPrompt | null>(null);
  const [banReason, setBanReason] = useState("");
  const [banError, setBanError] = useState<string | null>(null);
  const [banBusy, setBanBusy] = useState(false);

  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const accountById = useMemo(() => new Map(adAccounts.map((a) => [a.id, a])), [adAccounts]);

  const profileOptions = useMemo<LinkOption[]>(
    () =>
      profiles.map((p) => ({
        id: p.id,
        label: p.name,
        unusable: !(isProfileStatus(p.status) && usableProfile(p.status)),
      })),
    [profiles],
  );

  const accountOptions = useMemo<LinkOption[]>(
    () => adAccounts.map((a) => ({ id: a.id, label: a.label ?? a.id })),
    [adAccounts],
  );

  /** Multi-hop: a BM matches on its own fields, or on any profile / ad account linked to it. */
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return bms.filter((b) => {
      if (statusFilter !== "ALL" && b.status !== statusFilter) return false;
      if (!needle) return true;
      if (
        b.name.toLowerCase().includes(needle) ||
        b.bmId.toLowerCase().includes(needle) ||
        b.notes?.toLowerCase().includes(needle)
      ) {
        return true;
      }
      const profileMatch = b.profileIds.some((id) =>
        profileById.get(id)?.name.toLowerCase().includes(needle),
      );
      if (profileMatch) return true;
      return b.adAccountIds.some((id) => {
        const account = accountById.get(id);
        if (!account) return false;
        return (
          account.id.toLowerCase().includes(needle) ||
          account.label?.toLowerCase().includes(needle) ||
          account.synced?.name.toLowerCase().includes(needle)
        );
      });
    });
  }, [bms, q, statusFilter, profileById, accountById]);

  const { sorted, key, dir, toggle } = useSort(
    filtered,
    {
      name: (r) => r.name,
      status: (r) => r.status,
      profiles: (r) => r.profileIds.length,
      accounts: (r) => r.adAccountIds.length,
      verified: (r) => r.verifiedAt ?? "",
    },
    "name",
    "asc",
  );

  const apply = async (action: Promise<{ ok: boolean; error?: string }>) => {
    const res = await action;
    if (!res.ok) setMsg(res.error ?? "Failed");
    else {
      setMsg(null);
      await router.invalidate();
    }
  };

  const copyBmId = async (bm: BmView) => {
    await navigator.clipboard.writeText(bm.bmId);
    setCopiedId(bm.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const changeStatus = async (bm: BmView, next: string) => {
    if (next === bm.status) return;
    if (next === "banned") {
      const impact = await getInfraBmBanPreview({ data: { id: bm.id } });
      setBanReason("");
      setBanError(null);
      setBan({ bm, impact });
      return;
    }
    await apply(setInfraBmStatus({ data: { id: bm.id, status: next } }));
  };

  const confirmBan = async () => {
    if (!ban) return;
    setBanBusy(true);
    const res = await setInfraBmStatus({
      data: { id: ban.bm.id, status: "banned", reason: banReason },
    });
    setBanBusy(false);
    if (!res.ok) {
      setBanError(res.error ?? "Failed");
      return;
    }
    setBan(null);
    setMsg(null);
    await router.invalidate();
  };

  const remove = async (bm: BmView) => {
    if (!window.confirm(`Delete "${bm.name}" (BM ${bm.bmId})? This cannot be undone.`)) return;
    await apply(deleteInfraBm({ data: { id: bm.id } }));
  };

  const openCreate = () => {
    setFormError(null);
    setForm({ id: null, name: "", bmId: "", status: "pending_verification", notes: "" });
  };

  const openEdit = (bm: BmView) => {
    setFormError(null);
    setForm({ id: bm.id, name: bm.name, bmId: bm.bmId, status: bm.status, notes: bm.notes ?? "" });
  };

  const submit = async () => {
    if (!form) return;
    const res = await saveInfraBm({
      data: {
        id: form.id,
        name: form.name,
        bmId: form.bmId,
        status: form.status,
        notes: form.notes,
      },
    });
    if (!res.ok) {
      setFormError(res.error ?? "Failed");
      return;
    }
    setForm(null);
    setFormError(null);
    await router.invalidate();
  };

  const submittable = form != null && !!form.name.trim() && !!form.bmId.trim();

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1600px]">
      <PageHeader
        title="Business Managers"
        description="Each BM's admin profiles and ad accounts. Two usable profiles means one ban cannot lock you out."
      >
        <button
          onClick={openCreate}
          className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90"
        >
          Add Business Manager
        </button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search BMs, notes, profiles or ad accounts…"
            className="w-full h-9 rounded-md border border-border bg-card pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex rounded-md border border-border bg-card overflow-hidden text-xs">
          {["ALL", ...BM_STATUSES].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                "px-3 h-9 font-medium transition-colors uppercase tracking-wider text-[10px]",
                statusFilter === s
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {msg && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {msg}
        </p>
      )}

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
                <SortHeader label="Name" sortKey="name" active={key} dir={dir} onSort={toggle} />
                <th className="text-left px-3 py-2.5">BM ID</th>
                <SortHeader
                  label="Status"
                  sortKey="status"
                  active={key}
                  dir={dir}
                  onSort={toggle}
                />
                <SortHeader
                  label="Profiles"
                  sortKey="profiles"
                  active={key}
                  dir={dir}
                  onSort={toggle}
                />
                <SortHeader
                  label="Ad Accounts"
                  sortKey="accounts"
                  active={key}
                  dir={dir}
                  onSort={toggle}
                />
                <SortHeader
                  label="Last verified"
                  sortKey="verified"
                  active={key}
                  dir={dir}
                  onSort={toggle}
                />
                <th className="text-right px-5 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((r) => (
                <tr key={r.id} className="hover:bg-accent/40 transition-colors">
                  <td className="px-5 py-3 font-medium">
                    <Link
                      to="/infrastructure/business-managers/$id"
                      params={{ id: r.id }}
                      className="hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[10px] text-muted-foreground">{r.bmId}</span>
                      <button
                        type="button"
                        onClick={() => void copyBmId(r)}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`Copy BM ID ${r.bmId}`}
                      >
                        {copiedId === r.id ? (
                          <Check className="size-3 text-success" />
                        ) : (
                          <Copy className="size-3" />
                        )}
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <StatusPill status={r.status} />
                      <select
                        value={r.status}
                        onChange={(e) => void changeStatus(r, e.target.value)}
                        className="h-7 rounded-md border border-border bg-card px-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                        aria-label={`Change status of ${r.name}`}
                      >
                        {!isBmStatus(r.status) && <option value={r.status}>{r.status}</option>}
                        {BM_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                  </td>
                  <td className="px-3 py-3 min-w-[200px]">
                    <LinkChips
                      linked={r.profileIds}
                      options={profileOptions}
                      onChange={async (id, action) => {
                        const res = await linkInfraProfileBm({
                          data: { profileId: id, bmId: r.id, action },
                        });
                        if (res.ok) await router.invalidate();
                        return res;
                      }}
                      emptyLabel="no profiles"
                    />
                  </td>
                  <td className="px-3 py-3 min-w-[200px]">
                    <LinkChips
                      linked={r.adAccountIds}
                      options={accountOptions}
                      onChange={async (id, action) => {
                        const res = await linkInfraBmAdAccount({
                          data: { bmId: r.id, adAccountId: id, action },
                        });
                        if (res.ok) await router.invalidate();
                        return res;
                      }}
                      emptyLabel="no accounts"
                    />
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap">
                    <span className="text-[11px] text-muted-foreground">
                      {r.verifiedAt ? fmtRelTime(r.verifiedAt) : "—"}
                    </span>
                    {isVerificationOverdue(
                      r.verifiedAt ? new Date(r.verifiedAt) : null,
                      new Date(),
                    ) && <span className="ml-1.5 text-[10px] text-warning">overdue</span>}
                  </td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-2">
                      {r.status !== "banned" && (
                        <button
                          type="button"
                          onClick={() => void apply(verifyInfraBm({ data: { id: r.id } }))}
                          className={ROW_ACTION}
                        >
                          Verify
                        </button>
                      )}
                      <button type="button" onClick={() => openEdit(r)} className={ROW_ACTION}>
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(r)}
                        className="text-[11px] font-medium text-muted-foreground hover:text-destructive"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-sm text-muted-foreground">
                    No Business Managers match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-3 border-t border-border text-[11px] text-muted-foreground font-mono">
          {sorted.length} of {bms.length} Business Managers
        </div>
      </div>

      <Dialog open={ban != null} onOpenChange={(o) => !o && setBan(null)}>
        <DialogContent className="max-w-md" aria-describedby={undefined}>
          <DialogTitle className="text-sm font-semibold">
            Ban {ban?.bm.name ?? "Business Manager"}?
          </DialogTitle>
          {ban && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void confirmBan();
              }}
            >
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {ban.impact.accountsLosingAPath} ad account(s) lose an access path;{" "}
                {ban.impact.accountsLeftWithNone} would be left with none. {ban.impact.profiles}{" "}
                profile(s) are assigned.
              </p>
              <div>
                <label className={LABEL} htmlFor="ban-reason">
                  Reason <span className="text-destructive">*</span>
                </label>
                <input
                  id="ban-reason"
                  required
                  value={banReason}
                  onChange={(e) => setBanReason(e.target.value)}
                  placeholder="What was the ban notice?"
                  className={INPUT}
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Recorded in this BM's history alongside the status change.
                </p>
              </div>
              {banError && <p className="text-[11px] text-destructive">{banError}</p>}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setBan(null)}
                  className="h-9 px-3 rounded-md border border-border bg-card text-xs font-medium hover:bg-accent"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={banBusy || !banReason.trim()}
                  className="h-9 px-3 rounded-md bg-destructive text-destructive-foreground text-xs font-medium hover:bg-destructive/90 disabled:opacity-50"
                >
                  {banBusy ? "Banning…" : "Ban Business Manager"}
                </button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={form != null} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="max-w-md" aria-describedby={undefined}>
          <DialogTitle className="text-sm font-semibold">
            {form?.id ? "Edit Business Manager" : "Add Business Manager"}
          </DialogTitle>
          {form && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <div>
                <label className={LABEL} htmlFor="bm-name">
                  Name
                </label>
                <input
                  id="bm-name"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={INPUT}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="bm-id">
                  BM ID
                </label>
                <input
                  id="bm-id"
                  required
                  value={form.bmId}
                  onChange={(e) => setForm({ ...form, bmId: e.target.value })}
                  placeholder="1234567890123456"
                  className={cn(INPUT, "font-mono")}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="bm-status">
                  Status
                </label>
                <select
                  id="bm-status"
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                  className={INPUT}
                >
                  {BM_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL} htmlFor="bm-notes">
                  Notes
                </label>
                <textarea
                  id="bm-notes"
                  rows={3}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full rounded-md border border-border bg-card px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              {formError && <p className="text-[11px] text-destructive">{formError}</p>}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setForm(null)}
                  className="h-9 px-3 rounded-md border border-border bg-card text-xs font-medium hover:bg-accent"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!submittable}
                  className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {form.id ? "Save" : "Create"}
                </button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
