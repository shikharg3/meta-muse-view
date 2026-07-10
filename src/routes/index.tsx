import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  Send,
  Wrench,
  AlertCircle,
  Loader2,
  FileText,
  Plus,
  History,
  Trash2,
  Pencil,
  MessageSquarePlus,
} from "lucide-react";
import { sendChat, saveReport } from "@/lib/api/chat";
import {
  listConversations,
  getConversation,
  renameConversation,
  deleteConversation,
} from "@/lib/api/conversations";
import { generateClientReport } from "@/lib/api/report";
import { listClients } from "@/lib/api/clients";
import type { ChatResult, ToolTrace } from "@/server/agent/chat";
import type {
  StoredMessage,
  ConversationSummary,
  MessagePayload,
} from "@/server/fns/conversations";
import type { ReportPayload } from "@/server/agent/report";
import { ReportBuilder, type ReportRequest } from "@/components/chat/ReportBuilder";
import { ReportBlock } from "@/components/chat/ReportBlock";
import { Markdown } from "@/components/chat/Markdown";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fmtCurrency, fmtCompact, fmtPct, fmtRelTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Ask — MetaConsole" }] }),
  loader: async () => {
    const [clients, conversations] = await Promise.all([
      listClients().then((cs) => cs.filter((c) => c.removedAt == null)),
      listConversations(),
    ]);
    const first = conversations[0];
    const initial = first
      ? { id: first.id, messages: (await getConversation({ data: first.id })) ?? [] }
      : null;
    return { clients, conversations, initial };
  },
  component: Ask,
});

interface UiMessage {
  role: "user" | "assistant";
  content: string;
  cards?: ChatResult["cards"];
  report?: ReportPayload | null;
  toolCalls?: ToolTrace[];
  error?: string;
  costUsd?: number;
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
  list_clients: "clients",
  list_active_campaigns: "active campaigns",
  get_client_stats: "client stats",
  get_overview: "overview",
  list_accounts: "accounts",
  search_entities: "search",
  generate_report: "report",
};

const fmtCost = (usd: number): string => (usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`);

/** Rehydrate persisted messages (payload jsonb → typed cards/report/toolCalls/error). */
function toUiMessages(stored: StoredMessage[]): UiMessage[] {
  return stored.map((m) => {
    const p: Partial<MessagePayload> = m.payload ?? {};
    return {
      role: m.role,
      content: m.content,
      cards: p.cards ?? null,
      report: p.report ?? null,
      toolCalls: p.toolCalls ?? undefined,
      error: p.error,
      costUsd: m.costUsd ?? undefined,
    };
  });
}

function Ask() {
  const { clients, initial, conversations: initialConversations } = Route.useLoaderData();
  const [conversations, setConversations] = useState<ConversationSummary[]>(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(initial?.id ?? null);
  const [messages, setMessages] = useState<UiMessage[]>(
    initial ? toUiMessages(initial.messages) : [],
  );
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const refreshList = async () => setConversations(await listConversations());

  const newChat = () => {
    setActiveId(null);
    setMessages([]);
    setBuilderOpen(false);
  };

  const loadConversation = async (id: string) => {
    if (loading) return;
    const stored = await getConversation({ data: id });
    if (!stored) return;
    setActiveId(id);
    setMessages(toUiMessages(stored));
    setBuilderOpen(false);
  };

  const removeConversation = async (id: string) => {
    await deleteConversation({ data: id });
    if (id === activeId) newChat();
    await refreshList();
  };

  const rename = async (id: string, current: string) => {
    const title = window.prompt("Rename conversation", current)?.trim();
    if (!title) return;
    await renameConversation({ data: { id, title } });
    await refreshList();
  };

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || loading) return;
    setMessages((prev) => [...prev, { role: "user", content: q }]);
    setInput("");
    setLoading(true);
    try {
      const res = await sendChat({ data: { conversationId: activeId, message: q } });
      setActiveId(res.conversationId);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: res.reply,
          cards: res.cards,
          report: res.report,
          toolCalls: res.toolCalls,
          error: res.error,
          costUsd: res.costUsd,
        },
      ]);
      void refreshList();
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "", error: e instanceof Error ? e.message : String(e) },
      ]);
    } finally {
      setLoading(false);
    }
  };

  // Direct (no-LLM) report path from the builder: run it, persist it to the thread, and render it.
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
          markup: req.markup,
          campaignIds: req.campaignIds,
        },
      });
      if ("error" in res) {
        setMessages((prev) => [...prev, { role: "assistant", content: "", error: res.error }]);
      } else {
        const saved = await saveReport({
          data: {
            conversationId: activeId,
            summary: req.summary,
            clientName: req.clientName,
            report: res,
          },
        });
        setActiveId(saved.conversationId);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Here's your report for ${req.clientName}.`, report: res },
        ]);
        void refreshList();
      }
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
  const activeTitle = conversations.find((c) => c.id === activeId)?.title ?? "New chat";

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      <div className="shrink-0 h-11 border-b border-border flex items-center gap-2 px-4 md:px-6">
        <ConversationMenu
          conversations={conversations}
          activeId={activeId}
          onSelect={(id) => void loadConversation(id)}
          onDelete={(id) => void removeConversation(id)}
          onRename={(id, t) => void rename(id, t)}
        />
        <span className="text-sm font-medium truncate flex-1 min-w-0">{activeTitle}</span>
        <button
          onClick={newChat}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card hover:bg-accent px-2.5 h-8 text-xs font-medium"
        >
          <MessageSquarePlus className="size-3.5" /> New chat
        </button>
      </div>

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
                setMenuOpen(v === "/");
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

function ConversationMenu({
  conversations,
  activeId,
  onSelect,
  onDelete,
  onRename,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          title="Conversation history"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card hover:bg-accent px-2.5 h-8 text-xs font-medium text-muted-foreground"
        >
          <History className="size-3.5" /> History
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-1.5 w-80">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold px-2 py-1">
          Conversations
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {conversations.length === 0 && (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              No conversations yet.
            </div>
          )}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={cn(
                "group flex items-center gap-1 rounded-md px-2 py-1.5",
                c.id === activeId ? "bg-accent" : "hover:bg-accent/50",
              )}
            >
              <button
                onClick={() => {
                  onSelect(c.id);
                  setOpen(false);
                }}
                className="min-w-0 flex-1 text-left"
              >
                <div className="text-xs font-medium truncate">{c.title}</div>
                <div className="text-[10px] text-muted-foreground">{fmtRelTime(c.updatedAt)}</div>
              </button>
              <button
                onClick={() => onRename(c.id, c.title)}
                title="Rename"
                className="size-6 grid place-items-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background"
              >
                <Pencil className="size-3" />
              </button>
              <button
                onClick={() => {
                  if (window.confirm(`Delete "${c.title}"? This can't be undone.`)) onDelete(c.id);
                }}
                title="Delete"
                className="size-6 grid place-items-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
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
          <Markdown>{message.content}</Markdown>
        )}
        {message.cards && <KpiStrip title={message.cards.title} kpis={message.cards.kpis} />}
        {message.report && <ReportBlock report={message.report} />}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 pt-0.5">
          {message.toolCalls && message.toolCalls.length > 0 && (
            <>
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
            </>
          )}
          {message.costUsd != null && message.costUsd > 0 && (
            <span
              className="ml-auto text-[10px] font-mono text-muted-foreground"
              title="Model cost for this turn (Opus 4.8, incl. prompt caching)"
            >
              {fmtCost(message.costUsd)}
            </span>
          )}
        </div>
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
