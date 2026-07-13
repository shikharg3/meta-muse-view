import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { getCurrentUser, listUsers } from "@/lib/api/auth";
import { adminListConversations, adminGetConversation } from "@/lib/api/conversations";
import { isSuperadmin } from "@/lib/auth/roles";
import type { AdminConversation, AdminConversationDetail } from "@/server/fns/conversations";
import { cn } from "@/lib/utils";

const usd = (n: number) => `$${n.toFixed(n >= 1 ? 2 : 4)}`;
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const Route = createFileRoute("/chat-history")({
  head: () => ({ meta: [{ title: "Chat History — MetaConsole" }] }),
  loader: async () => {
    const me = await getCurrentUser();
    if (!isSuperadmin(me?.role)) return { denied: true as const };
    const [users, list] = await Promise.all([
      listUsers(),
      adminListConversations({ data: undefined }),
    ]);
    return {
      denied: false as const,
      users: "error" in users ? [] : users.users,
      conversations: "error" in list ? [] : list.conversations,
    };
  },
  component: ChatHistory,
});

function ChatHistory() {
  const data = Route.useLoaderData();
  if (data.denied) {
    return (
      <div className="p-6 md:p-8">
        <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
          This page is restricted to superadmins.
        </div>
      </div>
    );
  }
  return <ChatHistoryView users={data.users} initialConversations={data.conversations} />;
}

function ChatHistoryView({
  users,
  initialConversations,
}: {
  users: { id: string; email: string; name: string | null }[];
  initialConversations: AdminConversation[];
}) {
  const [conversations, setConversations] = useState<AdminConversation[]>(initialConversations);
  const [userId, setUserId] = useState("");
  const [detail, setDetail] = useState<AdminConversationDetail | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const filterUser = async (uid: string) => {
    setUserId(uid);
    setDetail(null);
    setActiveId(null);
    const res = await adminListConversations({ data: uid || undefined });
    if (!("error" in res)) setConversations(res.conversations);
  };
  const open = async (id: string) => {
    setActiveId(id);
    setLoading(true);
    const res = await adminGetConversation({ data: id });
    if (!("error" in res)) setDetail(res.conversation);
    setLoading(false);
  };

  return (
    <div className="p-6 md:p-8 space-y-6">
      <PageHeader
        title="Chat History"
        description="Every user's assistant conversations, including admins. Superadmin only."
      />
      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4">
        <div className="space-y-3">
          <select
            value={userId}
            onChange={(e) => void filterUser(e.target.value)}
            className="w-full h-9 rounded-md border border-border bg-background px-3 text-sm"
          >
            <option value="">All users</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.email}
              </option>
            ))}
          </select>
          <div className="rounded-xl border border-border bg-card divide-y divide-border max-h-[72vh] overflow-y-auto">
            {conversations.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                No conversations.
              </div>
            ) : (
              conversations.map((c) => (
                <button
                  key={c.id}
                  onClick={() => void open(c.id)}
                  className={cn(
                    "w-full text-left px-4 py-2.5 hover:bg-accent/40",
                    activeId === c.id && "bg-accent/60",
                  )}
                >
                  <div className="text-sm font-medium truncate">{c.title}</div>
                  <div className="text-[11px] text-muted-foreground font-mono truncate">
                    {c.userEmail}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span>{fmtTime(c.updatedAt)}</span>
                    <span>· {c.messages} msgs</span>
                    {c.costUsd > 0 && <span>· {usd(c.costUsd)}</span>}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card min-h-[320px]">
          {!detail ? (
            <div className="h-full grid place-items-center p-10 text-sm text-muted-foreground">
              {loading ? "Loading…" : "Select a conversation to view its transcript."}
            </div>
          ) : (
            <div className="p-5 space-y-4">
              <div className="border-b border-border pb-3">
                <div className="font-semibold">{detail.title}</div>
                <div className="text-[11px] text-muted-foreground font-mono">
                  {detail.userName ? `${detail.userName} · ` : ""}
                  {detail.userEmail}
                </div>
              </div>
              {detail.messages.map((m, i) => (
                <div
                  key={i}
                  className={cn(
                    "rounded-lg p-3 text-sm",
                    m.role === "user" ? "bg-muted/40" : "bg-primary/5 border border-primary/10",
                  )}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {m.role}
                    </span>
                    {m.costUsd != null && m.costUsd > 0 && (
                      <span className="text-[10px] font-mono text-muted-foreground">
                        {usd(m.costUsd)}
                      </span>
                    )}
                  </div>
                  <div className="whitespace-pre-wrap break-words">{m.content}</div>
                  {m.payload?.toolCalls && m.payload.toolCalls.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {m.payload.toolCalls.map((t, j) => (
                        <span
                          key={j}
                          className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
                        >
                          {t.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
