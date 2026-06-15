import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  Send,
  Wrench,
  AlertCircle,
  Loader2,
  FileText,
  Download,
  Plus,
} from "lucide-react";
import { sendChat } from "@/lib/api/chat";
import { generateClientReport } from "@/lib/api/report";
import { listClients } from "@/lib/api/clients";
import type { ChatResult, ToolTrace } from "@/server/agent/chat";
import type { ReportPayload, ReportColumn } from "@/server/agent/report";
import { ReportBuilder, type ReportRequest } from "@/components/chat/ReportBuilder";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fmtCurrency, fmtCompact, fmtNumber, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Ask — MetaConsole" },
      {
        name: "description",
        content: "Ask questions about your Meta Ads performance in plain English.",
      },
    ],
  }),
  loader: async () => ({ clients: await listClients() }),
  component: Ask,
});

interface UiMessage {
  role: "user" | "assistant";
  content: string;
  cards?: ChatResult["cards"];
  report?: ReportPayload | null;
  toolCalls?: ToolTrace[];
  error?: string;
}

const SUGGESTIONS = [
  "What's the status of Playw3 campaigns?",
  "Show me Wild's performance over the last 7 days",
  "How are we doing across all accounts this week?",
  "Which client spent the most in the last 30 days?",
];

const SLASH_HINT =
  "Tip: type /reports to generate a CSV/PDF, e.g. /reports last 7 days for PlayW3 by day with spend, results, cpc, ctr, cpm";

const TOOL_LABEL: Record<string, string> = {
  list_clients: "listed clients",
  get_client_stats: "fetched client stats",
  get_overview: "fetched overview",
  search_entities: "searched entities",
  generate_report: "generated report",
};

function Ask() {
  const { clients } = Route.useLoaderData();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || loading) return;
    const history = [...messages, { role: "user" as const, content: q }];
    setMessages(history);
    setInput("");
    setLoading(true);
    try {
      const res = await sendChat({
        data: { messages: history.map((m) => ({ role: m.role, content: m.content })) },
      });
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: res.reply,
          cards: res.cards,
          report: res.report,
          toolCalls: res.toolCalls,
          error: res.error,
        },
      ]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "", error: e instanceof Error ? e.message : String(e) },
      ]);
    } finally {
      setLoading(false);
    }
  };

  // Direct (no-LLM) report path from the builder: run it and drop the result
  // into the thread as a normal assistant turn.
  const runReport = async (req: ReportRequest) => {
    setBuilderOpen(false);
    if (loading) return;
    setMessages((prev) => [...prev, { role: "user", content: `📄 Report — ${req.summary}` }]);
    setLoading(true);
    try {
      const res = await generateClientReport({
        data: {
          clientId: req.clientId,
          days: req.days,
          since: req.since,
          until: req.until,
          columns: req.columns,
          breakdown: req.breakdown,
        },
      });
      const errored = "error" in res;
      setMessages((prev) => [
        ...prev,
        errored
          ? { role: "assistant", content: "", error: res.error }
          : {
              role: "assistant",
              content: `Here's your report for ${req.clientName}.`,
              report: res,
            },
      ]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "", error: e instanceof Error ? e.message : String(e) },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const empty = messages.length === 0;

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 md:px-6 py-8">
          {empty ? (
            <div className="flex flex-col items-center text-center pt-16 pb-8">
              <div className="size-12 rounded-xl bg-primary grid place-items-center mb-4">
                <Sparkles className="size-6 text-primary-foreground" />
              </div>
              <h1 className="text-xl font-semibold tracking-tight">Ask about your ads</h1>
              <p className="text-sm text-muted-foreground mt-1.5 max-w-md">
                Plain-English questions about clients, accounts, and campaigns. Every number is
                pulled live from your synced data.
              </p>
              <div className="grid sm:grid-cols-2 gap-2.5 mt-7 w-full">
                <button
                  onClick={() => setBuilderOpen(true)}
                  className="flex items-center gap-3 text-left rounded-lg border border-primary/30 bg-primary/5 hover:bg-primary/10 px-4 py-3 transition-colors"
                >
                  <div className="size-8 rounded-md bg-primary/15 grid place-items-center shrink-0">
                    <FileText className="size-4 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium">/reports</div>
                    <div className="text-xs text-muted-foreground">Build a CSV/PDF report</div>
                  </div>
                </button>
              </div>
              <div className="grid sm:grid-cols-2 gap-2.5 mt-8 w-full">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    className="text-left text-sm rounded-lg border border-border bg-card hover:bg-accent hover:border-primary/40 px-4 py-3 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground mt-4 flex items-center gap-1.5">
                <FileText className="size-3" /> {SLASH_HINT}
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {messages.map((m, i) => (
                <Message key={i} message={m} />
              ))}
              {loading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Thinking…
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border bg-background/80 backdrop-blur">
        <div className="mx-auto max-w-3xl px-4 md:px-6 py-3">
          {builderOpen && (
            <div className="mb-3">
              <ReportBuilder
                clients={clients}
                busy={loading}
                onSubmit={(r) => void runReport(r)}
                onClose={() => setBuilderOpen(false)}
              />
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="flex items-end gap-2"
          >
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  title="Powers"
                  className="h-[42px] w-[42px] grid place-items-center rounded-lg border border-border bg-card hover:bg-accent shrink-0 text-muted-foreground"
                >
                  <Plus className="size-4" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                side="top"
                className="p-1.5 w-64"
                onOpenAutoFocus={(e) => e.preventDefault()}
                onCloseAutoFocus={(e) => e.preventDefault()}
              >
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold px-2 py-1">
                  Powers
                </div>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setBuilderOpen(true);
                  }}
                  className="w-full flex items-center gap-2.5 text-left rounded-md hover:bg-accent px-2 py-2"
                >
                  <FileText className="size-4 text-primary shrink-0" />
                  <div>
                    <div className="text-xs font-medium">/reports</div>
                    <div className="text-[11px] text-muted-foreground">Build a CSV/PDF report</div>
                  </div>
                </button>
              </PopoverContent>
            </Popover>
            <textarea
              value={input}
              onChange={(e) => {
                const v = e.target.value;
                setInput(v);
                setMenuOpen(v === "/"); // hint menu only while input is bare "/"; never steals focus
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
              placeholder="Ask about a client, account, or campaign…  (type / for powers)"
              className="flex-1 resize-none rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 max-h-40"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="h-[42px] px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50 shrink-0"
            >
              <Send className="size-4" /> Send
            </button>
          </form>
          <p className="text-[10px] text-muted-foreground mt-1.5 text-center">
            Answers are generated from your synced Meta data. Verify critical figures on the
            dashboards.
          </p>
        </div>
      </div>
    </div>
  );
}

function Message({ message }: { message: UiMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-2.5 text-sm max-w-[85%] whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <div className="size-7 rounded-md bg-primary/10 grid place-items-center shrink-0 mt-0.5">
        <Sparkles className="size-3.5 text-primary" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {message.error ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive">
            <AlertCircle className="size-4 mt-0.5 shrink-0" />
            <span>{message.error}</span>
          </div>
        ) : (
          <div className="text-sm whitespace-pre-wrap leading-relaxed">{message.content}</div>
        )}
        {message.cards && <KpiStrip title={message.cards.title} kpis={message.cards.kpis} />}
        {message.report && <ReportBlock report={message.report} />}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <Wrench className="size-3 text-muted-foreground" />
            {message.toolCalls.map((t, i) => (
              <span
                key={i}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] font-mono",
                  t.ok ? "bg-accent text-muted-foreground" : "bg-destructive/10 text-destructive",
                )}
              >
                {TOOL_LABEL[t.name] ?? t.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function KpiStrip({
  title,
  kpis,
}: {
  title: string;
  kpis: NonNullable<ChatResult["cards"]>["kpis"];
}) {
  const items: [string, string][] = [
    ["Spend", fmtCurrency(kpis.spend)],
    ["Impressions", fmtCompact(kpis.impressions)],
    ["Clicks", fmtCompact(kpis.clicks)],
    ["CTR", fmtPct(kpis.ctr)],
    ["CPC", fmtCurrency(kpis.cpc)],
  ];
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
        {title}
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
        {items.map(([label, value]) => (
          <div key={label}>
            <div className="text-[10px] text-muted-foreground">{label}</div>
            <div className="text-sm font-semibold font-mono mt-0.5">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Report rendering + downloads ----

/** Format a raw cell value for display, per its column kind. */
function fmtCell(value: string | number, kind: ReportColumn["kind"]): string {
  if (typeof value === "string") return value;
  switch (kind) {
    case "money":
      return fmtCurrency(value);
    case "pct":
      return fmtPct(value);
    case "int":
      return fmtNumber(value);
    case "float":
      return value.toFixed(2);
    default:
      return String(value);
  }
}

/** Plain value for CSV/PDF (numbers rounded, no currency symbols). */
function rawCell(value: string | number, kind: ReportColumn["kind"]): string {
  if (typeof value === "string") return value;
  if (kind === "int") return String(Math.round(value));
  return value.toFixed(2);
}

function downloadBlob(content: BlobPart, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function reportMatrix(report: ReportPayload): string[][] {
  const body = report.rows.map((r) => r.map((v, i) => rawCell(v, report.columns[i].kind)));
  if (report.totals) body.push(report.totals.map((v, i) => rawCell(v, report.columns[i].kind)));
  return body;
}

function downloadCsv(report: ReportPayload) {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [report.columns.map((c) => c.label), ...reportMatrix(report)];
  downloadBlob(
    lines.map((r) => r.map(esc).join(",")).join("\n"),
    "text/csv;charset=utf-8",
    `${report.filename}.csv`,
  );
}

async function downloadPdf(report: ReportPayload) {
  // Lazy-load the PDF libs so they stay out of the main chat bundle.
  const { default: jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");
  const landscape = report.columns.length > 6;
  const doc = new jsPDF({ orientation: landscape ? "landscape" : "portrait" });
  doc.setFontSize(13);
  doc.text(report.title, 14, 16);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(report.subtitle + (report.note ? `  (${report.note})` : ""), 14, 22);
  autoTable(doc, {
    head: [report.columns.map((c) => c.label)],
    body: reportMatrix(report),
    startY: 27,
    styles: { fontSize: 8 },
    headStyles: { fillColor: [37, 99, 235] },
    ...(report.totals
      ? { footStyles: { fillColor: [241, 245, 249], textColor: 20, fontStyle: "bold" } }
      : {}),
  });
  doc.save(`${report.filename}.pdf`);
}

function ReportBlock({ report }: { report: ReportPayload }) {
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
        <FileText className="size-4 text-primary shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">{report.title}</div>
          <div className="text-[11px] text-muted-foreground">
            {report.subtitle} · {report.rowCount} row{report.rowCount === 1 ? "" : "s"}
          </div>
        </div>
        <button
          onClick={() => downloadCsv(report)}
          className="h-8 px-3 rounded-md border border-border text-xs font-medium inline-flex items-center gap-1.5 hover:bg-accent"
        >
          <Download className="size-3.5" /> CSV
        </button>
        <button
          onClick={() => void downloadPdf(report)}
          className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium inline-flex items-center gap-1.5"
        >
          <Download className="size-3.5" /> PDF
        </button>
      </div>
      {report.note && (
        <div className="px-4 py-2 text-[11px] text-muted-foreground border-b border-border bg-muted/30">
          {report.note}
        </div>
      )}
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card">
            <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
              {report.columns.map((c) => (
                <th
                  key={c.key}
                  className={cn("px-3 py-2 font-semibold", c.kind !== "text" && "text-right")}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row, ri) => (
              <tr key={ri} className="border-b border-border/50">
                {row.map((v, ci) => (
                  <td
                    key={ci}
                    className={cn(
                      "px-3 py-1.5 font-mono",
                      report.columns[ci].kind !== "text" && "text-right",
                      ci === 0 && report.columns[ci].kind === "text" && "font-sans text-foreground",
                    )}
                  >
                    {fmtCell(v, report.columns[ci].kind)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {report.totals && (
            <tfoot className="sticky bottom-0 bg-muted/50">
              <tr className="font-semibold border-t border-border">
                {report.totals.map((v, ci) => (
                  <td
                    key={ci}
                    className={cn(
                      "px-3 py-1.5 font-mono",
                      report.columns[ci].kind !== "text" && "text-right",
                    )}
                  >
                    {fmtCell(v, report.columns[ci].kind)}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
