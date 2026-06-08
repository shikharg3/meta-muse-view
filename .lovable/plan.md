## Meta Ads Analytics Dashboard — UI Only

Internal team tool. No Marketing API wiring yet — every screen is populated from a shared mock-data module so it looks production-ready and can be swapped for real API responses later.

**Design direction:** "Precision Dark Grid" (dark zinc surfaces, blue accent, Inter + JetBrains Mono for numbers). Best fit for a data-dense internal tool.

### Pages (routes under `src/routes/`)

```text
/                  Overview        KPI tiles, spend & conversion trend, top accounts, top campaigns, breakdown by objective/placement
/accounts          Accounts        Sortable table of all 54 ad accounts with sparklines
/accounts/$id      Account detail  Per-account KPIs, trend chart, its campaigns
/campaigns         Explorer        Hierarchical Campaign → Ad Set → Ad tree with expand/collapse, filters, column picker
/creatives         Creative gallery Thumbnail grid with CTR/spend overlays, type/status filters
/audiences         Audiences       Breakdown panels: age, gender, placement, device, country (bars + tables)
/settings          Settings        Static placeholder: BM ID, system user token status, refresh cadence
```

### Shared shell
- `src/components/layout/AppSidebar.tsx` — 6 nav items + user footer, collapsible via shadcn sidebar
- `src/components/layout/TopBar.tsx` — BM/account switcher (mock), date-range picker button, search, Export button
- `src/routes/__root.tsx` wraps `<Outlet />` in `SidebarProvider` + shell

### Reusable components
- `KpiCard` (label, value, delta, mini sparkline)
- `TrendChart` (recharts area/line)
- `DataTable` (sortable header, status pill, monospaced numerics)
- `HierarchyRow` (indented row with expand chevron — campaigns explorer)
- `CreativeCard` (square thumbnail, hover overlay with metrics)
- `BreakdownBar` (horizontal bar with label + value)
- `StatusPill`, `DeltaBadge`

### Mock data
`src/lib/mock-data.ts` exports: `accounts` (54 entries), `campaigns`, `adSets`, `ads`, `creatives`, `timeSeries`, `breakdowns`. Realistic ad-account names (e.g. "Phoenix Retail – US Main"), spend/ROAS/CPM/CTR/conversions, daily series for the last 30 days. Deterministic seeded numbers so refresh doesn't shuffle.

### Design system
- Update `src/styles.css` tokens to dark zinc surfaces + blue accent (from the chosen direction) — light mode kept but app defaults to dark.
- Load Inter + JetBrains Mono via `<link>` in `__root.tsx` head; register `--font-sans` / `--font-mono` in `@theme`.
- Numbers/IDs use mono; everything else Inter.

### Charts
- `recharts` (install via `bun add recharts`) for trend line/area, sparklines, breakdown bars.

### Out of scope (UI only)
- No Meta Marketing API calls, no system user token handling, no Lovable Cloud, no auth.
- "Export Report" and "Refresh Data" buttons are visual only.
- A short comment in `mock-data.ts` marks the swap point for real API integration later.
