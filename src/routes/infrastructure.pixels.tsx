import { useMemo, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Check, Copy, Search } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { PagePendingSkeleton } from "@/components/dashboard/TableSkeleton";
import { StatusPill } from "@/components/dashboard/StatusPill";
import { useSort, SortHeader } from "@/components/dashboard/SortableTable";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { LinkChips, type LinkOption } from "@/components/infra/LinkChips";
import { RiskBadge } from "@/components/infra/RiskBadge";
import {
  deleteInfraPixel,
  linkInfraPixelBm,
  listInfraBms,
  listInfraPixels,
  saveInfraPixel,
  setInfraPixelStatus,
  verifyInfraPixel,
} from "@/lib/api/infrastructure";
import { getCurrentUser } from "@/lib/api/auth";
import { isAdmin } from "@/lib/auth/roles";
import { fmtRelTime } from "@/lib/format";
import { pixelRisk, usableBm } from "@/lib/infra-risk";
import { PIXEL_STATUSES, isBmStatus, isPixelStatus, type BmStatus } from "@/lib/infra-status";
import { cn } from "@/lib/utils";
import type { PixelView } from "@/server/fns/infra/pixels";

export const Route = createFileRoute("/infrastructure/pixels")({
  head: () => ({
    meta: [
      { title: "Pixels — MetaConsole" },
      {
        name: "description",
        content: "Pixel registry: root Business Manager, shares and sharing risk.",
      },
    ],
  }),
  loader: async () => {
    const me = await getCurrentUser();
    if (!isAdmin(me?.role)) throw redirect({ to: "/" });
    const [pixels, bms] = await Promise.all([listInfraPixels(), listInfraBms()]);
    return { pixels, bms };
  },
  component: PixelsPage,
  pendingComponent: () => <PagePendingSkeleton rows={10} kpis={0} />,
});

const INPUT =
  "w-full h-9 rounded-md border border-border bg-card px-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring";
const LABEL = "block text-[11px] font-medium text-muted-foreground mb-1";
const ROW_ACTION = "text-[11px] font-medium text-muted-foreground hover:text-foreground";

/**
 * The dialog's whole state, including which mode it is in. `null` means closed, so there is no
 * separate open flag to fall out of sync with the record being edited.
 */
interface PixelForm {
  id: string;
  name: string;
  rootBmId: string;
  status: string;
  notes: string;
  isNew: boolean;
}

function PixelsPage() {
  const { pixels, bms } = Route.useLoaderData();
  const router = useRouter();

  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [msg, setMsg] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [form, setForm] = useState<PixelForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const bmById = useMemo(() => new Map(bms.map((b) => [b.id, b])), [bms]);

  // Built once, then narrowed per row by excluding that pixel's root BM.
  const bmOptions = useMemo<LinkOption[]>(
    () =>
      bms.map((b) => ({
        id: b.id,
        label: b.name,
        unusable: !(isBmStatus(b.status) && usableBm(b.status)),
      })),
    [bms],
  );

  /** Multi-hop: a pixel matches on its own fields, or on the root BM / any share it points at. */
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const bmMatches = (bmId: string) => {
      const bm = bmById.get(bmId);
      if (!bm) return false;
      return bm.name.toLowerCase().includes(needle) || bm.bmId.toLowerCase().includes(needle);
    };
    return pixels.filter((p) => {
      if (statusFilter !== "ALL" && p.status !== statusFilter) return false;
      if (!needle) return true;
      if (
        p.name.toLowerCase().includes(needle) ||
        p.id.toLowerCase().includes(needle) ||
        p.notes?.toLowerCase().includes(needle)
      ) {
        return true;
      }
      return bmMatches(p.rootBmId) || p.sharedBmIds.some(bmMatches);
    });
  }, [pixels, q, statusFilter, bmById]);

  const { sorted, key, dir, toggle } = useSort(
    filtered,
    {
      name: (r) => r.name,
      status: (r) => r.status,
      shares: (r) => r.sharedBmIds.length,
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

  const copyPixelId = async (id: string) => {
    await navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const remove = async (pixel: PixelView) => {
    if (!window.confirm(`Delete pixel "${pixel.name}" (${pixel.id})? This cannot be undone.`)) {
      return;
    }
    await apply(deleteInfraPixel({ data: { id: pixel.id } }));
  };

  const openCreate = () => {
    setFormError(null);
    setForm({
      id: "",
      name: "",
      rootBmId: bms[0]?.id ?? "",
      status: "active",
      notes: "",
      isNew: true,
    });
  };

  const openEdit = (pixel: PixelView) => {
    setFormError(null);
    setForm({
      id: pixel.id,
      name: pixel.name,
      rootBmId: pixel.rootBmId,
      status: pixel.status,
      notes: pixel.notes ?? "",
      isNew: false,
    });
  };

  const submit = async () => {
    if (!form) return;
    const res = await saveInfraPixel({
      data: {
        id: form.id,
        name: form.name,
        rootBmId: form.rootBmId,
        status: form.status,
        notes: form.notes,
        isNew: form.isNew,
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

  const submittable = form != null && !!form.id.trim() && !!form.name.trim() && !!form.rootBmId;

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1600px]">
      <PageHeader
        title="Pixels"
        description="Every pixel's root Business Manager and the BMs it is shared into. A pixel with no share dies with its root BM."
      >
        <button
          onClick={openCreate}
          className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90"
        >
          Add pixel
        </button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search pixels, notes or Business Managers…"
            className="w-full h-9 rounded-md border border-border bg-card pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex rounded-md border border-border bg-card overflow-hidden text-xs">
          {["ALL", ...PIXEL_STATUSES].map((s) => (
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
                <th className="text-left px-3 py-2.5">Pixel ID</th>
                <SortHeader
                  label="Status"
                  sortKey="status"
                  active={key}
                  dir={dir}
                  onSort={toggle}
                />
                <th className="text-left px-3 py-2.5">Root BM</th>
                <SortHeader
                  label="Shared BMs"
                  sortKey="shares"
                  active={key}
                  dir={dir}
                  onSort={toggle}
                />
                <th className="text-left px-3 py-2.5">Risk</th>
                <th className="text-left px-3 py-2.5">Verified</th>
                <th className="text-right px-5 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((r) => {
                const rootBm = bmById.get(r.rootBmId);
                const rootRaw = rootBm?.status;
                const rootStatus: BmStatus = isBmStatus(rootRaw) ? rootRaw : "banned";
                const rootUsable = usableBm(rootStatus);
                return (
                  <tr key={r.id} className="hover:bg-accent/40 transition-colors">
                    <td className="px-5 py-3 font-medium">{r.name}</td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[10px] text-muted-foreground">{r.id}</span>
                        <button
                          type="button"
                          onClick={() => void copyPixelId(r.id)}
                          className="text-muted-foreground hover:text-foreground"
                          aria-label={`Copy pixel ID ${r.id}`}
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
                          onChange={(e) =>
                            void apply(
                              setInfraPixelStatus({
                                data: { id: r.id, status: e.target.value },
                              }),
                            )
                          }
                          className="h-7 rounded-md border border-border bg-card px-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                          aria-label={`Change status of ${r.name}`}
                        >
                          {!isPixelStatus(r.status) && <option value={r.status}>{r.status}</option>}
                          {PIXEL_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <span className={cn("text-xs", !rootUsable && "opacity-60 line-through")}>
                        {rootBm?.name ?? "—"}
                      </span>
                      {!rootUsable && (
                        <span className="ml-1.5 text-[10px] text-destructive">unusable</span>
                      )}
                    </td>
                    <td className="px-3 py-3 min-w-[200px]">
                      <LinkChips
                        linked={r.sharedBmIds}
                        options={bmOptions.filter((o) => o.id !== r.rootBmId)}
                        onChange={async (id, action) => {
                          const res = await linkInfraPixelBm({
                            data: { pixelId: r.id, bmId: id, action },
                          });
                          if (res.ok) await router.invalidate();
                          return res;
                        }}
                        emptyLabel="not shared"
                      />
                    </td>
                    <td className="px-3 py-3">
                      <RiskBadge
                        risk={pixelRisk({
                          status: isPixelStatus(r.status) ? r.status : "restricted",
                          rootBmStatus: rootStatus,
                          shareCount: r.sharedBmIds.length,
                        })}
                      />
                    </td>
                    <td className="px-3 py-3 text-[11px] text-muted-foreground">
                      {r.verifiedAt ? fmtRelTime(r.verifiedAt) : "—"}
                    </td>
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void apply(verifyInfraPixel({ data: { id: r.id } }))}
                          className={ROW_ACTION}
                        >
                          Verify
                        </button>
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
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-sm text-muted-foreground">
                    No pixels match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-3 border-t border-border text-[11px] text-muted-foreground font-mono">
          {sorted.length} of {pixels.length} pixels
        </div>
      </div>

      <Dialog open={form != null} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="max-w-md" aria-describedby={undefined}>
          <DialogTitle className="text-sm font-semibold">
            {form?.isNew ? "Add pixel" : "Edit pixel"}
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
                <label className={LABEL} htmlFor="pixel-id">
                  Pixel ID
                </label>
                <input
                  id="pixel-id"
                  required
                  disabled={!form.isNew}
                  value={form.id}
                  onChange={(e) => setForm({ ...form, id: e.target.value })}
                  placeholder="1234567890123456"
                  className={cn(INPUT, "font-mono disabled:opacity-60")}
                />
                {!form.isNew && (
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    The pixel ID is the record's key and cannot be changed.
                  </p>
                )}
              </div>
              <div>
                <label className={LABEL} htmlFor="pixel-name">
                  Name
                </label>
                <input
                  id="pixel-name"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={INPUT}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="pixel-root-bm">
                  Root BM
                </label>
                <select
                  id="pixel-root-bm"
                  required
                  value={form.rootBmId}
                  onChange={(e) => setForm({ ...form, rootBmId: e.target.value })}
                  className={INPUT}
                >
                  {bms.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                {bms.length === 0 && (
                  <p className="mt-1 text-[10px] text-destructive">
                    Register a Business Manager first — a pixel must have a root BM.
                  </p>
                )}
              </div>
              <div>
                <label className={LABEL} htmlFor="pixel-status">
                  Status
                </label>
                <select
                  id="pixel-status"
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                  className={INPUT}
                >
                  {PIXEL_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL} htmlFor="pixel-notes">
                  Notes
                </label>
                <textarea
                  id="pixel-notes"
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
                  {form.isNew ? "Create" : "Save"}
                </button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
