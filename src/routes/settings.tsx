import { createFileRoute, useRouter, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import {
  getSettings,
  resetAndResync,
  saveChatSettings,
  saveCredentialsForm,
  saveNotionSettings,
  syncNotionNow,
  syncNow,
  testConnection,
} from "@/lib/api/settings";
import { getCurrentUser } from "@/lib/api/auth";
import { isAdmin } from "@/lib/auth/roles";
import { CHAT_MODELS, CHAT_EFFORTS } from "@/lib/chat-options";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Database,
  KeyRound,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "Settings — MetaConsole" }] }),
  loader: async () => {
    const me = await getCurrentUser();
    if (!isAdmin(me?.role)) throw redirect({ to: "/" });
    return await getSettings();
  },
  component: Settings,
});

function Settings() {
  const s = Route.useLoaderData();
  const router = useRouter();
  const [form, setForm] = useState({
    appId: s.appId,
    appSecret: "",
    token: "",
    businessId: s.businessId,
    accountIds: s.accountIds.join(", "),
  });
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [notion, setNotion] = useState({ token: "", board: s.notion.dbId });
  const [notionMsg, setNotionMsg] = useState<string | null>(null);
  const [chat, setChat] = useState({ token: "", model: s.chat.model, effort: s.chat.effort });
  const [chatMsg, setChatMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  // While a resync is in flight, keep the loader data (counts, last sync) fresh.
  useEffect(() => {
    if (!s.syncRunning) return;
    const t = setInterval(() => void router.invalidate(), 5000);
    return () => clearInterval(t);
  }, [s.syncRunning, router]);

  const onSave = async () => {
    setSaving(true);
    await saveCredentialsForm({ data: form });
    setSaving(false);
    setForm((f) => ({ ...f, appSecret: "", token: "" }));
    await router.invalidate();
  };
  const onTest = async () => {
    setTestResult("Testing…");
    const r = await testConnection();
    setTestResult(
      r.isValid
        ? `Valid · scopes: ${r.scopes.join(", ") || "none"}`
        : `Invalid: ${r.error ?? "token rejected"}`,
    );
    await router.invalidate();
  };
  const onReset = async () => {
    if (
      !window.confirm(
        "Delete ALL synced data (accounts, campaigns, stats) and re-download everything with the current credentials?",
      )
    )
      return;
    setResetting(true);
    setResetMsg(null);
    try {
      const r = await resetAndResync();
      setResetMsg(
        r.syncStarted
          ? "Data wiped — full resync running in background."
          : "Data wiped — a sync was already running; it will repopulate.",
      );
    } catch (e) {
      setResetMsg(`Reset failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setResetting(false);
      await router.invalidate();
    }
  };
  const onSyncNow = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await syncNow();
      setSyncMsg(
        r.started
          ? "Sync started — pulling the latest from Meta in the background."
          : "A sync is already running.",
      );
    } catch (e) {
      setSyncMsg(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
      await router.invalidate();
    }
  };
  const onNotionSave = async () => {
    setNotionMsg("Saving…");
    const r = await saveNotionSettings({ data: notion });
    if (!r.ok) {
      setNotionMsg(r.error ?? "Save failed");
      return;
    }
    setNotion((f) => ({ ...f, token: "" }));
    setNotionMsg("Saved. Syncing…");
    const sync = await syncNotionNow();
    setNotionMsg(sync.ok ? `Synced ${sync.clients} clients.` : `Sync failed: ${sync.error}`);
    await router.invalidate();
  };
  const onNotionSync = async () => {
    setNotionMsg("Syncing…");
    const r = await syncNotionNow();
    setNotionMsg(r.ok ? `Synced ${r.clients} clients.` : `Sync failed: ${r.error}`);
    await router.invalidate();
  };
  const onChatSave = async () => {
    setChatMsg("Saving…");
    await saveChatSettings({ data: chat });
    setChat((f) => ({ ...f, token: "" }));
    setChatMsg("Saved.");
    await router.invalidate();
  };

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-3xl">
      <PageHeader title="Settings" description="Meta Marketing API credentials and sync status." />

      <section className="rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-md bg-primary/10 grid place-items-center">
            <Bot className="size-4 text-primary" />
          </div>
          <h3 className="text-sm font-semibold flex-1">Assistant · Claude</h3>
          {s.chat.configured && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
              <CheckCircle2 className="size-3.5" /> Key set
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Powers the natural-language chat on the home page. The model only orchestrates; all
          figures come from your synced data.
        </p>
        <Input
          label={`Anthropic API key ${s.chat.configured ? "(set — leave blank to keep)" : ""}`}
          type="password"
          value={chat.token}
          onChange={(v) => setChat({ ...chat, token: v })}
        />
        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Model"
            value={chat.model}
            options={[...CHAT_MODELS]}
            onChange={(v) => setChat({ ...chat, model: v })}
          />
          <Select
            label="Reasoning effort"
            value={chat.effort}
            options={[...CHAT_EFFORTS]}
            onChange={(v) => setChat({ ...chat, effort: v })}
          />
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={onChatSave}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-xs font-medium"
          >
            Save
          </button>
          <span className="text-xs text-muted-foreground">
            {chatMsg ?? "Higher effort = deeper reasoning but slower/costlier."}
          </span>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-md bg-primary/10 grid place-items-center">
            <KeyRound className="size-4 text-primary" />
          </div>
          <h3 className="text-sm font-semibold flex-1">System User Credentials</h3>
          {s.token && (
            <span
              className={`inline-flex items-center gap-1 text-xs font-medium ${s.token.isValid ? "text-success" : "text-destructive"}`}
            >
              {s.token.isValid ? (
                <CheckCircle2 className="size-3.5" />
              ) : (
                <XCircle className="size-3.5" />
              )}
              {s.token.isValid ? "Connected" : "Invalid"}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="App ID"
            value={form.appId}
            onChange={(v) => setForm({ ...form, appId: v })}
          />
          <Input
            label="Business Manager ID"
            value={form.businessId}
            onChange={(v) => setForm({ ...form, businessId: v })}
          />
          <Input
            label={`App Secret ${s.hasSecret ? "(set — leave blank to keep)" : ""}`}
            type="password"
            value={form.appSecret}
            onChange={(v) => setForm({ ...form, appSecret: v })}
          />
          <Input
            label={`System User Token ${s.hasToken ? "(set — leave blank to keep)" : ""}`}
            type="password"
            value={form.token}
            onChange={(v) => setForm({ ...form, token: v })}
          />
          <div className="col-span-2">
            <Input
              label="Ad account IDs (comma-separated; blank = all owned)"
              value={form.accountIds}
              onChange={(v) => setForm({ ...form, accountIds: v })}
            />
          </div>
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={onSave}
            disabled={saving}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save credentials"}
          </button>
          <button
            onClick={onTest}
            className="h-9 px-4 rounded-md border border-border text-xs font-medium"
          >
            Test connection
          </button>
          {testResult && <span className="text-xs text-muted-foreground">{testResult}</span>}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-md bg-primary/10 grid place-items-center">
            <RefreshCw className="size-4 text-primary" />
          </div>
          <h3 className="text-sm font-semibold flex-1">Sync status</h3>
          {s.syncRunning && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
              <RefreshCw className="size-3.5 animate-spin" /> Syncing…
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4 text-xs">
          <Field label="Accounts tracked" value={s.sync ? String(s.sync.accounts) : "—"} />
          <Field label="Last insights sync" value={s.sync?.lastInsightsSync ?? "never"} />
          <Field label="Accounts in error" value={s.sync ? String(s.sync.errors) : "—"} />
          <Field label="API version" value={s.apiVersion} />
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={onSyncNow}
            disabled={syncing || s.syncRunning}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <RefreshCw className={`size-3.5 ${syncing || s.syncRunning ? "animate-spin" : ""}`} />
            {s.syncRunning ? "Syncing…" : "Sync now"}
          </button>
          <span className="text-xs text-muted-foreground">
            {syncMsg ?? "Pull the latest data from Meta now (runs in the background; ~minutes)."}
          </span>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-md bg-primary/10 grid place-items-center">
            <Activity className="size-4 text-primary" />
          </div>
          <h3 className="text-sm font-semibold flex-1">Sync health</h3>
          {s.health.rateLimitedLastHour > 0 ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-500">
              <AlertTriangle className="size-3.5" /> {s.health.rateLimitedLastHour} rate-limit
              {s.health.rateLimitedLastHour === 1 ? "" : "s"} / hr
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
              <CheckCircle2 className="size-3.5" /> no recent throttling
            </span>
          )}
        </div>

        {s.health.accountErrors.length > 0 && (
          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase text-muted-foreground">
              Accounts in error ({s.health.accountErrors.length})
            </div>
            <div className="max-h-32 overflow-auto rounded-md border border-border divide-y divide-border">
              {s.health.accountErrors.map((a) => (
                <div key={a.accountId} className="flex items-start gap-2 px-3 py-1.5 text-[11px]">
                  <span className="font-mono shrink-0">{a.accountId}</span>
                  <span className="truncate text-muted-foreground">{a.error}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-1">
          <div className="text-[11px] font-medium uppercase text-muted-foreground">
            Recent API events
          </div>
          {s.health.events.length === 0 ? (
            <p className="text-xs text-muted-foreground">No rate-limit or error events recorded.</p>
          ) : (
            <div className="max-h-64 overflow-auto rounded-md border border-border divide-y divide-border">
              {s.health.events.map((e, i) => (
                <div
                  key={`${e.at}-${i}`}
                  className="flex items-center gap-2 px-3 py-1.5 text-[11px]"
                >
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${
                      e.kind === "rate_limit"
                        ? "bg-amber-500/10 text-amber-500"
                        : "bg-destructive/10 text-destructive"
                    }`}
                  >
                    {e.kind === "rate_limit" ? (e.code === 0 ? "throttle" : `#${e.code}`) : "error"}
                  </span>
                  {e.accountId && <span className="shrink-0 font-mono">{e.accountId}</span>}
                  <span className="flex-1 truncate text-muted-foreground">{e.message}</span>
                  {e.pressure ? (
                    <span className="shrink-0 text-muted-foreground">{e.pressure}%</span>
                  ) : null}
                  {e.retryAfterMin ? (
                    <span className="shrink-0 text-amber-500">~{e.retryAfterMin}m</span>
                  ) : null}
                  <span className="shrink-0 text-muted-foreground/60">
                    {new Date(e.at).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-md bg-primary/10 grid place-items-center">
            <Database className="size-4 text-primary" />
          </div>
          <h3 className="text-sm font-semibold flex-1">Notion · Client board</h3>
          {s.notion.configured && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
              <CheckCircle2 className="size-3.5" /> {s.notion.clients} clients
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Input
            label={`Integration token ${s.notion.configured ? "(set — leave blank to keep)" : ""}`}
            type="password"
            value={notion.token}
            onChange={(v) => setNotion({ ...notion, token: v })}
          />
          <Input
            label="Board URL or database ID"
            value={notion.board}
            onChange={(v) => setNotion({ ...notion, board: v })}
          />
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={onNotionSave}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-xs font-medium"
          >
            Save & sync
          </button>
          <button
            onClick={onNotionSync}
            disabled={!s.notion.configured}
            className="h-9 px-4 rounded-md border border-border text-xs font-medium disabled:opacity-50"
          >
            Sync now
          </button>
          <span className="text-xs text-muted-foreground">
            {notionMsg ?? (s.notion.lastSync ? `Last sync: ${s.notion.lastSync}` : "")}
          </span>
        </div>
      </section>

      <section className="rounded-xl border border-destructive/40 bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-md bg-destructive/10 grid place-items-center">
            <Trash2 className="size-4 text-destructive" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold">Reset synced data</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Deletes all ad accounts, campaigns, and stats, then re-downloads everything (90-day
              backfill) with the saved credentials. Credentials are kept.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onReset}
            disabled={resetting || s.syncRunning}
            className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-xs font-medium disabled:opacity-50"
          >
            {resetting ? "Wiping…" : "Reset & resync"}
          </button>
          {resetMsg && <span className="text-xs text-muted-foreground">{resetMsg}</span>}
        </div>
      </section>
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full h-9 rounded-md border border-border bg-background px-3 text-xs font-mono"
      />
    </label>
  );
}
function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full h-9 rounded-md border border-border bg-background px-3 text-xs font-mono"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </div>
      <div className="font-mono mt-1 truncate">{value}</div>
    </div>
  );
}
