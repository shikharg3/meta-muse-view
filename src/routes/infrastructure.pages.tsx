import { useMemo, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  Check,
  Copy,
  ExternalLink,
  Link2,
  Pencil,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { PagePendingSkeleton } from "@/components/dashboard/TableSkeleton";
import { StatusPill } from "@/components/dashboard/StatusPill";
import { useSort, SortHeader } from "@/components/dashboard/SortableTable";
import { FilterMenu } from "@/components/infra/FilterMenu";
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
import {
  FACET_KEYS,
  FACET_LABEL,
  NO_FACETS,
  decoratePages,
  facetOptions,
  filterByFacets,
  pageUrlExport,
  type Facets,
} from "@/lib/infra-page-filters";
import { RISK_ORDER, usableBm, usableProfile } from "@/lib/infra-risk";
import { INFRA_STATUS_LABEL, PAGE_STATUSES, isBmStatus, isPageStatus } from "@/lib/infra-status";
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
const BAR_BUTTON =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium hover:bg-accent disabled:opacity-40 disabled:hover:bg-background";

function Pages() {
  const { pages, bms, profiles } = Route.useLoaderData();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [facets, setFacets] = useState<Facets>(NO_FACETS);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [urlsOpen, setUrlsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
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
        unusable: !usableProfile(p.statuses),
      })),
    [profiles],
  );

  // The owner of the record being edited stays selectable even when unusable, so a page whose owner
  // got banned can still be repointed instead of becoming uneditable.
  const editingOwnerId = form?.ownerProfileId ?? "";
  const ownerOptions = useMemo(
    () => profiles.filter((p) => usableProfile(p.statuses) || p.id === editingOwnerId),
    [profiles, editingOwnerId],
  );

  // Risk, owner resolution and the outbound href are attached once, here, rather than recomputed in a
  // table cell — that is what lets the Risk facet and the Risk badge be the same value.
  const rows = useMemo(
    () => decoratePages(pages, (id) => profileById.get(id)),
    [pages, profileById],
  );

  // Multi-hop: a page matches on its own fields, on its owner or additional profiles, or on any
  // linked BM — searching "Main BM" must surface the pages that BM can administer.
  const searched = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => {
      const haystack = [
        r.name,
        r.pageId,
        r.pageUrl,
        r.notes,
        r.ownerName,
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
  }, [rows, q, profileById, bmById]);

  const facetNames = useMemo(
    () => ({
      profile: (id: string) => profileById.get(id)?.name,
      bm: (id: string) => bmById.get(id)?.name,
    }),
    [profileById, bmById],
  );

  const options = useMemo(
    () => facetOptions(searched, facets, facetNames),
    [searched, facets, facetNames],
  );
  const filtered = useMemo(() => filterByFacets(searched, facets), [searched, facets]);
  const activeFacets = FACET_KEYS.reduce((n, k) => n + facets[k].length, 0);

  const { sorted, key, dir, toggle } = useSort(
    filtered,
    {
      name: (r) => r.name,
      status: (r) => r.status,
      bms: (r) => r.bmIds.length,
      // Inverted so the first click puts critical on top, where a risk column is worth reading.
      risk: (r) => 3 - RISK_ORDER[r.risk.level],
    },
    "name",
    "asc",
  );

  // Selection is keyed by id and survives filter edits — filter, select, refilter, select more is the
  // reason multi-select exists. Deriving from `rows` also drops ids a delete has since removed, so a
  // stale entry can never inflate the count or the export.
  const selectedRows = useMemo(
    () => rows.filter((r) => selectedIds.has(r.id)),
    [rows, selectedIds],
  );
  const exported = useMemo(() => pageUrlExport(selectedRows), [selectedRows]);
  const allShownSelected = sorted.length > 0 && sorted.every((r) => selectedIds.has(r.id));
  const someShownSelected = !allShownSelected && sorted.some((r) => selectedIds.has(r.id));

  const toggleRow = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  /** Only the rows on screen, never the ones a filter is hiding. */
  const toggleShown = () =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const r of sorted) {
        if (allShownSelected) next.delete(r.id);
        else next.add(r.id);
      }
      return next;
    });

  /**
   * A denied or unavailable clipboard must not fail silently — an operator handing off a URL list
   * would paste whatever was there before. The dialog's textarea is the manual path, so open it.
   */
  const copyUrls = async () => {
    try {
      await navigator.clipboard.writeText(exported.text);
    } catch {
      setUrlsOpen(true);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

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

      <div className="space-y-2">
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
          {FACET_KEYS.map((k) => (
            <FilterMenu
              key={k}
              label={FACET_LABEL[k]}
              options={options[k]}
              selected={facets[k]}
              onChange={(next) => setFacets((f) => ({ ...f, [k]: next }))}
            />
          ))}
        </div>

        {activeFacets > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {FACET_KEYS.flatMap((k) =>
              facets[k].map((value) => (
                <span
                  key={`${k}:${value}`}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px]"
                >
                  <span className="text-muted-foreground">{FACET_LABEL[k]}:</span>
                  {options[k].find((o) => o.value === value)?.label ?? value}
                  <button
                    type="button"
                    onClick={() =>
                      setFacets((f) => ({ ...f, [k]: f[k].filter((v) => v !== value) }))
                    }
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${FACET_LABEL[k]} filter`}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              )),
            )}
            <button
              type="button"
              onClick={() => setFacets(NO_FACETS)}
              className="text-[11px] text-muted-foreground underline hover:text-foreground"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {msg && <p className="text-xs text-destructive">{msg}</p>}

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
                <th className="w-9 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={allShownSelected}
                    disabled={sorted.length === 0}
                    ref={(el) => {
                      if (el) el.indeterminate = someShownSelected;
                    }}
                    onChange={toggleShown}
                    className="size-3.5 accent-primary disabled:opacity-40"
                    aria-label={allShownSelected ? "Deselect shown pages" : "Select shown pages"}
                  />
                </th>
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
                <SortHeader label="Risk" sortKey="risk" active={key} dir={dir} onSort={toggle} />
                <th className="text-right px-5 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((r) => {
                const selected = selectedIds.has(r.id);
                return (
                  <tr
                    key={r.id}
                    className={cn(
                      "transition-colors",
                      selected ? "bg-primary/5" : "hover:bg-accent/40",
                    )}
                  >
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleRow(r.id)}
                        className="size-3.5 accent-primary"
                        aria-label={`Select ${r.name}`}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {r.verifiedAt ? `verified ${fmtRelTime(r.verifiedAt)}` : "never verified"}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      {r.href ? (
                        <div className="flex items-center gap-1.5">
                          <a
                            href={r.href}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-primary inline-flex max-w-[220px] items-center gap-1 text-xs"
                          >
                            <span className="truncate">{r.pageUrl}</span>
                            <ExternalLink className="size-3 shrink-0 opacity-60" />
                          </a>
                          <CopyButton value={r.href} />
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
                      <div className="text-xs">{r.ownerName ?? "—"}</div>
                      {!r.ownerUsable && (
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
                      <RiskBadge risk={r.risk} />
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
                  <td colSpan={9} className="px-5 py-12 text-center text-sm text-muted-foreground">
                    No pages match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-3 border-t border-border text-[11px] text-muted-foreground font-mono">
          {sorted.length} of {pages.length} pages
          {selectedRows.length > 0 && ` · ${selectedRows.length} selected`}
        </div>
      </div>

      {/*
       * `fixed`, not `sticky`: the layout's scroll ancestor is `<main class="flex-1 overflow-x-hidden">`
       * whose `overflow-y` computes to `auto` while its height grows with the content, so it is the
       * sticky scrollport but never actually scrolls — a sticky bar there resolves to its flow
       * position and sits below the fold. Measured: bar top 5862px in a 950px viewport.
       */}
      {selectedRows.length > 0 && (
        <div className="fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 flex-wrap items-center gap-3 rounded-xl border border-border bg-card/95 px-4 py-2.5 shadow-lg backdrop-blur">
          <span className="text-xs font-medium">
            {selectedRows.length} page{selectedRows.length === 1 ? "" : "s"} selected
          </span>
          {exported.missing > 0 && (
            <span className="text-[11px] text-warning">{exported.missing} without a URL</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => void copyUrls()}
              disabled={exported.urls.length === 0}
              className={BAR_BUTTON}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              Copy {exported.urls.length} URL{exported.urls.length === 1 ? "" : "s"}
            </button>
            <button
              type="button"
              onClick={() => setUrlsOpen(true)}
              disabled={exported.urls.length === 0}
              className={BAR_BUTTON}
            >
              <Link2 className="size-3.5" />
              View URLs
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-[11px] text-muted-foreground underline hover:text-foreground"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      <Dialog open={urlsOpen} onOpenChange={setUrlsOpen}>
        <DialogContent className="max-w-lg">
          <DialogTitle>
            {exported.urls.length} page URL{exported.urls.length === 1 ? "" : "s"}
          </DialogTitle>
          <textarea
            readOnly
            value={exported.text}
            rows={Math.min(14, Math.max(3, exported.urls.length))}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {exported.missing > 0 && (
            <p className="text-[11px] text-warning">
              {exported.missing} selected page{exported.missing === 1 ? " has" : "s have"} no URL
              and
              {exported.missing === 1 ? " is" : " are"} not listed.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setUrlsOpen(false)}
              className="h-9 px-3 rounded-md border border-border bg-card text-xs font-medium hover:bg-accent"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => void copyUrls()}
              className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90"
            >
              {copied ? "Copied" : "Copy all"}
            </button>
          </div>
        </DialogContent>
      </Dialog>

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
                      {usableProfile(p.statuses)
                        ? p.name
                        : `${p.name} (${p.statuses.map((s) => INFRA_STATUS_LABEL[s] ?? s).join(", ")})`}
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
