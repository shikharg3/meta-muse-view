import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  CheckCircle2,
  Download,
  LogOut,
  Pause,
  Pencil,
  Play,
  Send,
  Trash2,
  XCircle,
} from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { ADSET_REPORT_DEFAULT_AT } from "@/lib/adset-report";
import {
  deleteAdsetSchedule,
  getAdsetReportsPage,
  previewAdsetReport,
  saveAdsetSchedule,
  sendAdsetScheduleNow,
} from "@/lib/api/adset-reports";
import { fmtCurrency } from "@/lib/format";
import { downloadReportCsv, showCell, type ReportDoc } from "@/lib/report-export";
import type { AdsetScheduleView } from "@/server/fns/adset-reports";

/**
 * Daily ad-set CSV reports to Telegram. Served only on IMPORT_HOSTS (the droplet's bare IP), like the
 * CSV import: `src/server.ts` 404s the path elsewhere, and every server fn re-checks host and admin.
 */
export const Route = createFileRoute("/adset-reports")({
  head: () => ({ meta: [{ title: "Ad-set reports — MetaConsole" }] }),
  loader: async () => {
    try {
      return await getAdsetReportsPage();
    } catch {
      // Wrong host or not an admin. Either way the page does not exist for this caller.
      throw notFound();
    }
  },
  component: AdsetReportsPage,
});

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const hhmm = (h: number, m: number): string =>
  `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

const fieldLabel = "text-[10px] uppercase tracking-wider text-muted-foreground font-semibold";
const fieldControl = "mt-1 w-full h-9 rounded-md border border-border bg-background px-3 text-xs";
const smallButton =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-accent disabled:opacity-50";

interface Form {
  id: string | null;
  clientId: string;
  chatId: string;
  time: string;
  active: boolean;
}

type Msg = { tone: "ok" | "bad"; text: string } | null;

function AdsetReportsPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const defaultClient =
    data.clients.find((c) => c.id === "oneagency")?.id ?? data.clients[0]?.id ?? "";
  const blankForm: Form = {
    id: null,
    clientId: defaultClient,
    chatId: data.chats[0]?.chatId ?? "",
    time: hhmm(ADSET_REPORT_DEFAULT_AT.hour, ADSET_REPORT_DEFAULT_AT.minute),
    active: true,
  };
  const [form, setForm] = useState<Form>(blankForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [preview, setPreview] = useState({ clientId: defaultClient, date: data.reportedDay });
  const [doc, setDoc] = useState<ReportDoc | null>(null);
  const [previewMsg, setPreviewMsg] = useState<Msg>(null);

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

  const save = (f: Form) =>
    run("save", async () => {
      const [hour, minute] = f.time.split(":").map(Number);
      await saveAdsetSchedule({
        data: {
          id: f.id,
          clientId: f.clientId,
          chatId: f.chatId.trim(),
          hour,
          minute,
          active: f.active,
        },
      });
      setForm(blankForm);
      return f.id ? "Schedule updated." : "Schedule created.";
    });

  const toggle = (s: AdsetScheduleView) =>
    save({
      id: s.id,
      clientId: s.clientId,
      chatId: s.chatId,
      time: hhmm(s.hour, s.minute),
      active: !s.active,
    });

  const sendNow = (s: AdsetScheduleView) =>
    run(`send:${s.id}`, async () => {
      const r = await sendAdsetScheduleNow({ data: { id: s.id, date: data.reportedDay } });
      return `Sent ${s.clientName} ${data.reportedDay} (${r.adSets} ad sets) to ${s.chatLabel}.`;
    });

  const remove = (s: AdsetScheduleView) => {
    if (!window.confirm(`Delete the ${s.clientName} report to ${s.chatLabel}?`)) return;
    void run(`delete:${s.id}`, async () => {
      await deleteAdsetSchedule({ data: { id: s.id } });
      return "Schedule deleted.";
    });
  };

  const runPreview = async () => {
    setBusy("preview");
    setPreviewMsg(null);
    try {
      const r = await previewAdsetReport({ data: preview });
      setDoc(r.doc);
      if (r.doc.rows.length === 0)
        setPreviewMsg({ tone: "bad", text: `No ad set delivered on ${preview.date}.` });
    } catch (e) {
      setDoc(null);
      setPreviewMsg({ tone: "bad", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const knownChat = data.chats.some((c) => c.chatId === form.chatId);

  return (
    <div className="min-h-screen bg-background">
      <div className="p-6 md:p-8 space-y-6 max-w-screen-2xl mx-auto">
        <PageHeader
          title="Daily ad-set reports"
          description="A CSV per client — spend, impressions, clicks, CPC, CPM, CTR, registrations and purchases for every ad set — sent to Telegram each morning for the previous day."
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

        <section className="rounded-xl border border-border bg-card p-6 space-y-4">
          <h3 className="text-sm font-semibold">Schedules</h3>
          {data.schedules.length === 0 ? (
            <p className="text-xs text-muted-foreground">No schedules yet — add one below.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left py-1 font-semibold">Client</th>
                  <th className="text-left py-1 font-semibold">Telegram chat</th>
                  <th className="text-left py-1 font-semibold">Sends (Berlin)</th>
                  <th className="text-left py-1 font-semibold">Last run</th>
                  <th className="text-right py-1 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.schedules.map((s) => (
                  <tr key={s.id} className="border-t border-border align-top">
                    <td className="py-2 font-medium">{s.clientName}</td>
                    <td className="py-2">{s.chatLabel}</td>
                    <td className="py-2 font-mono">
                      {hhmm(s.hour, s.minute)}
                      {!s.active && <span className="ml-2 text-amber-500 font-sans">paused</span>}
                    </td>
                    <td className="py-2">
                      <LastRun s={s} />
                    </td>
                    <td className="py-2">
                      <div className="flex justify-end gap-1.5 flex-wrap">
                        <button
                          onClick={() => void sendNow(s)}
                          disabled={busy !== null}
                          className={smallButton}
                          title={`Send ${data.reportedDay}'s report now`}
                        >
                          <Send className="size-3.5" />
                          {busy === `send:${s.id}` ? "Sending…" : `Send ${data.reportedDay}`}
                        </button>
                        <button
                          onClick={() =>
                            setForm({
                              id: s.id,
                              clientId: s.clientId,
                              chatId: s.chatId,
                              time: hhmm(s.hour, s.minute),
                              active: s.active,
                            })
                          }
                          disabled={busy !== null}
                          className={smallButton}
                        >
                          <Pencil className="size-3.5" /> Edit
                        </button>
                        <button
                          onClick={() => void toggle(s)}
                          disabled={busy !== null}
                          className={smallButton}
                        >
                          {s.active ? (
                            <Pause className="size-3.5" />
                          ) : (
                            <Play className="size-3.5" />
                          )}
                          {s.active ? "Pause" : "Resume"}
                        </button>
                        <button
                          onClick={() => remove(s)}
                          disabled={busy !== null}
                          className={`${smallButton} text-destructive hover:bg-destructive/10`}
                        >
                          <Trash2 className="size-3.5" /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Message msg={msg} />
        </section>

        <section className="rounded-xl border border-border bg-card p-6 space-y-4">
          <h3 className="text-sm font-semibold">{form.id ? "Edit schedule" : "New schedule"}</h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <label className="block">
              <span className={fieldLabel}>Client</span>
              <select
                value={form.clientId}
                onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                className={fieldControl}
              >
                {data.clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={fieldLabel}>Telegram chat</span>
              <select
                value={knownChat ? form.chatId : ""}
                onChange={(e) => setForm({ ...form, chatId: e.target.value })}
                className={fieldControl}
              >
                {data.chats.map((c) => (
                  <option key={c.chatId} value={c.chatId}>
                    {c.label}
                  </option>
                ))}
                <option value="">Other chat id…</option>
              </select>
            </label>
            <label className="block">
              <span className={fieldLabel}>Chat id</span>
              <input
                value={form.chatId}
                placeholder="e.g. 347759628"
                onChange={(e) => setForm({ ...form, chatId: e.target.value })}
                className={`${fieldControl} font-mono`}
              />
            </label>
            <label className="block">
              <span className={fieldLabel}>Send at (Berlin)</span>
              <input
                type="time"
                value={form.time}
                onChange={(e) => setForm({ ...form, time: e.target.value })}
                className={`${fieldControl} font-mono`}
              />
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground">
            The chat must have sent <b>/start</b> to the bot (or added it to the group) — saving
            checks that the bot can reach it. Each send reports the previous Berlin day; insight
            days are each ad account&apos;s own calendar day, so before 10:00 a US account&apos;s
            day may still be open.
          </p>
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
              />
              Active
            </label>
            <button
              onClick={() => void save(form)}
              disabled={busy !== null || !form.clientId || !form.chatId.trim() || !form.time}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
            >
              {busy === "save" ? "Saving…" : form.id ? "Save changes" : "Create schedule"}
            </button>
            {form.id && (
              <button
                onClick={() => setForm(blankForm)}
                className="h-9 px-4 rounded-md border border-border text-xs font-medium"
              >
                Cancel
              </button>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-6 space-y-4">
          <h3 className="text-sm font-semibold">Preview</h3>
          <div className="flex flex-wrap items-end gap-4">
            <label className="block min-w-[220px]">
              <span className={fieldLabel}>Client</span>
              <select
                value={preview.clientId}
                onChange={(e) => setPreview({ ...preview, clientId: e.target.value })}
                className={fieldControl}
              >
                {data.clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={fieldLabel}>Day</span>
              <input
                type="date"
                value={preview.date}
                onChange={(e) => setPreview({ ...preview, date: e.target.value })}
                className={`${fieldControl} font-mono`}
              />
            </label>
            <button
              onClick={() => void runPreview()}
              disabled={busy !== null || !preview.clientId || !preview.date}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
            >
              {busy === "preview" ? "Loading…" : "Preview"}
            </button>
            {doc && doc.rows.length > 0 && (
              <button onClick={() => downloadReportCsv(doc)} className={`${smallButton} h-9`}>
                <Download className="size-3.5" /> Download CSV
              </button>
            )}
          </div>
          <Message msg={previewMsg} />
          {doc && doc.rows.length > 0 && <ReportTable doc={doc} />}
        </section>
      </div>
    </div>
  );
}

function LastRun({ s }: { s: AdsetScheduleView }) {
  if (!s.runDate) return <span className="text-muted-foreground">never</span>;
  if (s.sentAt)
    return (
      <span className="inline-flex items-center gap-1 text-success">
        <CheckCircle2 className="size-3.5" /> {s.runDate} · sent{" "}
        {new Date(s.sentAt).toLocaleString()}
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
      className={`inline-flex items-center gap-1 text-xs ${msg.tone === "ok" ? "text-success" : "text-destructive"}`}
    >
      {msg.tone === "ok" ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
      {msg.text}
    </p>
  );
}

function ReportTable({ doc }: { doc: ReportDoc }) {
  const spendAt = doc.columns.findIndex((c) => c.key === "spend");
  const totalSpend = Number(doc.totals?.[spendAt] ?? 0);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {doc.rows.length} ad set{doc.rows.length === 1 ? "" : "s"} ·{" "}
        {fmtCurrency(totalSpend, "USD", 2)} spend
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              {doc.columns.map((c) => (
                <th
                  key={c.key}
                  className={`py-1 px-2 font-semibold whitespace-nowrap ${c.kind === "text" ? "text-left" : "text-right"}`}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...doc.rows, ...(doc.totals ? [doc.totals] : [])].map((r, i) => (
              <tr
                key={i}
                className={`border-t border-border ${i === doc.rows.length ? "font-semibold" : ""}`}
              >
                {r.map((v, j) => (
                  <td
                    key={j}
                    className={`py-1.5 px-2 whitespace-nowrap ${doc.columns[j].kind === "text" ? "" : "text-right font-mono"}`}
                  >
                    {/* Cents, as in the CSV: whole dollars hide the CPC differences that matter. */}
                    {doc.columns[j].kind === "money" && typeof v === "number"
                      ? fmtCurrency(v, "USD", 2)
                      : showCell(v, doc.columns[j].kind)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
