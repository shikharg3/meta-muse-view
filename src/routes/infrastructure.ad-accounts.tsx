import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Check, Copy, Search } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { PagePendingSkeleton } from "@/components/dashboard/TableSkeleton";
import { StatusPill } from "@/components/dashboard/StatusPill";
import { useSort, SortHeader } from "@/components/dashboard/SortableTable";
import { LinkChips, type LinkOption } from "@/components/infra/LinkChips";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  listInfraAdAccounts,
  listInfraBms,
  listUnregisteredAccounts,
  saveInfraAdAccount,
  deleteInfraAdAccount,
  linkInfraAdAccountBm,
} from "@/lib/api/infrastructure";
import { getCurrentUser } from "@/lib/api/auth";
import { isAdmin } from "@/lib/auth/roles";
import { fmtCurrency, disableReasonLabel } from "@/lib/format";
import { usableBm } from "@/lib/infra-risk";
import { AD_ACCOUNT_USAGE, isBmStatus } from "@/lib/infra-status";
import { cn } from "@/lib/utils";
import type { AdAccountView } from "@/server/fns/infra/ad-accounts";

export const Route = createFileRoute("/infrastructure/ad-accounts")({
  head: () => ({
    meta: [
      { title: "Ad Accounts — MetaConsole" },
      {
        name: "description",
        content:
          "Registered ad accounts, their Business Manager access paths and their live synced status.",
      },
    ],
  }),
  loader: async () => {
    const me = await getCurrentUser();
    if (!isAdmin(me?.role)) throw redirect({ to: "/" });
    const [accounts, bms, unregistered] = await Promise.all([
      listInfraAdAccounts(),
      listInfraBms(),
      listUnregisteredAccounts(),
    ]);
    return { accounts, bms, unregistered };
  },
  component: InfraAdAccountsPage,
  pendingComponent: () => <PagePendingSkeleton rows={10} kpis={0} />,
});

/**
 * Meta `account_status` codes → display labels.
 *
 * Local rather than imported: the canonical mapper lives in `@/server/agg`, which is server-only code
 * and must not be pulled into a route bundle. Unknown codes fall through to the raw code so a new one
 * Meta invents shows up as itself instead of silently reading as "paused".
 */
const ACCOUNT_STATUS_LABEL: Record<string, string> = {
  "1": "ACTIVE",
  "2": "DISABLED",
  "3": "UNSETTLED",
  "7": "PENDING_RISK_REVIEW",
  "8": "PENDING_SETTLEMENT",
  "9": "IN_GRACE_PERIOD",
  "100": "PENDING_CLOSURE",
  "101": "CLOSED",
  "201": "ANY_ACTIVE",
  "202": "ANY_CLOSED",
};

const USAGE_FILTERS = ["ALL", ...AD_ACCOUNT_USAGE] as const;

interface FormState {
  /** Id chosen from the unregistered pick list; empty means the operator is typing one. */
  pick: string;
  id: string;
  label: string;
  usageState: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  pick: "",
  id: "",
  label: "",
  usageState: AD_ACCOUNT_USAGE[0],
  notes: "",
};

/**
 * Live status is rendered from the hourly sync and is deliberately read-only — there is no status
 * input anywhere on this page. A hand-typed status would sit next to the synced one and contradict it.
 */
function LiveStatus({ synced }: { synced: AdAccountView["synced"] }) {
  if (synced === null) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground ring-1 ring-border">
        <span className="size-1.5 rounded-full bg-muted-foreground" />
        not in sync
      </span>
    );
  }
  const code = synced.status;
  const reason = disableReasonLabel(synced.disableReason);
  return (
    <div className="space-y-1">
      <StatusPill status={code == null ? "unknown" : (ACCOUNT_STATUS_LABEL[code] ?? code)} />
      {reason && <div className="text-[10px] text-muted-foreground">{reason}</div>}
    </div>
  );
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-[10px] text-muted-foreground">{id}</span>
      <button
        onClick={() => void copy()}
        title="Copy the account ID"
        className="text-muted-foreground hover:text-foreground transition-colors"
      >
        {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
      </button>
    </div>
  );
}

function InfraAdAccountsPage() {
  const { accounts, bms, unregistered } = Route.useLoaderData();
  const router = useRouter();

  const [q, setQ] = useState("");
  const [usage, setUsage] = useState<string>("ALL");
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdAccountView | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  // Lowercased once per render, not once per row×BM, because search hops through BM names.
  const bmNameById = new Map(bms.map((bm) => [bm.id, bm.name.toLowerCase()]));

  const bmOptions: LinkOption[] = bms.map((bm) => ({
    id: bm.id,
    label: bm.name,
    unusable: !(isBmStatus(bm.status) && usableBm(bm.status)),
  }));

  const needle = q.trim().toLowerCase();
  const filtered = accounts.filter((r) => {
    if (usage !== "ALL" && r.usageState !== usage) return false;
    if (!needle) return true;
    // Multi-hop: the account's own fields, or the name of any BM it can be reached through.
    const own = [r.id, r.label, r.notes, r.synced?.name];
    if (own.some((v) => v != null && v.toLowerCase().includes(needle))) return true;
    return r.bmIds.some((id) => bmNameById.get(id)?.includes(needle) ?? false);
  });

  const { sorted, key, dir, toggle } = useSort(
    filtered,
    {
      name: (r) => r.label ?? r.id,
      usage: (r) => r.usageState,
      bms: (r) => r.bmIds.length,
      cap: (r) => r.synced?.spendCap ?? 0,
    },
    "name",
    "asc",
  );

  const settle = async (res: { ok: boolean; error?: string }) => {
    if (!res.ok) setMsg(res.error ?? "Failed");
    else {
      setMsg(null);
      await router.invalidate();
    }
    return res.ok;
  };

  const changeUsage = async (row: AdAccountView, next: string) => {
    await settle(
      await saveInfraAdAccount({
        data: { id: row.id, label: row.label, usageState: next, notes: row.notes },
      }),
    );
  };

  /**
   * `LinkChips` renders the verdict itself, so a refusal is not routed through `settle` — only a
   * successful link needs the loader re-run to pick up the new membership.
   */
  const linkBm = async (adAccountId: string, bmId: string, action: "add" | "remove") => {
    const res = await linkInfraAdAccountBm({ data: { adAccountId, bmId, action } });
    if (res.ok) await router.invalidate();
    return res;
  };

  const remove = async (row: AdAccountView) => {
    const name = row.label ?? row.id;
    if (!window.confirm(`Remove ${name} from the registry? Its BM links go with it.`)) return;
    await settle(await deleteInfraAdAccount({ data: { id: row.id } }));
  };

  const openAdd = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setMsg(null);
    setOpen(true);
  };

  const openEdit = (row: AdAccountView) => {
    setEditing(row);
    setForm({
      pick: "",
      id: row.id,
      label: row.label ?? "",
      usageState: row.usageState,
      notes: row.notes ?? "",
    });
    setMsg(null);
    setOpen(true);
  };

  const submit = async () => {
    const id = editing ? editing.id : form.pick || form.id;
    const ok = await settle(
      await saveInfraAdAccount({
        data: { id, label: form.label, usageState: form.usageState, notes: form.notes },
      }),
    );
    if (ok) setOpen(false);
  };

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1600px]">
      <PageHeader
        title="Ad Accounts"
        description="Operator-owned registry. Live status, spend cap and balance are joined from the hourly sync and cannot be edited here."
      >
        <button
          onClick={openAdd}
          className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90"
        >
          Register account
        </button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search id, label, notes, synced name or BM…"
            className="w-full h-9 rounded-md border border-border bg-card pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex rounded-md border border-border bg-card overflow-hidden text-xs">
          {USAGE_FILTERS.map((u) => (
            <button
              key={u}
              onClick={() => setUsage(u)}
              className={cn(
                "px-3 h-9 font-medium transition-colors uppercase tracking-wider",
                usage === u
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              {u.replace("_", " ")}
            </button>
          ))}
        </div>
      </div>

      {msg && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {msg}
        </div>
      )}

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
                <SortHeader label="Name" sortKey="name" active={key} dir={dir} onSort={toggle} />
                <th className="text-left px-3 py-2.5">Account ID</th>
                <th className="text-left px-3 py-2.5">Live status</th>
                <SortHeader label="Usage" sortKey="usage" active={key} dir={dir} onSort={toggle} />
                <SortHeader label="BMs" sortKey="bms" active={key} dir={dir} onSort={toggle} />
                <SortHeader
                  label="Spend cap"
                  sortKey="cap"
                  active={key}
                  dir={dir}
                  onSort={toggle}
                  align="right"
                  className="px-3"
                />
                <th className="text-right px-3 py-2.5">Balance</th>
                <th className="text-right px-5 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((r) => (
                <tr key={r.id} className="hover:bg-accent/40 transition-colors">
                  <td className="px-5 py-3 font-medium">{r.label ?? r.synced?.name ?? r.id}</td>
                  <td className="px-3 py-3">
                    <CopyId id={r.id} />
                  </td>
                  <td className="px-3 py-3">
                    <LiveStatus synced={r.synced} />
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <StatusPill status={r.usageState} />
                      <select
                        value={r.usageState}
                        onChange={(e) => void changeUsage(r, e.target.value)}
                        className="h-7 rounded-md border border-border bg-card px-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                        aria-label={`Usage for ${r.label ?? r.id}`}
                      >
                        {AD_ACCOUNT_USAGE.map((u) => (
                          <option key={u} value={u}>
                            {u.replace("_", " ")}
                          </option>
                        ))}
                      </select>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <LinkChips
                      linked={r.bmIds}
                      options={bmOptions}
                      emptyLabel="no BM"
                      onChange={(id, action) => linkBm(r.id, id, action)}
                    />
                  </td>
                  <td className="px-3 py-3 text-right font-mono">
                    {r.synced === null
                      ? "—"
                      : r.synced.spendCap
                        ? fmtCurrency(r.synced.spendCap / 100, r.synced.currency)
                        : "None"}
                  </td>
                  <td className="px-3 py-3 text-right font-mono">
                    {r.synced?.balance != null
                      ? fmtCurrency(r.synced.balance / 100, r.synced.currency)
                      : "—"}
                  </td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    <button
                      onClick={() => openEdit(r)}
                      className="text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => void remove(r)}
                      className="ml-3 text-xs font-medium text-destructive hover:opacity-80"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-sm text-muted-foreground">
                    No ad accounts match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-3 border-t border-border text-[11px] text-muted-foreground font-mono">
          {sorted.length} of {accounts.length} ad accounts
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md" aria-describedby={undefined}>
          <DialogTitle>{editing ? "Edit ad account" : "Register ad account"}</DialogTitle>
          <div className="space-y-3">
            {editing === null && (
              <>
                <label className="block space-y-1">
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                    Pick from sync
                  </span>
                  <select
                    value={form.pick}
                    onChange={(e) => setForm({ ...form, pick: e.target.value })}
                    className="w-full h-9 rounded-md border border-border bg-card px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="">— type an ID instead —</option>
                    {unregistered.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.id})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                    Account ID
                  </span>
                  <input
                    value={form.id}
                    onChange={(e) => setForm({ ...form, id: e.target.value })}
                    disabled={form.pick !== ""}
                    placeholder="act_1234567890"
                    className="w-full h-9 rounded-md border border-border bg-card px-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                  />
                  <span className="block text-[10px] text-muted-foreground">
                    For an account not in the synced book yet. It will read “not in sync” until the
                    hourly sync picks it up.
                  </span>
                </label>
              </>
            )}
            {editing && (
              <div className="space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                  Account ID
                </span>
                <div className="font-mono text-xs text-muted-foreground">{editing.id}</div>
              </div>
            )}
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Label
              </span>
              <input
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="Defaults to the synced name"
                className="w-full h-9 rounded-md border border-border bg-card px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Usage
              </span>
              <select
                value={form.usageState}
                onChange={(e) => setForm({ ...form, usageState: e.target.value })}
                className="w-full h-9 rounded-md border border-border bg-card px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {AD_ACCOUNT_USAGE.map((u) => (
                  <option key={u} value={u}>
                    {u.replace("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Notes
              </span>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={3}
                className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </label>
            {msg && <div className="text-xs text-destructive">{msg}</div>}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setOpen(false)}
                className="h-9 px-3 rounded-md border border-border bg-card text-xs font-medium hover:bg-accent"
              >
                Cancel
              </button>
              <button
                onClick={() => void submit()}
                className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90"
              >
                Save
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
