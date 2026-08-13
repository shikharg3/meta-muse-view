import { useMemo, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Check, Copy, ExternalLink, Pencil, Search, ShieldCheck, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { PagePendingSkeleton } from "@/components/dashboard/TableSkeleton";
import { StatusPill } from "@/components/dashboard/StatusPill";
import { useSort, SortHeader } from "@/components/dashboard/SortableTable";
import { LinkChips, type LinkOption } from "@/components/infra/LinkChips";
import { RiskBadge } from "@/components/infra/RiskBadge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getCurrentUser } from "@/lib/api/auth";
import { isAdmin } from "@/lib/auth/roles";
import {
  deleteInfraPage,
  linkInfraPageBm,
  linkInfraPageProfile,
  listInfraBms,
  listInfraPages,
  listInfraProfiles,
  saveInfraPage,
  setInfraPageStatus,
  verifyInfraPage,
} from "@/lib/api/infrastructure";
import { fmtRelTime } from "@/lib/format";
import { pageRisk, usableBm, usableProfile } from "@/lib/infra-risk";
import { PAGE_STATUSES, isBmStatus, isPageStatus, isProfileStatus } from "@/lib/infra-status";
import { cn } from "@/lib/utils";
import type { PageView } from "@/server/fns/infra/pages";

export const Route = createFileRoute("/infrastructure/pages")({
  head: () => ({ meta: [{ title: "Pages — MetaConsole" }] }),
  loader: async () => {
    const me = await getCurrentUser();
    if (!isAdmin(me?.role)) throw redirect({ to: "/" });
    const [pages, bms, profiles] = await Promise.all([
      listInfraPages(),
      listInfraBms(),
      listInfraProfiles(),
    ]);
    return { pages, bms, profiles };
  },
  component: Pages,
  pendingComponent: () => <PagePendingSkeleton rows={10} kpis={0} />,
});

interface PageForm {
  id: string | null;
  name: string;
  pageUrl: string;
  pageId: string;
  ownerProfileId: string;
  status: string;
  notes: string;
}

const BLANK_FORM: PageForm = {
  id: null,
  name: "",
  pageUrl: "",
  pageId: "",
  ownerProfileId: "",
  status: "active",
  notes: "",
};

const FIELD =
  "mt-1 w-full h-9 rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring";
const LABEL = "text-xs font-medium text-muted-foreground";
const ICON_BUTTON =
  "inline-flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

function Pages() {
  const { pages, bms, profiles } = Route.useLoaderData();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState<PageForm | null>(null);
  const [formMsg, setFormMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const bmById = useMemo(() => new Map(bms.map((b) => [b.id, b])), [bms]);

  const bmOptions: LinkOption[] = useMemo(
    () =>
      bms.map((b) => ({
        id: b.id,
        label: b.name,
        unusable: !(isBmStatus(b.status) && usableBm(b.status)),
      })),
    [bms],
  );

  const profileOptions: LinkOption[] = useMemo(
    () =>
      profiles.map((p) => ({
        id: p.id,
        label: p.name,
        unusable: !(isProfileStatus(p.status) && usableProfile(p.status)),
      })),
    [profiles],
  );

  // The owner of the record being edited stays selectable even when unusable, so a page whose owner
  // got banned can still be repointed instead of becoming uneditable.
  const editingOwnerId = form?.ownerProfileId ?? "";
  const ownerOptions = useMemo(
    () =>
      profiles.filter(
        (p) => (isProfileStatus(p.status) && usableProfile(p.status)) || p.id === editingOwnerId,
      ),
    [profiles, editingOwnerId],
  );

  // Multi-hop: a page matches on its own fields, on its owner or additional profiles, or on any
  // linked BM — searching "Main BM" must surface the pages that BM can administer.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return pages.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (!needle) return true;
      const haystack = [
        r.name,
        r.pageId,
        r.pageUrl,
        r.notes,
        profileById.get(r.ownerProfileId)?.name,
        ...r.profileIds.map((id) => profileById.get(id)?.name),
        ...r.bmIds.flatMap((id) => {
          const bm = bmById.get(id);
          return [bm?.name, bm?.bmId];
        }),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [pages, q, statusFilter, profileById, bmById]);

  const { sorted, key, dir, toggle } = useSort(
    filtered,
    {
      name: (r) => r.name,
      status: (r) => r.status,
      bms: (r) => r.bmIds.length,
    },
    "name",
    "asc",
  );

  const changeStatus = async (row: PageView, status: string) => {
    setMsg(null);
    const res = await setInfraPageStatus({ data: { id: row.id, status } });
    if (!res.ok) setMsg(res.error ?? "Failed to change status");
    else await router.invalidate();
  };

  const verify = async (row: PageView) => {
    setMsg(null);
    const res = await verifyInfraPage({ data: { id: row.id } });
    if (!res.ok) setMsg(res.error ?? "Failed to record verification");
    else await router.invalidate();
  };

  const remove = async (row: PageView) => {
    if (!window.confirm(`Delete "${row.name}"? Its BM and profile links go with it.`)) return;
    setMsg(null);
    const res = await deleteInfraPage({ data: { id: row.id } });
    if (!res.ok) setMsg(res.error ?? "Failed to delete page");
    else await router.invalidate();
  };

  const openEdit = (row: PageView) => {
    setFormMsg(null);
    setForm({
      id: row.id,
      name: row.name,
      pageUrl: row.pageUrl,
      pageId: row.pageId ?? "",
      ownerProfileId: row.ownerProfileId,
      status: row.status,
      notes: row.notes ?? "",
    });
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>, draft: PageForm) => {
    event.preventDefault();
    setSaving(true);
    setFormMsg(null);
    const res = await saveInfraPage({
      data: {
        id: draft.id,
        name: draft.name,
        pageUrl: draft.pageUrl,
        pageId: draft.pageId.trim() || null,
        ownerProfileId: draft.ownerProfileId,
        status: draft.status,
        notes: draft.notes.trim() || null,
      },
    });
    setSaving(false);
    if (!res.ok) {
      setFormMsg(res.error ?? "Failed to save page");
      return;
    }
    setForm(null);
    await router.invalidate();
  };

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1600px]">
      <PageHeader
        title="Pages"
        description="Every registered page, the profile that owns it, and the business managers and profiles holding added access."
      >
        <button
          type="button"
          onClick={() => {
            setFormMsg(null);
            setForm(BLANK_FORM);
          }}
          className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90"
        >
          Add page
        </button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search pages, owners, BMs…"
            className="w-full h-9 rounded-md border border-border bg-card pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 rounded-md border border-border bg-card px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          {PAGE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {msg && <p className="text-xs text-destructive">{msg}</p>}

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
                <SortHeader label="Name" sortKey="name" active={key} dir={dir} onSort={toggle} />
                <th className="text-left px-3 py-2.5">Identifier</th>
                <SortHeader
                  label="Status"
                  sortKey="status"
                  active={key}
                  dir={dir}
                  onSort={toggle}
                />
                <th className="text-left px-3 py-2.5">Owner</th>
                <SortHeader
                  label="Linked BMs"
                  sortKey="bms"
                  active={key}
                  dir={dir}
                  onSort={toggle}
                />
                <th className="text-left px-3 py-2.5">Additional Profiles</th>
                <th className="text-left px-3 py-2.5">Risk</th>
                <th className="text-right px-5 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((r) => {
                const owner = profileById.get(r.ownerProfileId);
                const rawOwnerStatus = owner?.status;
                // A missing or unrecognised owner status is treated as the worst case, never ignored.
                const ownerStatus = isProfileStatus(rawOwnerStatus) ? rawOwnerStatus : "banned";
                const ownerUsable = usableProfile(ownerStatus);
                // Stored as typed; the anchor needs a scheme to leave the app.
                const href = /^https?:\/\//i.test(r.pageUrl) ? r.pageUrl : `https://${r.pageUrl}`;
                return (
                  <tr key={r.id} className="hover:bg-accent/40 transition-colors">
                    <td className="px-5 py-3">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {r.verifiedAt ? `verified ${fmtRelTime(r.verifiedAt)}` : "never verified"}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      {r.pageUrl ? (
                        <div className="flex items-center gap-1.5">
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-primary inline-flex max-w-[220px] items-center gap-1 text-xs"
                          >
                            <span className="truncate">{r.pageUrl}</span>
                            <ExternalLink className="size-3 shrink-0 opacity-60" />
                          </a>
                          <CopyButton value={r.pageUrl} />
                        </div>
                      ) : r.pageId ? (
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {r.pageId}
                          </span>
                          <CopyButton value={r.pageId} />
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <StatusPill status={r.status} />
                        <select
                          value={r.status}
                          onChange={(e) => void changeStatus(r, e.target.value)}
                          className="h-7 rounded-md border border-border bg-background px-1.5 text-[11px]"
                          aria-label={`Change status of ${r.name}`}
                        >
                          {!isPageStatus(r.status) && <option value={r.status}>{r.status}</option>}
                          {PAGE_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="text-xs">{owner?.name ?? "—"}</div>
                      {!ownerUsable && (
                        <div className="text-[11px] text-destructive">no active owner</div>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <LinkChips
                        linked={r.bmIds}
                        options={bmOptions}
                        emptyLabel="no BM access"
                        onChange={async (id, action) => {
                          const res = await linkInfraPageBm({
                            data: { pageId: r.id, bmId: id, action },
                          });
                          if (res.ok) await router.invalidate();
                          return res;
                        }}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <LinkChips
                        linked={r.profileIds}
                        options={profileOptions.filter((p) => p.id !== r.ownerProfileId)}
                        emptyLabel="owner only"
                        onChange={async (id, action) => {
                          const res = await linkInfraPageProfile({
                            data: { pageId: r.id, profileId: id, action },
                          });
                          if (res.ok) await router.invalidate();
                          return res;
                        }}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <RiskBadge
                        risk={pageRisk({
                          status: isPageStatus(r.status) ? r.status : "restricted",
                          ownerStatus,
                          bmCount: r.bmIds.length,
                          profileCount: r.profileIds.length,
                        })}
                      />
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => void verify(r)}
                          className={ICON_BUTTON}
                          title={
                            r.verifiedAt
                              ? `Verified ${fmtRelTime(r.verifiedAt)} — attest again`
                              : "Never verified — attest now"
                          }
                          aria-label={`Verify ${r.name}`}
                        >
                          <ShieldCheck className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => openEdit(r)}
                          className={ICON_BUTTON}
                          title="Edit"
                          aria-label={`Edit ${r.name}`}
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void remove(r)}
                          className={cn(ICON_BUTTON, "hover:text-destructive")}
                          title="Delete"
                          aria-label={`Delete ${r.name}`}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-sm text-muted-foreground">
                    No pages match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-3 border-t border-border text-[11px] text-muted-foreground font-mono">
          {sorted.length} of {pages.length} pages
        </div>
      </div>

      <Dialog
        open={form !== null}
        onOpenChange={(open) => {
          if (!open) setForm(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogTitle>{form?.id ? "Edit page" : "Add page"}</DialogTitle>
          {form && (
            <form onSubmit={(e) => void submit(e, form)} className="space-y-3">
              <label className="block">
                <span className={LABEL}>Name</span>
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={FIELD}
                  placeholder="Acme Store"
                />
              </label>
              <label className="block">
                <span className={LABEL}>Page URL</span>
                <input
                  required
                  value={form.pageUrl}
                  onChange={(e) => setForm({ ...form, pageUrl: e.target.value })}
                  className={FIELD}
                  placeholder="facebook.com/acmestore"
                />
              </label>
              <label className="block">
                <span className={LABEL}>Page ID (optional)</span>
                <input
                  value={form.pageId}
                  onChange={(e) => setForm({ ...form, pageId: e.target.value })}
                  className={cn(FIELD, "font-mono text-xs")}
                  placeholder="1000000000000"
                />
              </label>
              <label className="block">
                <span className={LABEL}>Owner profile</span>
                <select
                  required
                  value={form.ownerProfileId}
                  onChange={(e) => setForm({ ...form, ownerProfileId: e.target.value })}
                  className={FIELD}
                >
                  <option value="">Select a profile…</option>
                  {ownerOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {isProfileStatus(p.status) && usableProfile(p.status)
                        ? p.name
                        : `${p.name} (${p.status})`}
                    </option>
                  ))}
                </select>
              </label>
              {ownerOptions.length === 0 && (
                <p className="text-[11px] text-warning">
                  No usable profile is registered — add an active profile before registering a page.
                </p>
              )}
              <label className="block">
                <span className={LABEL}>Status</span>
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                  className={FIELD}
                >
                  {PAGE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={LABEL}>Notes</span>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={3}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder="Where it lives, who runs it, anything worth remembering."
                />
              </label>
              {formMsg && <p className="text-xs text-destructive">{formMsg}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setForm(null)}
                  className="h-9 px-3 rounded-md border border-border bg-card text-xs font-medium hover:bg-accent"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save page"}
                </button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="text-muted-foreground hover:text-foreground"
      title={copied ? "Copied" : "Copy"}
      aria-label={`Copy ${value}`}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}
