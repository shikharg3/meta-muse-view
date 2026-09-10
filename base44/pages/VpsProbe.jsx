import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { callVps, VpsCallError } from '@/api/vps';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

/**
 * Connection probe for the VPS bridge. Temporary — delete it once real pages exist.
 *
 * Every hop is exercised in one click: Base44 session -> the `vps` backend function -> its bearer
 * secret -> the VPS `/api/v1` gate -> actor resolution against the VPS `users` table -> Postgres.
 * A failure at any hop shows up as a distinct `code`, which is the point of having it.
 */

const CHECKS = [
  {
    op: 'getBusinessSummary',
    label: 'Business summary',
    why: 'No input, no role needed — proves the whole chain end to end.',
    render: (d) => `${d.accountCount} ad accounts · business ${d.businessId}`,
  },
  {
    op: 'getCurrentUser',
    label: 'Who the VPS thinks I am',
    why: 'The authoritative role and approval status. Base44 asserts the email; the VPS decides the rest.',
    render: (d) => (d ? `${d.email} · role=${d.role} · status=${d.status}` : 'not recognised'),
  },
  {
    op: 'getMetaHealth',
    label: 'Data freshness',
    why: 'Requires an approved account.',
    render: (d) => `token ${d.tokenValid ? 'valid' : 'INVALID'} · tier ${d.tier} · refreshed ${d.lastRefreshAt}`,
  },
  {
    op: 'listClients',
    label: 'Clients',
    why: 'A real scoped read.',
    render: (d) => `${d.length} clients`,
  },
  {
    op: 'getOverview',
    data: { days: 7 },
    label: 'Overview, last 7 days',
    why: 'A heavy op with validated input.',
    render: (d) => `spend $${d.kpis.spend.toFixed(2)} · ${d.kpis.impressions.toLocaleString()} impressions`,
  },
  {
    op: 'listInfraProfiles',
    label: 'Infra profiles (admin only)',
    why: 'Expected to fail with `forbidden` unless the VPS says you are an admin.',
    render: (d) => `${d.length} profiles`,
  },
];

function Check({ check }) {
  const { op, data, label, why, render } = check;
  const q = useQuery({
    queryKey: ['probe', op],
    queryFn: () => callVps(op, data),
    retry: false,
  });

  let tone = 'secondary';
  let body = 'checking…';
  if (q.isError) {
    const e = q.error;
    const code = e instanceof VpsCallError ? e.info.code : 'error';
    // `forbidden` on an admin op is the correct answer for a non-admin, not a broken bridge.
    tone = code === 'forbidden' ? 'outline' : 'destructive';
    body = `${code} — ${e.message}`;
  } else if (q.isSuccess) {
    tone = 'default';
    try {
      body = render(q.data);
    } catch {
      // A shape that does not match is itself the finding; show it rather than crashing the page.
      body = JSON.stringify(q.data).slice(0, 200);
    }
  }

  return (
    <div className="border-b py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{label}</span>
        <Badge variant={tone}>{op}</Badge>
      </div>
      <div className="mt-1 font-mono text-sm break-all">{body}</div>
      <div className="mt-1 text-xs text-muted-foreground">{why}</div>
    </div>
  );
}

export default function VpsProbe() {
  const [run, setRun] = useState(false);

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>VPS bridge probe</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Calls the DigitalOcean backend through the <code>vps</code> function. The database, the
            Meta sync and every business rule stay on the VPS; this app only renders.
          </p>
          {run ? (
            <div className="mt-4">
              {CHECKS.map((c) => (
                <Check key={c.op} check={c} />
              ))}
            </div>
          ) : (
            <Button className="mt-4" onClick={() => setRun(true)}>
              Run the checks
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
