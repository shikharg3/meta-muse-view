import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { getSettings, saveCredentialsForm, testConnection } from "@/lib/api/settings";
import { CheckCircle2, KeyRound, RefreshCw, XCircle } from "lucide-react";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "Settings — MetaConsole" }] }),
  loader: async () => await getSettings(),
  component: Settings,
});

function Settings() {
  const s = Route.useLoaderData();
  const router = useRouter();
  const [form, setForm] = useState({ appId: s.appId, appSecret: "", token: "", businessId: s.businessId, accountIds: s.accountIds.join(", ") });
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

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
    setTestResult(r.isValid ? `Valid · scopes: ${r.scopes.join(", ") || "none"}` : `Invalid: ${r.error ?? "token rejected"}`);
    await router.invalidate();
  };

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-3xl">
      <PageHeader title="Settings" description="Meta Marketing API credentials and sync status." />

      <section className="rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-md bg-primary/10 grid place-items-center"><KeyRound className="size-4 text-primary" /></div>
          <h3 className="text-sm font-semibold flex-1">System User Credentials</h3>
          {s.token && (
            <span className={`inline-flex items-center gap-1 text-xs font-medium ${s.token.isValid ? "text-success" : "text-destructive"}`}>
              {s.token.isValid ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
              {s.token.isValid ? "Connected" : "Invalid"}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Input label="App ID" value={form.appId} onChange={(v) => setForm({ ...form, appId: v })} />
          <Input label="Business Manager ID" value={form.businessId} onChange={(v) => setForm({ ...form, businessId: v })} />
          <Input label={`App Secret ${s.hasSecret ? "(set — leave blank to keep)" : ""}`} type="password" value={form.appSecret} onChange={(v) => setForm({ ...form, appSecret: v })} />
          <Input label={`System User Token ${s.hasToken ? "(set — leave blank to keep)" : ""}`} type="password" value={form.token} onChange={(v) => setForm({ ...form, token: v })} />
          <div className="col-span-2"><Input label="Ad account IDs (comma-separated; blank = all owned)" value={form.accountIds} onChange={(v) => setForm({ ...form, accountIds: v })} /></div>
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button onClick={onSave} disabled={saving} className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50">{saving ? "Saving…" : "Save credentials"}</button>
          <button onClick={onTest} className="h-9 px-4 rounded-md border border-border text-xs font-medium">Test connection</button>
          {testResult && <span className="text-xs text-muted-foreground">{testResult}</span>}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-md bg-primary/10 grid place-items-center"><RefreshCw className="size-4 text-primary" /></div>
          <h3 className="text-sm font-semibold">Sync status</h3>
        </div>
        <div className="grid grid-cols-2 gap-4 text-xs">
          <Field label="Accounts tracked" value={s.sync ? String(s.sync.accounts) : "—"} />
          <Field label="Last insights sync" value={s.sync?.lastInsightsSync ?? "never"} />
          <Field label="Accounts in error" value={s.sync ? String(s.sync.errors) : "—"} />
          <Field label="API version" value={s.apiVersion} />
        </div>
      </section>
    </div>
  );
}

function Input({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full h-9 rounded-md border border-border bg-background px-3 text-xs font-mono" />
    </label>
  );
}
function Field({ label, value }: { label: string; value: string }) {
  return (<div><div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</div><div className="font-mono mt-1 truncate">{value}</div></div>);
}
