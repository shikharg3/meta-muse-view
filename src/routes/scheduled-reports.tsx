import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Briefcase,
  CheckCircle2,
  ChevronDown,
  Columns3,
  Download,
  FileText,
  Loader2,
  LogOut,
  Pause,
  Pencil,
  Play,
  Plus,
  Send,
  Trash2,
  XCircle,
} from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { BreakdownPicker } from "@/components/reports/BreakdownPicker";
import { ColumnPickerDialog } from "@/components/reports/ColumnPickerDialog";
import { RangePicker, type RangeValue } from "@/components/reports/RangePicker";
import { TimeIncrementPicker } from "@/components/reports/TimeIncrementPicker";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getReportCatalog } from "@/lib/api/report-catalog";
import {
  deleteReportTemplate,
  deleteScheduledReport,
  getReportScope,
  getScheduledReportsPage,
  previewReportRecipe,
  saveReportTemplate,
  saveScheduledReport,
  sendDraftReport,
  sendScheduledReportNow,
  setScheduledReportActive,
} from "@/lib/api/scheduled-reports";
import { DATE_PRESETS } from "@/lib/date-presets";
import { fmtCurrency } from "@/lib/format";
import { isAdditive, metric } from "@/lib/report-catalog";
import { downloadReportCsv, downloadReportPdf, showCell } from "@/lib/report-export";
import { REPORT_BREAKDOWNS } from "@/lib/report-options";
import {
  CADENCE_DEFAULT_PRESET,
  CADENCES,
  cadenceLabel,
  DEFAULT_RECIPE,
  DEFAULT_SEND_AT,
  defaultIdentityColumns,
  FILENAME_TOKENS,
  IDENTITY_COLUMNS,
  identityColumnsFor,
  isIdentityColumn,
  SPLITTABLE_BREAKDOWNS,
  WEEKDAYS,
  type Cadence,
  type ReportAdjustments,
  type ReportRecipe,
} from "@/lib/scheduled-report";
import { TIME_INCREMENTS, type TimeIncrement } from "@/lib/time-increment";
import { cn } from "@/lib/utils";
import type { ReportPayload } from "@/server/agent/report";
import type { ScheduleView, ScopeView } from "@/server/fns/scheduled-reports";

/**
 * Scheduled reports to Telegram: the Report Builder's controls (client, brands, campaigns, range,
 * columns, breakdown, granularity, markup) plus delivery (chat, cadence, time). Served only on
 * IMPORT_HOSTS (the droplet's bare IP), like the CSV import: `src/server.ts` 404s the path elsewhere,
 * and every server fn re-checks host and admin.
 */
export const Route = createFileRoute("/scheduled-reports")({
  head: () => ({ meta: [{ title: "Scheduled reports — MetaConsole" }] }),
  loader: async () => {
    try {
      return await getScheduledReportsPage();
    } catch {
      // Wrong host or not an admin. Either way the page does not exist for this caller.
      throw notFound();
    }
  },
  component: ScheduledReportsPage,
});

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const hhmm = (h: number, m: number): string =>
  `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const rangeLabel = (r: RangeValue): string =>
  "preset" in r
    ? (DATE_PRESETS.find((p) => p.key === r.preset)?.label ?? r.preset)
    : `${r.since} → ${r.until}`;
const breakdownLabel = (key: string): string =>
  REPORT_BREAKDOWNS.find((b) => b.key === key)?.label ?? key;

const smallButton =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-accent disabled:opacity-50";
const control =
  "w-full h-9 rounded-md border border-border bg-background px-3 text-xs disabled:opacity-50";
/** Rows drawn on screen; the CSV and PDF downloads carry all of them. */
const SCREEN_ROWS = 500;

interface Delivery {
  id: string | null;
  name: string;
  chatId: string;
  cadence: Cadence;
  weekday: number;
  monthDay: number;
  time: string;
  active: boolean;
  /** Blank = the generated name. */
  filename: string;
  /** Append "_modeled" to a modeled report's file name. */
  filenameModeled: boolean;
}

type Msg = { tone: "ok" | "bad"; text: string } | null;

function ScheduledReportsPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const defaultClient = data.clients.find((c) => c.id === "oneagency") ??
    data.clients[0] ?? { id: "", name: "" };
  const blankRecipe: ReportRecipe = { ...DEFAULT_RECIPE, clientId: defaultClient.id };
  const blankDelivery: Delivery = {
    id: null,
    name: "",
    // The chat an existing schedule already uses, or none: guessing a recent chat could send a
    // client's figures to the wrong person.
    chatId: data.schedules[0]?.chatId ?? "",
    cadence: "daily",
    weekday: 1,
    monthDay: 1,
    time: hhmm(DEFAULT_SEND_AT.hour, DEFAULT_SEND_AT.minute),
    active: true,
    filename: "",
    filenameModeled: false,
  };

  const [recipe, setRecipe] = useState<ReportRecipe>(blankRecipe);
  const [delivery, setDelivery] = useState<Delivery>(blankDelivery);
  const [scope, setScope] = useState<ScopeView | null>(null);
  const [availableKeys, setAvailableKeys] = useState<string[] | null>(null);
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  /** The template the builder was loaded from (or last saved as); its name is editable. */
  const [template, setTemplate] = useState<{ id: string | null; name: string }>({
    id: null,
    name: "",
  });
  const patch = (p: Partial<ReportRecipe>) => setRecipe((r) => ({ ...r, ...p }));
  const clientName = data.clients.find((c) => c.id === recipe.clientId)?.name ?? "";

  // Brands and campaigns of the chosen client. Picks that no longer exist are dropped.
  useEffect(() => {
    setScope(null);
    if (!recipe.clientId) return;
    let cancelled = false;
    void getReportScope({ data: { clientId: recipe.clientId } })
      .then((s) => {
        if (cancelled) return;
        setScope(s);
        setRecipe((r) => ({
          ...r,
          brands: r.brands.filter((b) => s.brands.some((x) => x.key === b)),
          campaignIds: r.campaignIds.filter((id) => s.campaigns.some((c) => c.id === id)),
        }));
      })
      .catch(() => !cancelled && setScope({ brands: [], campaigns: [], adSetNames: [] }));
    return () => {
      cancelled = true;
    };
  }, [recipe.clientId]);

  // Which metrics hold data for this client and window: the column picker dims the rest.
  useEffect(() => {
    setAvailableKeys(null);
    if (!recipe.clientId) return;
    let cancelled = false;
    void getReportCatalog({ data: { clientId: recipe.clientId, ...recipe.range } })
      .then((r) => !cancelled && setAvailableKeys(r.keys))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [recipe.clientId, recipe.range]);

  const run = async (key: string, work: () => Promise<string>) => {
    setBusy(key);
    setMsg(null);
    try {
      const text = await work();
      // Reload the list first, so the confirmation never sits beside the old state. `sync` waits for
      // the loader; only this page's loader, because the root's is the dashboard's and costs seconds.
      await router.invalidate({ filter: (m) => m.routeId === Route.id, sync: true });
      setMsg({ tone: "ok", text });
    } catch (e) {
      setMsg({ tone: "bad", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const preview = async () => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      setReport(
        await previewReportRecipe({
          data: {
            recipe,
            filename: delivery.filename.trim() || null,
            filenameModeled: delivery.filenameModeled,
          },
        }),
      );
    } catch (e) {
      setReport(null);
      setPreviewError(errorText(e));
    } finally {
      setPreviewing(false);
    }
  };

  const defaultName = `${clientName}${
    recipe.brands.length && scope
      ? ` › ${recipe.brands.map((b) => scope.brands.find((x) => x.key === b)?.title ?? b).join(", ")}`
      : ""
  } · ${breakdownLabel(recipe.breakdown).toLowerCase()} · ${rangeLabel(recipe.range).toLowerCase()}`;

  const scheduleInput = () => {
    const [hour, minute] = delivery.time.split(":").map(Number);
    return {
      id: delivery.id,
      name: delivery.name.trim() || defaultName,
      recipe,
      chatId: delivery.chatId.trim(),
      cadence: delivery.cadence,
      weekday: delivery.cadence === "weekly" ? delivery.weekday : null,
      monthDay: delivery.cadence === "monthly" ? delivery.monthDay : null,
      hour,
      minute,
      active: delivery.active,
      filename: delivery.filename.trim() || null,
      filenameModeled: delivery.filenameModeled,
    };
  };

  const save = () =>
    run("save", async () => {
      const { id } = await saveScheduledReport({ data: scheduleInput() });
      setDelivery((d) => ({ ...d, id }));
      return delivery.id ? "Schedule updated." : "Schedule created.";
    });

  const sendOnce = () =>
    run("draft", async () => {
      const input = scheduleInput();
      const r = await sendDraftReport({
        data: {
          name: input.name,
          recipe: input.recipe,
          chatId: input.chatId,
          filename: input.filename,
          filenameModeled: input.filenameModeled,
        },
      });
      return `Sent once to Telegram (${r.rows} rows).`;
    });

  const edit = (s: ScheduleView) => {
    setRecipe(s.recipe);
    setDelivery({
      id: s.id,
      name: s.name,
      chatId: s.chatId,
      cadence: (CADENCES.some((c) => c.key === s.cadence) ? s.cadence : "daily") as Cadence,
      weekday: s.weekday ?? 1,
      monthDay: s.monthDay ?? 1,
      time: hhmm(s.hour, s.minute),
      active: s.active,
      filename: s.filename ?? "",
      filenameModeled: s.filenameModeled,
    });
    setReport(null);
    setMsg(null);
    window.scrollTo({
      top: document.getElementById("builder")?.offsetTop ?? 0,
      behavior: "smooth",
    });
  };

  const startNew = () => {
    setRecipe(blankRecipe);
    setDelivery(blankDelivery);
    setTemplate({ id: null, name: "" });
    setReport(null);
    setMsg(null);
  };

  const loadTemplate = (id: string) => {
    const t = data.templates.find((x) => x.id === id);
    if (!t) return;
    setRecipe(t.recipe);
    setTemplate({ id: t.id, name: t.name });
    setReport(null);
  };

  const saveTemplate = (asNew: boolean) =>
    run("template", async () => {
      const name = template.name.trim();
      const { id } = await saveReportTemplate({
        data: { id: asNew ? null : template.id, name, recipe },
      });
      setTemplate({ id, name });
      return asNew || !template.id ? `Template "${name}" saved.` : `Template "${name}" updated.`;
    });

  const removeTemplate = () => {
    if (!template.id || !window.confirm(`Delete the template "${template.name}"?`)) return;
    void run("template", async () => {
      await deleteReportTemplate({ data: { id: template.id! } });
      setTemplate({ id: null, name: "" });
      return "Template deleted.";
    });
  };

  const multiBrand = !!scope && scope.brands.length > 1 && recipe.brands.length !== 1;
  /** A new breakdown gets its own identity columns; the metrics are kept as ordered. */
  const setBreakdown = (breakdown: string) =>
    setRecipe((r) => ({
      ...r,
      breakdown,
      columns: [
        ...defaultIdentityColumns(breakdown, r.timeIncrement, multiBrand),
        ...r.columns.filter((k) => !isIdentityColumn(k)),
      ],
      // A split lives in the Campaign column; a breakdown without one cannot carry it.
      adjustments: SPLITTABLE_BREAKDOWNS.includes(breakdown)
        ? r.adjustments
        : { ...r.adjustments, split: null },
    }));
  /** A time axis brings its Date column; dropping the axis drops it. */
  const setGranularity = (timeIncrement: TimeIncrement) => {
    const rest = recipe.columns.filter((k) => k !== "dim:period");
    patch({
      timeIncrement,
      columns:
        timeIncrement === "all_days"
          ? rest
          : ["dim:period", ...rest.filter((k) => k !== "dim:period")],
    });
  };
  const identityOptions = identityColumnsFor(recipe.breakdown, recipe.timeIncrement).map((key) => ({
    key,
    label:
      key === "dim:value"
        ? breakdownLabel(recipe.breakdown)
            .replace(/^By /, "")
            .replace(/^./, (c) => c.toUpperCase())
        : (IDENTITY_COLUMNS.find((c) => c.key === key)?.label ?? key),
  }));

  const adjust = (a: Partial<ReportAdjustments>) =>
    setRecipe((r) => ({ ...r, adjustments: { ...r.adjustments, ...a } }));
  /**
   * Set the split's percent or campaign name (null = leave as is); 0% removes it. A split is shown
   * under the Campaign column, so the report gets one if it has none.
   */
  const setSplit = (percent: number | null, campaign: string | null) => {
    const cur = recipe.adjustments.split;
    const p = percent ?? cur?.percent ?? 0;
    if (p <= 0) return adjust({ split: null });
    const split = { percent: Math.min(p, 99), campaign: campaign ?? cur?.campaign ?? "" };
    const columns = [...recipe.columns];
    if (!columns.includes("dim:campaign")) {
      const at = columns.findIndex((k) => k !== "dim:period" && k !== "dim:brand");
      columns.splice(at === -1 ? columns.length : at, 0, "dim:campaign");
    }
    setRecipe((r) => ({ ...r, columns, adjustments: { ...r.adjustments, split } }));
  };
  const campaignNameOptions = [
    ...new Set(
      (scope?.campaigns ?? [])
        .filter(
          (c) =>
            recipe.brands.length === 0 || (c.brand !== null && recipe.brands.includes(c.brand)),
        )
        .map((c) => c.name),
    ),
  ];

  return (
    <div className="min-h-screen bg-background">
      <div className="p-6 md:p-8 space-y-6 max-w-screen-2xl mx-auto">
        <PageHeader
          title="Scheduled reports"
          description="Build any report the Report Builder can — client or brands, campaigns, range, columns, breakdown, granularity — and have it sent to Telegram as a CSV on a schedule."
        >
          <a href="/import" className={smallButton}>
            CSV import
          </a>
          <a href="/auth/logout" className={smallButton}>
            <LogOut className="size-3.5" /> Sign out
          </a>
        </PageHeader>

        {!data.botConfigured && (
          <p className="rounded-lg border border-destructive/40 p-3 text-xs text-destructive">
            TELEGRAM_BOT_TOKEN is not set, so nothing can be sent. Set it in the droplet .env and
            restart meta-web and meta-sync.
          </p>
        )}

        <Schedules
          schedules={data.schedules}
          busy={busy}
          onEdit={edit}
          onSend={(s) =>
            void run(`send:${s.id}`, async () => {
              const r = await sendScheduledReportNow({ data: { id: s.id } });
              return `Sent "${s.name}" to ${s.chatLabel} (${r.rows} rows).`;
            })
          }
          onToggle={(s) =>
            void run(`toggle:${s.id}`, async () => {
              await setScheduledReportActive({ data: { id: s.id, active: !s.active } });
              return s.active ? `Paused "${s.name}".` : `Resumed "${s.name}".`;
            })
          }
          onDelete={(s) => {
            if (!window.confirm(`Delete the schedule "${s.name}"?`)) return;
            void run(`delete:${s.id}`, async () => {
              await deleteScheduledReport({ data: { id: s.id } });
              if (delivery.id === s.id) startNew();
              return `Deleted "${s.name}".`;
            });
          }}
        />
        <Message msg={msg} />

        <div id="builder" className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)] items-start">
          <div className="rounded-xl border border-border bg-card p-4 space-y-3.5">
            <div className="flex items-center gap-2">
              <FileText className="size-4 text-primary" />
              <h3 className="text-sm font-semibold flex-1 truncate">
                {delivery.id ? `Editing “${delivery.name}”` : "New report"}
              </h3>
              {delivery.id && (
                <button onClick={startNew} className={smallButton}>
                  <Plus className="size-3.5" /> New
                </button>
              )}
            </div>

            <Field label="Template">
              <select
                value={template.id ?? ""}
                onChange={(e) =>
                  e.target.value
                    ? loadTemplate(e.target.value)
                    : setTemplate({ id: null, name: "" })
                }
                className={control}
              >
                <option value="">
                  {data.templates.length ? "Load a saved template…" : "No templates saved yet"}
                </option>
                {data.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <div className="mt-1.5 flex gap-1.5">
                <input
                  value={template.name}
                  placeholder="Template name"
                  onChange={(e) => setTemplate({ ...template, name: e.target.value })}
                  className={cn(control, "h-8")}
                />
                <button
                  onClick={() => void saveTemplate(false)}
                  disabled={busy !== null || !template.name.trim()}
                  className={smallButton}
                  title={
                    template.id ? "Overwrite the loaded template" : "Save the builder as a template"
                  }
                >
                  {template.id ? "Update" : "Save"}
                </button>
                {template.id && (
                  <>
                    <button
                      onClick={() => void saveTemplate(true)}
                      disabled={busy !== null || !template.name.trim()}
                      className={smallButton}
                    >
                      Save as new
                    </button>
                    <button
                      onClick={removeTemplate}
                      disabled={busy !== null}
                      className={cn(smallButton, "text-destructive hover:bg-destructive/10")}
                      title="Delete template"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </>
                )}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Templates here are this page&apos;s own — separate from the Report Builder&apos;s.
              </p>
            </Field>

            <Field label="Client">
              <ClientPicker
                clients={data.clients}
                value={recipe.clientId}
                onChange={(clientId) => patch({ clientId, brands: [], campaignIds: [] })}
              />
            </Field>

            <Field
              label={`Brands${scope ? ` (${recipe.brands.length || "all"}/${scope.brands.length})` : ""}`}
            >
              {!scope ? (
                <Loading />
              ) : scope.brands.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">This client has no board rows.</p>
              ) : (
                <div className="space-y-1.5">
                  <PickAll
                    onAll={() => patch({ brands: [], campaignIds: [] })}
                    hint="none picked = the whole client"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {scope.brands.map((b) => (
                      <Chip
                        key={b.key}
                        active={recipe.brands.includes(b.key)}
                        onClick={() =>
                          patch({
                            brands: recipe.brands.includes(b.key)
                              ? recipe.brands.filter((x) => x !== b.key)
                              : [...recipe.brands, b.key],
                            campaignIds: [],
                          })
                        }
                        title={`${b.accountCount} ad accounts${b.status ? ` · ${b.status}` : ""}`}
                      >
                        {b.title}
                        {b.status && b.status !== "Live" && (
                          <span className="ml-1 text-[10px] opacity-60">({b.status})</span>
                        )}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}
            </Field>

            {scope && scope.campaigns.length > 0 && (
              <CampaignPicker
                campaigns={scope.campaigns.filter(
                  (c) =>
                    recipe.brands.length === 0 ||
                    (c.brand !== null && recipe.brands.includes(c.brand)),
                )}
                brandTitle={(k) => scope.brands.find((b) => b.key === k)?.title ?? null}
                picked={recipe.campaignIds}
                onChange={(campaignIds) => patch({ campaignIds })}
              />
            )}

            <Field label="Date range">
              <RangePicker value={recipe.range} onChange={(range) => patch({ range })} />
            </Field>

            <Field label="Breakdown">
              <BreakdownPicker breakdown={recipe.breakdown} onBreakdownChange={setBreakdown} />
              {["campaign", "adset", "ad"].includes(recipe.breakdown) && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  One row per {breakdownLabel(recipe.breakdown).replace(/^By /, "").toLowerCase()}{" "}
                  ID. Changing the breakdown resets the report columns (Date, Campaign, …) to its
                  defaults; add Account, IDs or Brand under Columns.
                </p>
              )}
            </Field>

            <ColumnsField
              columns={recipe.columns}
              availableKeys={availableKeys}
              identity={identityOptions}
              labels={recipe.adjustments.columnLabels}
              onLabelsChange={(columnLabels) => adjust({ columnLabels })}
              onChange={(columns) => patch({ columns })}
            />

            <Field label="Granularity">
              <TimeIncrementPicker
                value={recipe.timeIncrement}
                onChange={setGranularity}
                withheld={
                  recipe.timeIncrement === "1"
                    ? []
                    : recipe.columns
                        .filter((k) => metric(k) !== undefined && !isAdditive(k))
                        .map((k) => metric(k)?.label ?? k)
                }
              />
            </Field>

            <Field label="Client markup %">
              <input
                type="number"
                min={0}
                max={500}
                value={recipe.markup ? Math.round(recipe.markup * 100) : ""}
                onChange={(e) => {
                  const pct = Number(e.target.value) || 0;
                  patch({ markup: pct > 0 ? pct / 100 : null });
                }}
                placeholder="0"
                className={control}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Added to spend and every cost metric; delivered figures stay real.
              </p>
            </Field>

            <Field label="Data modeling">
              <label className="flex items-start gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={recipe.modeled}
                  onChange={(e) => patch({ modeled: e.target.checked })}
                />
                <span>Model interrupted days (estimate of uninterrupted delivery)</span>
              </label>
              <p className="mt-1 text-[11px] text-muted-foreground">
                A day with no spend, or under 25% of the median of its active days within ±5 days
                (the previous 7 when nothing later has data, e.g. yesterday), is replaced by the
                mean of those days, ±15% per metric. The title says “modeled” and the note and
                Telegram caption list every modeled day; adding “_modeled” to the file name is an
                option under Delivery. For estimates only — actual figures go out without this.
              </p>
            </Field>

            <Field label="Split into a new campaign">
              {SPLITTABLE_BREAKDOWNS.includes(recipe.breakdown) ? (
                <>
                  <div className="grid grid-cols-[90px_1fr] gap-2">
                    <div className="relative">
                      <input
                        type="number"
                        min={0}
                        max={99}
                        step="any"
                        value={recipe.adjustments.split?.percent ?? ""}
                        placeholder="0"
                        onChange={(e) => setSplit(Number(e.target.value) || 0, null)}
                        className={cn(control, "pr-6")}
                      />
                      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                        %
                      </span>
                    </div>
                    <input
                      value={recipe.adjustments.split?.campaign ?? ""}
                      placeholder="New campaign name"
                      disabled={!recipe.adjustments.split}
                      onChange={(e) => setSplit(null, e.target.value)}
                      className={control}
                    />
                  </div>
                  {recipe.adjustments.split && !recipe.adjustments.split.campaign.trim() && (
                    <p className="mt-1 text-[11px] text-amber-500">
                      Name the campaign the {recipe.adjustments.split.percent}% goes to.
                    </p>
                  )}
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Every row keeps {100 - (recipe.adjustments.split?.percent ?? 0)}% of its figures
                    and a copy with the rest appears under the new campaign (no IDs). Totals do not
                    change; counts stay whole numbers.
                  </p>
                </>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Needs a campaign, ad set or ad breakdown.
                </p>
              )}
            </Field>

            <RenameField
              label="Rename campaigns"
              options={campaignNameOptions}
              value={recipe.adjustments.campaignNames}
              onChange={(campaignNames) => adjust({ campaignNames })}
            />
            <RenameField
              label="Rename ad sets"
              options={scope?.adSetNames ?? []}
              value={recipe.adjustments.adSetNames}
              onChange={(adSetNames) => adjust({ adSetNames })}
            />

            <button
              onClick={() => void preview()}
              disabled={previewing || !recipe.clientId || recipe.columns.length === 0}
              className="w-full h-9 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
            >
              {previewing ? "Generating…" : "Preview report"}
            </button>

            <div className="border-t border-border pt-3.5 space-y-3.5">
              <h4 className="text-xs font-semibold flex items-center gap-1.5">
                <Send className="size-3.5 text-primary" /> Delivery
              </h4>
              <Field label="Schedule name">
                <input
                  value={delivery.name}
                  placeholder={defaultName}
                  onChange={(e) => setDelivery({ ...delivery, name: e.target.value })}
                  className={control}
                />
              </Field>
              <Field label="File name">
                <input
                  value={delivery.filename}
                  placeholder={report?.filename ?? "generated from client, range and breakdown"}
                  onChange={(e) => setDelivery({ ...delivery, filename: e.target.value })}
                  className={cn(control, "font-mono")}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  .csv is added. {FILENAME_TOKENS.join(", ")} become dates, e.g.{" "}
                  <span className="font-mono">OneAgency_adsets_{"{since}"}</span>. Blank =
                  generated.
                </p>
                {recipe.modeled && (
                  <label className="mt-1.5 flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={delivery.filenameModeled}
                      onChange={(e) =>
                        setDelivery({ ...delivery, filenameModeled: e.target.checked })
                      }
                    />
                    Add “_modeled” to the file name
                  </label>
                )}
              </Field>
              <Field label="Telegram chat">
                <select
                  value={
                    data.chats.some((c) => c.chatId === delivery.chatId) ? delivery.chatId : ""
                  }
                  onChange={(e) => setDelivery({ ...delivery, chatId: e.target.value })}
                  className={control}
                >
                  <option value="" disabled>
                    {delivery.chatId
                      ? "Typed chat id (below)"
                      : "Choose a chat, or type an id below…"}
                  </option>
                  {data.chats.map((c) => (
                    <option key={c.chatId} value={c.chatId}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <input
                  value={delivery.chatId}
                  placeholder="chat id, e.g. 347759628"
                  onChange={(e) => setDelivery({ ...delivery, chatId: e.target.value })}
                  className={cn(control, "mt-1.5 font-mono")}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Repeats">
                  <select
                    value={delivery.cadence}
                    onChange={(e) => {
                      const cadence = e.target.value as Cadence;
                      setDelivery({ ...delivery, cadence });
                      // Offer the period that cadence naturally reports, unless dates are pinned.
                      if ("preset" in recipe.range)
                        patch({ range: { preset: CADENCE_DEFAULT_PRESET[cadence] } });
                    }}
                    className={control}
                  >
                    {CADENCES.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="At (Berlin)">
                  <input
                    type="time"
                    value={delivery.time}
                    onChange={(e) => setDelivery({ ...delivery, time: e.target.value })}
                    className={cn(control, "font-mono")}
                  />
                </Field>
                {delivery.cadence === "weekly" && (
                  <Field label="On">
                    <select
                      value={delivery.weekday}
                      onChange={(e) =>
                        setDelivery({ ...delivery, weekday: Number(e.target.value) })
                      }
                      className={control}
                    >
                      {WEEKDAYS.map((d, i) => (
                        <option key={d} value={i + 1}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {delivery.cadence === "monthly" && (
                  <Field label="Day of month">
                    <select
                      value={delivery.monthDay}
                      onChange={(e) =>
                        setDelivery({ ...delivery, monthDay: Number(e.target.value) })
                      }
                      className={control}
                    >
                      {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                The range is resolved on the day it sends. Insight days are each ad account&apos;s
                own calendar day, so before 10:00 Berlin a US account&apos;s yesterday may still be
                open. The chat must have sent <b>/start</b> to the bot, or the bot must be in the
                group.
                {!("preset" in recipe.range) &&
                  " Fixed dates can be sent once but not scheduled — pick a relative range to save."}
              </p>
              <label className="inline-flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={delivery.active}
                  onChange={(e) => setDelivery({ ...delivery, active: e.target.checked })}
                />
                Active
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => void save()}
                  disabled={
                    busy !== null ||
                    !recipe.clientId ||
                    !delivery.chatId.trim() ||
                    !("preset" in recipe.range)
                  }
                  title={
                    !("preset" in recipe.range) ? "Pick a relative range to schedule" : undefined
                  }
                  className="h-9 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
                >
                  {busy === "save" ? "Saving…" : delivery.id ? "Save changes" : "Save schedule"}
                </button>
                <button
                  onClick={() => void sendOnce()}
                  disabled={busy !== null || !recipe.clientId || !delivery.chatId.trim()}
                  className="h-9 rounded-md border border-border text-xs font-medium hover:bg-accent disabled:opacity-50"
                >
                  {busy === "draft" ? "Sending…" : "Send once now"}
                </button>
              </div>
            </div>
          </div>

          <div className="min-w-0">
            {previewing ? (
              <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-12 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Generating report…
              </div>
            ) : previewError ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {previewError}
              </div>
            ) : report ? (
              <ReportView report={report} />
            ) : (
              <div className="rounded-lg border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
                Pick a client and options, then preview — the preview is exactly what the CSV
                carries.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Schedules({
  schedules,
  busy,
  onEdit,
  onSend,
  onToggle,
  onDelete,
}: {
  schedules: ScheduleView[];
  busy: string | null;
  onEdit: (s: ScheduleView) => void;
  onSend: (s: ScheduleView) => void;
  onToggle: (s: ScheduleView) => void;
  onDelete: (s: ScheduleView) => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-3">
      <h3 className="text-sm font-semibold">Schedules</h3>
      {schedules.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No schedules yet — build a report below and save it.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left py-1 pr-3 font-semibold">Name</th>
                <th className="text-left py-1 pr-3 font-semibold">Report</th>
                <th className="text-left py-1 pr-3 font-semibold">Sends</th>
                <th className="text-left py-1 pr-3 font-semibold">Last run</th>
                <th className="text-right py-1 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id} className="border-t border-border align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{s.name}</div>
                    <div className="text-muted-foreground">
                      {s.clientName}
                      {s.recipe.brands.length > 0 &&
                        ` · ${s.recipe.brands.length} brand${s.recipe.brands.length === 1 ? "" : "s"}`}
                      {s.recipe.campaignIds.length > 0 &&
                        ` · ${s.recipe.campaignIds.length} campaigns`}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-muted-foreground">
                    {breakdownLabel(s.recipe.breakdown)} ·{" "}
                    {TIME_INCREMENTS.find((t) => t.key === s.recipe.timeIncrement)?.label} ·{" "}
                    {rangeLabel(s.recipe.range)} · {s.recipe.columns.length} columns
                    {s.recipe.markup ? ` · +${Math.round(s.recipe.markup * 100)}%` : ""}
                    {s.recipe.adjustments.split
                      ? ` · split ${s.recipe.adjustments.split.percent}% → ${s.recipe.adjustments.split.campaign}`
                      : ""}
                    {s.recipe.modeled && (
                      <span className="ml-1 rounded bg-amber-500/15 px-1 text-amber-500">
                        modeled
                      </span>
                    )}
                    {s.filename && <div className="font-mono">{s.filename}.csv</div>}
                    {s.recipe.modeled && s.filenameModeled && (
                      <div className="font-mono">+ _modeled</div>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="font-mono">{cadenceLabel(s)}</div>
                    <div className="text-muted-foreground">{s.chatLabel}</div>
                    {!s.active && <div className="text-amber-500">paused</div>}
                  </td>
                  <td className="py-2 pr-3">
                    <LastRun s={s} />
                  </td>
                  <td className="py-2">
                    <div className="flex justify-end gap-1.5 flex-wrap">
                      <button
                        onClick={() => onSend(s)}
                        disabled={busy !== null}
                        className={smallButton}
                      >
                        <Send className="size-3.5" />
                        {busy === `send:${s.id}` ? "Sending…" : "Send now"}
                      </button>
                      <button
                        onClick={() => onEdit(s)}
                        disabled={busy !== null}
                        className={smallButton}
                      >
                        <Pencil className="size-3.5" /> Edit
                      </button>
                      <button
                        onClick={() => onToggle(s)}
                        disabled={busy !== null}
                        className={smallButton}
                      >
                        {s.active ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                        {s.active ? "Pause" : "Resume"}
                      </button>
                      <button
                        onClick={() => onDelete(s)}
                        disabled={busy !== null}
                        className={cn(smallButton, "text-destructive hover:bg-destructive/10")}
                      >
                        <Trash2 className="size-3.5" /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ClientPicker({
  clients,
  value,
  onChange,
}: {
  clients: { id: string; name: string; accountCount: number }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const name = clients.find((c) => c.id === value)?.name;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="flex w-full items-center gap-2 rounded-md border border-border bg-background hover:bg-accent px-3 h-9 text-xs">
          <Briefcase className="size-3.5 text-muted-foreground" />
          <span className={cn("flex-1 text-left truncate", !name && "text-muted-foreground")}>
            {name ?? "Select a client…"}
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-[--radix-popover-trigger-width] min-w-72">
        <Command>
          <CommandInput placeholder="Search clients…" className="text-xs" />
          <CommandList>
            <CommandEmpty>No clients.</CommandEmpty>
            <CommandGroup>
              {clients.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.name}
                  className="text-xs gap-2"
                  onSelect={() => {
                    onChange(c.id);
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{c.name}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {c.accountCount} acct
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function CampaignPicker({
  campaigns,
  brandTitle,
  picked,
  onChange,
}: {
  campaigns: ScopeView["campaigns"];
  brandTitle: (key: string) => string | null;
  picked: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? campaigns.filter((c) => c.name.toLowerCase().includes(q)) : campaigns;
  }, [campaigns, query]);
  const toggle = (id: string) =>
    onChange(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  return (
    <Field label={`Campaigns (${picked.length || "all"}/${campaigns.length})`}>
      <div className="space-y-1.5">
        <PickAll onAll={() => onChange([])} hint="none picked = every campaign in scope" />
        <input
          value={query}
          placeholder="Search campaigns…"
          onChange={(e) => setQuery(e.target.value)}
          className={cn(control, "h-8")}
        />
        <div className="max-h-48 overflow-auto rounded-md border border-border divide-y divide-border">
          {shown.length === 0 && (
            <p className="px-2 py-1.5 text-[11px] text-muted-foreground">No campaigns match.</p>
          )}
          {shown.map((c) => (
            <label
              key={c.id}
              className="flex items-start gap-2 px-2 py-1.5 text-[11px] cursor-pointer hover:bg-accent/50"
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={picked.includes(c.id)}
                onChange={() => toggle(c.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{c.name}</span>
                <span className="text-muted-foreground">
                  {c.brand ? brandTitle(c.brand) : "no brand (shared account, name unmatched)"} ·{" "}
                  <span className="font-mono">{c.id}</span>
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </Field>
  );
}

function ColumnsField({
  columns,
  availableKeys,
  identity,
  labels,
  onLabelsChange,
  onChange,
}: {
  columns: string[];
  availableKeys: string[] | null;
  /** The identity columns this breakdown and granularity can fill, with their labels. */
  identity: { key: string; label: string }[];
  /** Column key → header the file shows instead of the default. */
  labels: Record<string, string>;
  onLabelsChange: (labels: Record<string, string>) => void;
  onChange: (keys: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const identityLabel = new Map(identity.map((c) => [c.key, c.label]));
  return (
    <Field label="Columns">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-md border border-border bg-background hover:bg-accent px-3 h-9 text-xs"
      >
        <Columns3 className="size-3.5 text-muted-foreground" />
        <span className="flex-1 text-left">
          {columns.length} column{columns.length === 1 ? "" : "s"} selected
        </span>
        <span className="text-muted-foreground">Edit</span>
      </button>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {columns.map((k) => {
          // An identity column the current breakdown cannot fill is kept but left out of the file.
          const unused = isIdentityColumn(k) && !identityLabel.has(k);
          return (
            <span
              key={k}
              title={unused ? "Not available for this breakdown — left out of the file" : undefined}
              className={cn(
                "rounded border border-border px-1.5 py-0.5 text-[10px]",
                isIdentityColumn(k)
                  ? "bg-primary/10 text-primary"
                  : "bg-muted/30 text-muted-foreground",
                unused && "line-through opacity-50",
              )}
            >
              {identityLabel.get(k) ??
                IDENTITY_COLUMNS.find((c) => c.key === k)?.label ??
                metric(k)?.label ??
                k}
            </span>
          );
        })}
      </div>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-[11px] text-muted-foreground">
          Column headers
          {Object.keys(labels).length > 0 && ` (${Object.keys(labels).length} renamed)`}
        </summary>
        <div className="mt-1.5 space-y-1">
          {columns.map((k) => {
            const fallback =
              identityLabel.get(k) ??
              IDENTITY_COLUMNS.find((c) => c.key === k)?.label ??
              metric(k)?.label ??
              k;
            return (
              <div key={k} className="grid grid-cols-[1fr_1fr] items-center gap-1.5">
                <span className="truncate text-[11px] text-muted-foreground">{fallback}</span>
                <input
                  value={labels[k] ?? ""}
                  placeholder={fallback}
                  onChange={(e) => {
                    const rest = Object.fromEntries(
                      Object.entries(labels).filter(([key]) => key !== k),
                    );
                    onLabelsChange(e.target.value ? { ...rest, [k]: e.target.value } : rest);
                  }}
                  className={cn(control, "h-7")}
                />
              </div>
            );
          })}
        </div>
      </details>
      <ColumnPickerDialog
        open={open}
        onOpenChange={setOpen}
        selected={columns}
        onChange={onChange}
        availableKeys={availableKeys}
        extraColumns={{ label: "Report columns", columns: identity }}
      />
    </Field>
  );
}

/** Exact-name renames: "name in the report → name shown", with the client's names to pick from. */
function RenameField({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const listId = useId();
  const entries = Object.entries(value);
  const without = (key: string) => Object.fromEntries(entries.filter(([k]) => k !== key));
  return (
    <Field label={`${label}${entries.length ? ` (${entries.length})` : ""}`}>
      <div className="space-y-1.5">
        {entries.map(([f, t]) => (
          <div key={f} className="grid grid-cols-[1fr_1fr_auto] items-center gap-1.5">
            <span className="truncate text-[11px] text-muted-foreground" title={f}>
              {f}
            </span>
            <input
              value={t}
              onChange={(e) => onChange({ ...value, [f]: e.target.value })}
              className={cn(control, "h-8")}
            />
            <button
              onClick={() => onChange(without(f))}
              className={cn(smallButton, "px-2")}
              title="Remove rename"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
        <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
          <input
            list={listId}
            value={from}
            placeholder="Name in the report"
            onChange={(e) => setFrom(e.target.value)}
            className={cn(control, "h-8")}
          />
          <input
            value={to}
            placeholder="Show as"
            onChange={(e) => setTo(e.target.value)}
            className={cn(control, "h-8")}
          />
          <button
            disabled={!from.trim() || !to.trim()}
            onClick={() => {
              onChange({ ...value, [from.trim()]: to.trim() });
              setFrom("");
              setTo("");
            }}
            className={smallButton}
          >
            Add
          </button>
        </div>
        <datalist id={listId}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
        <p className="text-[11px] text-muted-foreground">
          Matches the exact name and renames it in every row.
        </p>
      </div>
    </Field>
  );
}

/** The preview: sortable, totals pinned, and the same CSV/PDF the Report Builder exports. */
function ReportView({ report }: { report: ReportPayload }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return report.rows;
    const { col, dir } = sort;
    return [...report.rows].sort((a, b) => {
      const x = a[col];
      const y = b[col];
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1; // withheld last
      return (
        (typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y))) * dir
      );
    });
  }, [report.rows, sort]);
  // The downloads follow the on-screen order.
  const doc = { ...report, rows };
  const cycle = (col: number) =>
    setSort((s) =>
      !s || s.col !== col
        ? { col, dir: report.columns[col].kind === "text" ? 1 : -1 }
        : s.dir === (report.columns[col].kind === "text" ? 1 : -1)
          ? { col, dir: s.dir === 1 ? -1 : 1 }
          : null,
    );
  const cell = (v: string | number | null, j: number) =>
    // Cents, as in the CSV: whole dollars hide the CPC differences that matter.
    report.columns[j].kind === "money" && typeof v === "number"
      ? fmtCurrency(v, "USD", 2)
      : showCell(v, report.columns[j].kind);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
        <FileText className="size-4 text-primary shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">{report.title}</div>
          <div className="text-[11px] text-muted-foreground">
            {report.subtitle} · {report.rowCount} rows
            {report.markup ? ` · +${Math.round(report.markup * 100)}% markup (internal)` : ""}
          </div>
        </div>
        <button onClick={() => downloadReportCsv(doc)} className={smallButton}>
          <Download className="size-3.5" /> CSV
        </button>
        <button onClick={() => void downloadReportPdf(doc)} className={smallButton}>
          <Download className="size-3.5" /> PDF
        </button>
      </div>
      {report.note && (
        <div className="px-4 py-2 text-[11px] text-muted-foreground border-b border-border bg-muted/30">
          {report.note}
        </div>
      )}
      {report.rowCount === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          Nothing delivered in this window — a scheduled send says so in a message instead of a
          file.
        </p>
      ) : (
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-card text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                {report.columns.map((c, j) => (
                  <th
                    key={c.key}
                    onClick={() => cycle(j)}
                    className={cn(
                      "py-2 px-2 font-semibold whitespace-nowrap cursor-pointer select-none hover:text-foreground border-b border-border",
                      c.kind === "text" ? "text-left" : "text-right",
                    )}
                  >
                    <span className="inline-flex items-center gap-0.5">
                      {c.label}
                      {sort?.col === j &&
                        (sort.dir === 1 ? (
                          <ArrowUp className="size-3" />
                        ) : (
                          <ArrowDown className="size-3" />
                        ))}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, SCREEN_ROWS).map((r, i) => (
                <tr key={i} className="border-t border-border hover:bg-accent/30">
                  {r.map((v, j) => (
                    <td
                      key={j}
                      className={cn(
                        "py-1.5 px-2 whitespace-nowrap",
                        report.columns[j].kind !== "text" && "text-right font-mono",
                      )}
                    >
                      {cell(v, j)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {report.totals && (
              <tfoot className="sticky bottom-0 bg-card font-semibold">
                <tr className="border-t-2 border-border">
                  {report.totals.map((v, j) => (
                    <td
                      key={j}
                      className={cn(
                        "py-2 px-2 whitespace-nowrap",
                        report.columns[j].kind !== "text" && "text-right font-mono",
                      )}
                    >
                      {cell(v, j)}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
          {rows.length > SCREEN_ROWS && (
            <p className="px-4 py-2 text-[11px] text-muted-foreground">
              Showing {SCREEN_ROWS} of {rows.length} rows — the CSV and PDF carry all of them.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function LastRun({ s }: { s: ScheduleView }) {
  if (!s.runDate) return <span className="text-muted-foreground">never</span>;
  if (s.sentAt)
    return (
      <span className="inline-flex items-center gap-1 text-success">
        <CheckCircle2 className="size-3.5" /> {new Date(s.sentAt).toLocaleString()}
      </span>
    );
  return (
    <span className="inline-flex items-start gap-1 text-destructive">
      <XCircle className="size-3.5 mt-0.5 shrink-0" />
      <span>
        {s.runDate} · failed after {s.attempts} attempt{s.attempts === 1 ? "" : "s"}
        {s.lastError ? `: ${s.lastError}` : ""}
      </span>
    </span>
  );
}

function Message({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return (
    <p
      className={cn(
        "flex items-center gap-1 text-xs",
        msg.tone === "ok" ? "text-success" : "text-destructive",
      )}
    >
      {msg.tone === "ok" ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
      {msg.text}
    </p>
  );
}

function Loading() {
  return (
    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <Loader2 className="size-3 animate-spin" /> Loading…
    </p>
  );
}

function PickAll({ onAll, hint }: { onAll: () => void; hint: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <button type="button" onClick={onAll} className="text-primary hover:underline">
        All
      </button>
      <span className="ml-auto text-muted-foreground">{hint}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="block text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </span>
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "rounded-md border px-2.5 h-7 text-[11px] font-medium transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}
