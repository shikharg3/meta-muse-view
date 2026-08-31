/**
 * Saved report recipes.
 *
 * A template is a recipe, not a report: columns, breakdown, range preset and markup — optionally
 * bound to one client. Nothing here runs anything; the Run action hands the id to /reports/new,
 * which is the only place a window is chosen and the engine is called.
 */
import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Columns3, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { BreakdownPicker } from "@/components/reports/BreakdownPicker";
import { ColumnPickerDialog } from "@/components/reports/ColumnPickerDialog";
import { TimeIncrementPicker } from "@/components/reports/TimeIncrementPicker";
import { DEFAULT_TIME_INCREMENT, TIME_INCREMENTS, type TimeIncrement } from "@/lib/time-increment";
import { listClients } from "@/lib/api/clients";
import { deleteReportTemplate, listReportTemplates, saveReportTemplate } from "@/lib/api/reports";
import { DATE_PRESETS } from "@/lib/date-presets";
import { fmtRelTime } from "@/lib/format";
import { DEFAULT_REPORT_COLUMN_KEYS, REPORT_BREAKDOWNS } from "@/lib/report-options";
import type { TemplateView } from "@/server/fns/reports";

export const Route = createFileRoute("/reports/templates")({
  loader: async () => {
    const [templates, clients] = await Promise.all([listReportTemplates(), listClients()]);
    // Removed clients are retained for history but must never be offered as a new binding.
    return { templates, clients: clients.filter((c) => c.removedAt == null) };
  },
  component: Templates,
});

interface TemplateForm {
  id: string | null;
  name: string;
  clientId: string;
  columns: string[];
  breakdown: string;
  timeIncrement: TimeIncrement;
  /** Percent, as typed. Stored as a fraction — see `submit`. String so the field can be empty. */
  markupPct: string;
  rangePreset: string;
  /**
   * Carried, never edited. This form offers no campaign control, but `saveTemplate` overwrites the
   * column from whatever it receives, so omitting the field would wipe a saved filter on every edit.
   */
  campaignIds: string[] | null;
  /** Which client `campaignIds` were saved against — campaign ids are client-scoped. */
  campaignClientId: string | null;
}

const BLANK_FORM: TemplateForm = {
  id: null,
  name: "",
  clientId: "",
  columns: DEFAULT_REPORT_COLUMN_KEYS,
  breakdown: "none",
  timeIncrement: DEFAULT_TIME_INCREMENT,
  markupPct: "",
  rangePreset: "",
  campaignIds: null,
  campaignClientId: null,
};

const FIELD =
  "mt-1 w-full h-9 rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring";
const LABEL = "text-xs font-medium text-muted-foreground";
const ICON_BUTTON =
  "inline-flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

const breakdownLabel = (key: string): string =>
  REPORT_BREAKDOWNS.find((b) => b.key === key)?.label ?? key;

function Templates() {
  const { templates, clients } = Route.useLoaderData();
  const router = useRouter();
  const [form, setForm] = useState<TemplateForm | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  /** Row awaiting a second click; its Delete button reads "Confirm?" until then. */
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const openCreate = () => {
    setFormError(null);
    setForm({ ...BLANK_FORM, columns: [...DEFAULT_REPORT_COLUMN_KEYS] });
  };

  const openEdit = (t: TemplateView) => {
    setFormError(null);
    setForm({
      id: t.id,
      name: t.name,
      clientId: t.clientId ?? "",
      columns: t.columns,
      breakdown: t.breakdown,
      timeIncrement: t.timeIncrement,
      markupPct: t.markup === null ? "" : String(Math.round(t.markup * 100)),
      rangePreset: t.rangePreset ?? "",
      campaignIds: t.campaignIds,
      campaignClientId: t.clientId,
    });
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>, draft: TemplateForm) => {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    const pct = Number(draft.markupPct);
    // Only while the binding is untouched: ids from the previously bound client would filter a
    // different account's campaigns, and the server rejects them outright on a generic template.
    const keepCampaigns = draft.clientId !== "" && draft.clientId === draft.campaignClientId;
    const res = await saveReportTemplate({
      data: {
        id: draft.id,
        name: draft.name,
        clientId: draft.clientId || null,
        columns: draft.columns,
        breakdown: draft.breakdown,
        timeIncrement: draft.timeIncrement,
        markup: pct ? pct / 100 : null,
        rangePreset: draft.rangePreset || null,
        campaignIds: keepCampaigns ? draft.campaignIds : null,
      },
    });
    setSaving(false);
    if (!res.ok) {
      setFormError(res.error ?? "Failed to save template");
      return;
    }
    setForm(null);
    await router.invalidate();
  };

  const remove = async (id: string) => {
    setListError(null);
    setConfirmId(null);
    const res = await deleteReportTemplate({ data: { id } });
    if (!res.ok) {
      setListError(res.error ?? "Failed to delete template");
      return;
    }
    await router.invalidate();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {templates.length} saved {templates.length === 1 ? "template" : "templates"}
        </p>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="size-3.5" /> New template
        </button>
      </div>

      {form && (
        <form
          onSubmit={(e) => void submit(e, form)}
          className="space-y-4 rounded-xl border border-border bg-card p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">{form.id ? "Edit template" : "New template"}</h2>
            <button
              type="button"
              onClick={() => setForm(null)}
              className={ICON_BUTTON}
              aria-label="Close form"
            >
              <X className="size-3.5" />
            </button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor="tpl-name">
                Name
              </label>
              <input
                id="tpl-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Weekly performance"
                className={FIELD}
              />
            </div>

            <div>
              <label className={LABEL} htmlFor="tpl-client">
                Client
              </label>
              <select
                id="tpl-client"
                value={form.clientId}
                onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                className={FIELD}
              >
                <option value="">Generic — choose a client each run</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Campaign filters are not saved here. Campaign ids belong to a single client, so only
                a client-bound template can carry them — narrow campaigns at run time instead.
              </p>
            </div>

            <div>
              <span className={LABEL}>Columns</span>
              <button
                type="button"
                onClick={() => setColumnsOpen(true)}
                className="mt-1 flex h-9 w-full items-center gap-2 rounded-md border border-border bg-background px-3 text-xs transition-colors hover:bg-accent"
              >
                <Columns3 className="size-3.5 text-muted-foreground" />
                <span className="flex-1 text-left">
                  {form.columns.length} column{form.columns.length === 1 ? "" : "s"} selected
                </span>
                <span className="text-muted-foreground">Edit</span>
              </button>
              {/* availableKeys=null: which metrics hold data depends on a client and a date window,
                  and a template is bound to neither — so availability is unknowable here. */}
              <ColumnPickerDialog
                open={columnsOpen}
                onOpenChange={setColumnsOpen}
                selected={form.columns}
                onChange={(keys) => setForm({ ...form, columns: keys })}
                availableKeys={null}
              />
            </div>

            <div>
              <span className={LABEL}>Breakdown</span>
              <div className="mt-1">
                <BreakdownPicker
                  breakdown={form.breakdown}
                  onBreakdownChange={(key) => setForm({ ...form, breakdown: key })}
                />
              </div>
            </div>

            <div>
              <span className={LABEL}>Granularity</span>
              <div className="mt-1">
                {/* No `withheld` warning here: a template carries no client or range, so which
                    metrics have data — and how many accounts a run will span — is unknowable until
                    the run itself. The builder warns at that point. */}
                <TimeIncrementPicker
                  value={form.timeIncrement}
                  onChange={(v) => setForm({ ...form, timeIncrement: v })}
                  withheld={[]}
                />
              </div>
            </div>

            <div>
              <label className={LABEL} htmlFor="tpl-preset">
                Range preset
              </label>
              <select
                id="tpl-preset"
                value={form.rangePreset}
                onChange={(e) => setForm({ ...form, rangePreset: e.target.value })}
                className={FIELD}
              >
                <option value="">Ask each run</option>
                {DATE_PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={LABEL} htmlFor="tpl-markup">
                Client markup %
              </label>
              <input
                id="tpl-markup"
                type="number"
                min={0}
                max={100}
                value={form.markupPct}
                onChange={(e) => setForm({ ...form, markupPct: e.target.value })}
                placeholder="0"
                className={FIELD}
              />
            </div>
          </div>

          {formError && <p className="text-xs text-destructive">{formError}</p>}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={saving}
              className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              {saving ? "Saving…" : form.id ? "Save changes" : "Create template"}
            </button>
            <button
              type="button"
              onClick={() => setForm(null)}
              className="h-9 rounded-md border border-border px-3 text-xs font-medium hover:bg-accent"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {listError && <p className="text-xs text-destructive">{listError}</p>}

      {templates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-12 text-center">
          <p className="mx-auto max-w-lg text-xs text-muted-foreground">
            A template saves a recipe — the columns, their order, the breakdown, the date range and
            the client markup — so a recurring report is one click instead of a rebuild. Leave the
            client empty and the recipe stays generic, reusable for whichever client you pick at run
            time; bind a client to pin it to one account.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/30 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2.5 text-left">Name</th>
                  <th className="px-3 py-2.5 text-left">Client</th>
                  <th className="px-3 py-2.5 text-right">Columns</th>
                  <th className="px-3 py-2.5 text-left">Breakdown</th>
                  <th className="px-3 py-2.5 text-left">Range</th>
                  <th className="px-3 py-2.5 text-left">Updated</th>
                  <th className="px-5 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {templates.map((t) => (
                  <tr key={t.id} className="transition-colors hover:bg-muted/20">
                    <td className="px-3 py-3">
                      <div className="font-medium">{t.name}</div>
                      {t.campaignIds !== null && (
                        <div className="text-[11px] text-muted-foreground">
                          {t.campaignIds.length} campaign
                          {t.campaignIds.length === 1 ? "" : "s"} filtered
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {t.clientName ?? (
                        <span className="text-muted-foreground">Generic — pick at run time</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{t.columns.length}</td>
                    <td className="px-3 py-3">
                      <div className="text-xs">{breakdownLabel(t.breakdown)}</div>
                      {t.timeIncrement !== DEFAULT_TIME_INCREMENT && (
                        <div className="text-[11px] text-muted-foreground">
                          {TIME_INCREMENTS.find((i) => i.key === t.timeIncrement)?.label ??
                            t.timeIncrement}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs">
                      {t.rangePreset === null ? (
                        <span className="text-muted-foreground">Ask each run</span>
                      ) : (
                        (DATE_PRESETS.find((p) => p.key === t.rangePreset)?.label ?? t.rangePreset)
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      {fmtRelTime(t.updatedAt)}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          to="/reports/new"
                          search={{ template: t.id }}
                          className={ICON_BUTTON}
                          title="Run this template"
                          aria-label={`Run ${t.name}`}
                        >
                          <Play className="size-3.5" />
                        </Link>
                        <button
                          type="button"
                          onClick={() => openEdit(t)}
                          className={ICON_BUTTON}
                          title="Edit"
                          aria-label={`Edit ${t.name}`}
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        {confirmId === t.id ? (
                          <button
                            type="button"
                            onClick={() => void remove(t.id)}
                            className="inline-flex h-7 items-center rounded-md border border-destructive/40 bg-destructive/10 px-2 text-[11px] font-medium text-destructive"
                          >
                            Confirm?
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmId(t.id)}
                            className={ICON_BUTTON}
                            title="Delete"
                            aria-label={`Delete ${t.name}`}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
