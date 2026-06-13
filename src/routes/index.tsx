import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Sparkles, Send, Wrench, AlertCircle, Loader2 } from "lucide-react";
import { sendChat } from "@/lib/api/chat";
import type { ChatResult, ToolTrace } from "@/server/agent/chat";
import { fmtCurrency, fmtCompact, fmtPct } from "@/lib/format";
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
  component: Ask,
});

interface UiMessage {
  role: "user" | "assistant";
  content: string;
  cards?: ChatResult["cards"];
  toolCalls?: ToolTrace[];
  error?: string;
}

const SUGGESTIONS = [
  "What's the status of Playw3 campaigns?",
  "Show me Wild's performance over the last 7 days",
  "How are we doing across all accounts this week?",
  "Which client spent the most in the last 30 days?",
];

const TOOL_LABEL: Record<string, string> = {
  list_clients: "listed clients",
  get_client_stats: "fetched client stats",
  get_overview: "fetched overview",
  search_entities: "searched entities",
};

function Ask() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
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
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="flex items-end gap-2"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
              placeholder="Ask about a client, account, or campaign…"
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
