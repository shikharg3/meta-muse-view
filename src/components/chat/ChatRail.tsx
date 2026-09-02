import { useMemo, useState } from "react";
import { MessageSquarePlus, Pencil, Search, Trash2, PanelLeftClose, PanelLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtCost } from "./thread-cost";
import type { ConversationSummary } from "@/server/fns/conversations";

/**
 * Persistent list of previous chats, with New chat as the first thing in it.
 *
 * This replaces a popover behind a "History" button. The popover was the whole failure: one person
 * never found it, so every visit resumed the same thread — the route loader auto-opened the most
 * recent conversation — and that single thread reached 212 questions and $59.16. A list you can see
 * is what makes "this belongs in a new chat" an available thought.
 */

/** Berlin-agnostic day bucketing — relative labels only, so no timezone question arises. */
function bucketOf(iso: string, now: number): string {
  const age = now - new Date(iso).getTime();
  const day = 86_400_000;
  if (age < day) return "Today";
  if (age < 2 * day) return "Yesterday";
  if (age < 7 * day) return "Previous 7 days";
  if (age < 30 * day) return "Previous 30 days";
  return "Older";
}

const ORDER = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];

export function ChatRail({
  conversations,
  activeId,
  busy,
  collapsed,
  onToggleCollapsed,
  onNewChat,
  onSelect,
  onRename,
  onDelete,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  busy: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? conversations.filter((c) => c.title.toLowerCase().includes(q))
      : conversations;
    const now = Date.now();
    const byBucket = new Map<string, ConversationSummary[]>();
    for (const c of matched) {
      const bucket = bucketOf(c.updatedAt, now);
      const list = byBucket.get(bucket);
      if (list) list.push(c);
      else byBucket.set(bucket, [c]);
    }
    return ORDER.filter((b) => byBucket.has(b)).map((b) => ({
      label: b,
      items: byBucket.get(b) ?? [],
    }));
  }, [conversations, query]);

  if (collapsed) {
    return (
      <div className="flex w-12 shrink-0 flex-col items-center gap-2 border-r border-border bg-card/40 py-3">
        <button
          onClick={onToggleCollapsed}
          title="Show chats"
          className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <PanelLeft className="size-4" />
        </button>
        <button
          onClick={onNewChat}
          disabled={busy}
          title="New chat  (Ctrl/⌘ + Shift + O)"
          className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground disabled:opacity-50"
        >
          <MessageSquarePlus className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-64 shrink-0 flex-col border-r border-border bg-card/40">
      <div className="flex items-center gap-1.5 p-2.5">
        <button
          onClick={onNewChat}
          disabled={busy}
          title="New chat  (Ctrl/⌘ + Shift + O)"
          className="inline-flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          <MessageSquarePlus className="size-4 shrink-0" />
          New chat
        </button>
        <button
          onClick={onToggleCollapsed}
          title="Hide chats"
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <PanelLeftClose className="size-4" />
        </button>
      </div>

      {conversations.length > 4 && (
        <div className="relative px-2.5 pb-2">
          <Search className="pointer-events-none absolute left-4.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {conversations.length === 0 && (
          <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">
            No chats yet. Ask your first question.
          </p>
        )}
        {conversations.length > 0 && groups.length === 0 && (
          <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">
            Nothing matches “{query.trim()}”.
          </p>
        )}
        {groups.map((group) => (
          <div key={group.label} className="mb-1">
            <div className="px-2.5 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </div>
            {group.items.map((c) => (
              <div
                key={c.id}
                className={cn(
                  "group relative flex items-center rounded-md",
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
                        const next = draft.trim();
                        if (next) onRename(c.id, next);
                        setRenamingId(null);
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setRenamingId(null);
                      }
                    }}
                    onBlur={() => setRenamingId(null)}
                    className="m-1 min-w-0 flex-1 rounded border border-primary/50 bg-background px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                ) : (
                  <>
                    <button
                      onClick={() => onSelect(c.id)}
                      disabled={busy}
                      className="min-w-0 flex-1 px-2.5 py-2 text-left disabled:opacity-60"
                    >
                      <div className="truncate text-xs font-medium leading-tight">{c.title}</div>
                      {c.turns > 0 && (
                        <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                          <span>{c.turns}Q</span>
                          <span
                            className={cn(
                              c.costUsd >= 3 && "font-semibold text-destructive",
                              c.costUsd >= 1 && c.costUsd < 3 && "text-warning",
                            )}
                          >
                            {fmtCost(c.costUsd)}
                          </span>
                        </div>
                      )}
                    </button>
                    {/* Sits over the row rather than in it: reserving space would squeeze the title
                        on every row for two buttons that only appear on one. */}
                    <div className="absolute right-1 hidden items-center gap-0.5 rounded bg-accent pl-2 group-hover:flex">
                      <button
                        onClick={() => {
                          setDraft(c.title);
                          setRenamingId(c.id);
                        }}
                        title="Rename"
                        className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                      >
                        <Pencil className="size-3" />
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(`Delete "${c.title}"? This can't be undone.`))
                            onDelete(c.id);
                        }}
                        title="Delete"
                        className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
