import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { businessManager } from "@/lib/mock-data";
import { CheckCircle2, KeyRound, RefreshCw } from "lucide-react";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — MetaConsole" },
      { name: "description", content: "Integration and access configuration for the Meta Marketing API." },
    ],
  }),
  component: Settings,
});

function Settings() {
  return (
    <div className="p-6 md:p-8 space-y-6 max-w-3xl">
      <PageHeader title="Settings" description="Internal configuration. UI only — wire to Meta Marketing API to enable." />

      <section className="rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="size-9 rounded-md bg-primary/10 grid place-items-center">
            <KeyRound className="size-4 text-primary" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold">System User Token</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Long-lived token from the Business Manager system user.</p>
          </div>
          <span className="inline-flex items-center gap-1 text-xs text-success font-medium">
            <CheckCircle2 className="size-3.5" /> Connected (mock)
          </span>
        </div>
        <div className="grid grid-cols-2 gap-4 pt-2 text-xs">
          <Field label="Business Manager ID" value={businessManager.id} />
          <Field label="Business Manager Name" value={businessManager.name} />
          <Field label="Token type" value="System user · long-lived" />
          <Field label="Granted ad accounts" value={`${businessManager.accountCount}`} />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="size-9 rounded-md bg-primary/10 grid place-items-center">
            <RefreshCw className="size-4 text-primary" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold">Data refresh</h3>
            <p className="text-xs text-muted-foreground mt-0.5">How often insights are pulled from the Marketing API.</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 text-xs">
          <Field label="Refresh cadence" value="Every 30 minutes" />
          <Field label="Last sync" value="2 minutes ago" />
          <Field label="Insights window" value="Last 90 days" />
          <Field label="Attribution" value="7-day click, 1-day view" />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-6">
        <h3 className="text-sm font-semibold mb-3">Team access</h3>
        <ul className="divide-y divide-border text-sm">
          {[
            { name: "Jordan Dash", role: "Admin" },
            { name: "Priya Rao", role: "Analyst" },
            { name: "Marcus Lee", role: "Viewer" },
          ].map((m) => (
            <li key={m.name} className="flex items-center justify-between py-2.5">
              <div className="flex items-center gap-3">
                <div className="size-8 rounded-full bg-muted grid place-items-center text-[10px] font-semibold">
                  {m.name.split(" ").map((p) => p[0]).join("")}
                </div>
                <span className="font-medium">{m.name}</span>
              </div>
              <span className="text-xs text-muted-foreground font-mono">{m.role}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</div>
      <div className="font-mono mt-1 truncate">{value}</div>
    </div>
  );
}
