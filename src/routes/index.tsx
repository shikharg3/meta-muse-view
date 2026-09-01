import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Sparkles,
  Send,
  Square,
  AlertCircle,
  FileText,
  History,
  Trash2,
  Pencil,
  Search,
  Copy,
  Check,
  RefreshCw,
  MessageSquarePlus,
} from "lucide-react";
import {
  listConversations,
  getConversation,
  renameConversation,
  deleteConversation,
} from "@/lib/api/conversations";
import { listClients } from "@/lib/api/clients";
import type { ChatEvent, MessageExtras } from "@/server/agent/events";
import type {
  StoredMessage,
  ConversationSummary,
  MessagePayload,
} from "@/server/fns/conversations";
import type { ReportPayload } from "@/server/agent/report";
import type { Kpis } from "@/lib/types";
import { ReportBlock } from "@/components/chat/ReportBlock";
import { Markdown } from "@/components/chat/Markdown";
import { SeriesChart } from "@/components/chat/SeriesChart";
import { ToolTraceLive, ToolTraceSummary } from "@/components/chat/ToolTrace";
import { closeTrace, type TraceItem } from "@/components/chat/trace";
import { streamChat } from "@/components/chat/stream";
import { ThreadMeter, ThreadNudge } from "@/components/chat/ThreadMeter";
import { NUDGE_TURNS, NUDGE_COST, fmtCost } from "@/components/chat/thread-cost";
import { deriveFollowUps, starterPrompts } from "@/components/chat/suggestions";
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
  cards?: MessageExtras["cards"];
  series?: MessageExtras["series"];
  report?: ReportPayload | null;
  toolCalls?: TraceItem[];
  error?: string;
  costUsd?: number;
  /** Set while the turn is streaming; drives the trace panel and the Stop button. */
  streaming?: boolean;
  /** Latest `status` event — "thinking" text shown until the next tool starts. */
  status?: string;
  /** The user aborted this turn. The partial answer above it is kept. */
  stopped?: boolean;
}

const SLASH_HINT =
  "Tip: type /reports to generate a CSV/PDF, e.g. /reports last 7 days for PlayW3 by day with spend, results, cpc, ctr, cpm";

/**
 * Rehydrate persisted messages (payload jsonb → typed cards/series/report/toolCalls/error).
 * Rows written before a payload field existed simply lack the key, so every read is defaulted —
 * a two-month-old thread must still open.
 */
function toUiMessages(stored: StoredMessage[]): UiMessage[] {
  return stored.map((m) => {
    const p: Partial<MessagePayload> & { series?: MessageExtras["series"] } = m.payload ?? {};
    return {
      role: m.role,
      content: m.content,
      cards: p.cards ?? null,
      series: p.series ?? null,
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
  const [streaming, setStreaming] = useState(false);
  const [followUps, setFollowUps] = useState<string[]>([]);
  /** Turn count at which the nudge was last waved away; it returns after another NUDGE_TURNS. */
  const [nudgeDismissedAt, setNudgeDismissedAt] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Token deltas arrive far faster than anyone can read. They pile up here and flush on a timer, so
  // a long answer costs a few dozen markdown re-renders instead of a few thousand.
  const pendingText = useRef("");
  const flushTimer = useRef<number | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Abort an in-flight turn if the tab navigates away mid-answer.
  useEffect(() => () => abortRef.current?.abort(), []);

  // A discoverable shortcut matters here: the whole cost problem started with someone never finding
  // the button. Shift+O avoids Ctrl/Cmd+N, which the browser owns.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        newChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** Mutate the in-flight assistant message. It is always the last one, so no index bookkeeping. */
  const patchLast = useCallback((fn: (m: UiMessage) => UiMessage) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== "assistant") return prev;
      return [...prev.slice(0, -1), fn(last)];
    });
  }, []);

  const flushText = useCallback(() => {
    if (flushTimer.current !== null) {
      window.clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    const text = pendingText.current;
    if (text === "") return;
    pendingText.current = "";
    patchLast((m) => ({ ...m, content: m.content + text, status: undefined }));
  }, [patchLast]);

  const refreshList = async () => setConversations(await listConversations());

  const newChat = () => {
    if (streaming) return;
    setActiveId(null);
    setMessages([]);
    setFollowUps([]);
    setNudgeDismissedAt(0);
  };

  const loadConversation = async (id: string) => {
    if (streaming) return;
    const stored = await getConversation({ data: id });
    if (!stored) return;
    setActiveId(id);
    setMessages(toUiMessages(stored));
    setFollowUps([]);
    setNudgeDismissedAt(0);
  };

  const removeConversation = async (id: string) => {
    await deleteConversation({ data: id });
    if (id === activeId) newChat();
    await refreshList();
  };

  const rename = async (id: string, title: string) => {
    await renameConversation({ data: { id, title } });
    await refreshList();
  };

  const send = async (text: string) => {
    const q = text.trim();
    if (q === "" || streaming) return;
    setInput("");
    setFollowUps([]);
    setStreaming(true);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: q },
      { role: "assistant", content: "", toolCalls: [], streaming: true, status: "Thinking…" },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;
    pendingText.current = "";
    // What the turn produced, tracked as it happens so the follow-ups can be conditioned on it
    // without having to read back through state.
    const produced = { cards: false, series: false, report: false };
    // `done`/`error` end the turn, but the server keeps the connection open a little longer while it
    // persists the message. The composer is released at `done` so the user is not blocked on a write
    // they cannot see; this flag makes sure the draining tail can no longer touch the thread — by
    // then the last assistant message may already belong to the *next* question.
    let settled = false;

    const onEvent = (event: ChatEvent) => {
      if (settled) return;
      if (event.type === "delta") {
        pendingText.current += event.text;
        if (flushTimer.current === null) flushTimer.current = window.setTimeout(flushText, 60);
        return;
      }
      // Everything else changes structure, so land the buffered text first.
      flushText();
      switch (event.type) {
        case "start":
          setActiveId(event.conversationId);
          break;
        case "status":
          patchLast((m) => ({ ...m, status: event.text }));
          break;
        case "tool_start":
          patchLast((m) => ({
            ...m,
            status: undefined,
            toolCalls: [
              ...(m.toolCalls ?? []),
              { name: event.name, label: event.label, detail: event.detail },
            ],
          }));
          break;
        case "tool_end":
          patchLast((m) => ({ ...m, toolCalls: closeTrace(m.toolCalls ?? [], event) }));
          break;
        case "cards":
          produced.cards = true;
          patchLast((m) => ({ ...m, cards: { title: event.title, kpis: event.kpis } }));
          break;
        case "series":
          produced.series = true;
          patchLast((m) => ({
            ...m,
            series: { title: event.title, unit: event.unit, points: event.points },
          }));
          break;
        case "report":
          produced.report = true;
          patchLast((m) => ({ ...m, report: event.report }));
          break;
        case "done":
          settled = true;
          // `done` carries the authoritative trace, so it replaces the live one wholesale.
          patchLast((m) => ({
            ...m,
            costUsd: event.costUsd,
            toolCalls: event.toolCalls,
            status: undefined,
            streaming: false,
          }));
          setFollowUps(
            deriveFollowUps({
              question: q,
              toolCalls: event.toolCalls,
              hasCards: produced.cards,
              hasSeries: produced.series,
              hasReport: produced.report,
              clientNames: clients.map((c) => c.name),
            }),
          );
          setStreaming(false);
          break;
        case "error":
          settled = true;
          patchLast((m) => ({ ...m, error: event.message, status: undefined, streaming: false }));
          setStreaming(false);
          break;
      }
    };

    try {
      await streamChat({ conversationId: activeId, message: q }, controller.signal, onEvent);
      flushText();
      // A stream that ends without `done` (proxy timeout, server crash mid-answer) must still let go
      // of the spinner, and must keep whatever text did arrive.
      if (!settled) patchLast((m) => ({ ...m, streaming: false, status: undefined }));
      // Refreshed here rather than at `done`: the server writes the message AFTER emitting `done`,
      // so the titles and timestamps are only correct once the stream has actually closed.
      void refreshList();
    } catch (e) {
      flushText();
      const aborted = controller.signal.aborted;
      // A connection that drops while the finished turn was being persisted is not this message's
      // problem — `settled` means the answer above is complete and already stamped with its cost.
      if (!settled) {
        patchLast((m) => ({
          ...m,
          streaming: false,
          status: undefined,
          stopped: aborted,
          // An abort is a user action, not a failure — and an empty stopped bubble needs *something*.
          error: aborted ? undefined : e instanceof Error ? e.message : String(e),
        }));
      }
      if (aborted) void refreshList();
    } finally {
      // Only if this turn still owns the composer: the user may already have sent the next question
      // while this stream was draining its tail.
      if (abortRef.current === controller) {
        abortRef.current = null;
        setStreaming(false);
      }
    }
  };

  const stop = () => abortRef.current?.abort();

  /** Re-ask the user message that produced a given assistant message, replacing the old answer. */
  const retry = (index: number) => {
    if (streaming) return;
    let i = index - 1;
    while (i >= 0 && messages[i].role !== "user") i -= 1;
    if (i < 0) return;
    const q = messages[i].content;
    // Drop the old question and everything after it; `send` re-appends the question itself.
    setMessages((prev) => prev.slice(0, i));
    void send(q);
  };

  const empty = messages.length === 0;
  const activeTitle = conversations.find((c) => c.id === activeId)?.title ?? "New chat";
  const starters = starterPrompts(clients);

  // Counted from the messages on screen rather than the stored summary, so the meter moves with the
  // answer instead of waiting for the list to refetch.
  const threadTurns = messages.filter((m) => m.role === "assistant").length;
  const threadCost = messages.reduce((sum, m) => sum + (m.costUsd ?? 0), 0);
  const overThreshold = threadTurns >= NUDGE_TURNS || threadCost >= NUDGE_COST;
  // 0 = never dismissed. After a dismissal it stays quiet for another NUDGE_TURNS questions, so it
  // cannot be waved away once and then never seen again on a thread that keeps growing.
  const recentlyDismissed = nudgeDismissedAt > 0 && threadTurns - nudgeDismissedAt < NUDGE_TURNS;
  const showNudge = !streaming && overThreshold && !recentlyDismissed;

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
        <ThreadMeter turns={threadTurns} costUsd={threadCost} />
        <button
          onClick={newChat}
          disabled={streaming}
          title="Start a fresh chat  (Ctrl/⌘ + Shift + O)"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 h-8 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
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
              <div className="grid sm:grid-cols-2 gap-2.5 mt-8 w-full">
                {starters.map((s) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    className="text-left text-sm rounded-lg border border-border bg-card hover:bg-accent hover:border-primary/40 px-4 py-3 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
              <p className="mt-6 text-[11px] text-muted-foreground">
                One chat = one topic. Starting a fresh chat for a new question keeps answers sharp
                and costs less — every question re-sends the chat it lives in.
              </p>
              <Link
                to="/reports/new"
                className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-primary hover:underline"
              >
                <FileText className="size-3" /> Need a CSV or PDF? Build it on the Reports page
              </Link>
            </div>
          ) : (
            <div className="space-y-6">
              {messages.map((m, i) => (
                <Message
                  key={i}
                  message={m}
                  onRetry={m.role === "assistant" && !streaming ? () => retry(i) : undefined}
                />
              ))}
              {followUps.length > 0 && !streaming && (
                <div className="flex flex-wrap gap-2 pl-10">
                  {followUps.map((f) => (
                    <button
                      key={f}
                      onClick={() => void send(f)}
                      className="rounded-full border border-border bg-card hover:bg-accent hover:border-primary/40 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {f}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border bg-background/80 backdrop-blur">
        <div className="mx-auto max-w-3xl px-4 md:px-6 py-3">
          {showNudge && (
            <ThreadNudge
              turns={threadTurns}
              costUsd={threadCost}
              onNewChat={newChat}
              onDismiss={() => setNudgeDismissedAt(threadTurns)}
            />
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="flex items-end gap-2"
          >
            {/* The "+ powers" menu held exactly one item — a report builder that duplicates the
                Reports section. Removed rather than kept as a second, worse way in. */}
            <textarea
              value={input}
              onChange={(e) => {
                const v = e.target.value;
                setInput(v);
              }}
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
            {streaming ? (
              <button
                type="button"
                onClick={stop}
                title="Stop generating"
                className="h-[42px] px-4 rounded-lg border border-border bg-card hover:bg-accent text-sm font-medium inline-flex items-center gap-1.5 shrink-0"
              >
                <Square className="size-3.5 fill-current" /> Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={input.trim() === ""}
                className="h-[42px] px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50 shrink-0"
              >
                <Send className="size-4" /> Send
              </button>
            )}
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
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const needle = query.trim().toLowerCase();
  const shown =
    needle === ""
      ? conversations
      : conversations.filter((c) => c.title.toLowerCase().includes(needle));

  const commitRename = (id: string) => {
    const title = draft.trim();
    setRenamingId(null);
    if (title !== "") onRename(id, title);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          setRenamingId(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          title="Conversation history"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card hover:bg-accent px-2.5 h-8 text-xs font-medium text-muted-foreground"
        >
          <History className="size-3.5" /> History
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="p-1.5 w-80"
        onEscapeKeyDown={(e) => {
          // Radix's dismissable layer owns Escape. While a rename is open, Escape belongs to the
          // rename — cancelling an edit should put the row back, not close the whole list.
          if (renamingId === null) return;
          e.preventDefault();
          setRenamingId(null);
        }}
      >
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold px-2 py-1">
          Conversations
        </div>
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 mx-1 mb-1.5 h-7">
          <Search className="size-3 text-muted-foreground shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles…"
            className="flex-1 min-w-0 bg-transparent text-xs focus:outline-none"
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {conversations.length === 0 && (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              No conversations yet.
            </div>
          )}
          {conversations.length > 0 && shown.length === 0 && (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              No titles match “{query.trim()}”.
            </div>
          )}
          {shown.map((c) => (
            <div
              key={c.id}
              className={cn(
                "group flex items-center gap-1 rounded-md px-2 py-1.5",
                c.id === activeId ? "bg-accent" : "hover:bg-accent/50",
              )}
            >
              {renamingId === c.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitRename(c.id);
                    }
                  }}
                  onBlur={() => setRenamingId(null)}
                  className="min-w-0 flex-1 rounded border border-primary/50 bg-background px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40"
                />
              ) : (
                <>
                  <button
                    onClick={() => {
                      onSelect(c.id);
                      setOpen(false);
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="text-xs font-medium truncate">{c.title}</div>
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span>{fmtRelTime(c.updatedAt)}</span>
                      {c.turns > 0 && (
                        <>
                          <span className="text-border">·</span>
                          <span className="font-mono tabular-nums">{c.turns}Q</span>
                          <span
                            className={cn(
                              "font-mono tabular-nums",
                              c.costUsd >= 3 && "font-semibold text-destructive",
                              c.costUsd >= 1 && c.costUsd < 3 && "text-warning",
                            )}
                          >
                            {fmtCost(c.costUsd)}
                          </span>
                        </>
                      )}
                    </div>
                  </button>
                  <button
                    onClick={() => {
                      setDraft(c.title);
                      setRenamingId(c.id);
                    }}
                    title="Rename"
                    className="size-6 grid place-items-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background"
                  >
                    <Pencil className="size-3" />
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm(`Delete "${c.title}"? This can't be undone.`))
                        onDelete(c.id);
                    }}
                    title="Delete"
                    className="size-6 grid place-items-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Message({ message, onRetry }: { message: UiMessage; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false);

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-2.5 text-sm max-w-[85%] whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  const copy = () => {
    void navigator.clipboard.writeText(message.content).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      // A browser that denies clipboard-write (insecure origin, permission blocked) must leave the
      // icon alone rather than log an unhandled rejection: the tick means "it's on your clipboard".
      () => setCopied(false),
    );
  };
  const trace = message.toolCalls ?? [];

  return (
    <div className="group/msg flex gap-3">
      <div className="size-7 rounded-md bg-primary/10 grid place-items-center shrink-0 mt-0.5">
        <Sparkles className="size-3.5 text-primary" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {message.streaming && <ToolTraceLive items={trace} status={message.status} />}
        {message.error ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive">
            <AlertCircle className="size-4 mt-0.5 shrink-0" />
            <span>{message.error}</span>
          </div>
        ) : (
          message.content !== "" && <Markdown>{message.content}</Markdown>
        )}
        {message.streaming && message.content === "" && !message.error && trace.length === 0 && (
          <span className="inline-block h-4 w-1.5 animate-pulse rounded-sm bg-primary align-middle" />
        )}
        {message.cards && <KpiStrip title={message.cards.title} kpis={message.cards.kpis} />}
        {message.series && (
          <SeriesChart
            title={message.series.title}
            unit={message.series.unit}
            points={message.series.points}
          />
        )}
        {message.report && <ReportBlock report={message.report} />}
        {message.stopped && (
          <div className="text-[11px] text-muted-foreground">
            Stopped — the answer above is incomplete.
          </div>
        )}
        {!message.streaming && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-0.5">
            <ToolTraceSummary items={trace} />
            {message.costUsd != null && message.costUsd > 0 && (
              // Sits next to the tool summary rather than floated far right in 10px grey, which is
              // where it was when nobody noticed the cost of anything.
              <span
                className="font-mono text-[11px] text-muted-foreground"
                title="Model cost for this question (incl. prompt caching). The running total for the whole chat is in the header."
              >
                {fmtCost(message.costUsd)}
              </span>
            )}
            <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
              {message.content !== "" && (
                <button
                  onClick={copy}
                  title="Copy markdown"
                  className="size-6 grid place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
                </button>
              )}
              {onRetry && (
                <button
                  onClick={onRetry}
                  title="Ask again"
                  className="size-6 grid place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <RefreshCw className="size-3" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function KpiStrip({ title, kpis }: { title: string; kpis: Kpis }) {
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
