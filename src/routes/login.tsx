import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AuthCard } from "@/components/auth/AuthCard";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Sign in — MetaConsole" }] }),
  validateSearch: (s: Record<string, unknown>): { error?: string } =>
    typeof s.error === "string" ? { error: s.error } : {},
  component: Login,
});

const ERROR_TEXT: Record<string, string> = {};

function Login() {
  const { error } = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/auth/password/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) window.location.href = "/";
      else setErr(data.error ?? "Sign in failed.");
    } catch {
      setErr("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const banner = err ?? (error ? (ERROR_TEXT[error] ?? error) : null);

  return (
    <AuthCard title="Sign in" subtitle="MetaConsole — Meta Ads analytics">
      <div className="space-y-4">
        {banner && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {banner}
          </div>
        )}
        <form onSubmit={submit} className="space-y-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            autoComplete="email"
            className="h-10 w-full rounded-md border border-border bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            className="h-10 w-full rounded-md border border-border bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <button
            type="submit"
            disabled={busy || !email || !password}
            className="h-10 w-full rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="text-center text-xs text-muted-foreground">
          No account?{" "}
          <Link to="/signup" className="text-primary hover:underline font-medium">
            Create one
          </Link>
        </p>
      </div>
    </AuthCard>
  );
}
