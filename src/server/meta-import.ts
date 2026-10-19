import { EVENT_MEMBERS } from "./agg";
import { CUSTOM_EVENT_RESULTS } from "./creative";

/**
 * Turns an Ads Manager CSV export into the rows the sync would have written for that account.
 *
 * The account is one the system-user token cannot read, so this is its only way in. Rows are keyed
 * by Meta's real ids (account, campaign, ad set, ad) and shaped exactly like synced rows, which is
 * what lets every dashboard, report, agent tool and the daily report read them unchanged.
 *
 * Pure: no database, no clock. `src/server/fns/meta-import.ts` adds the database checks and writes.
 */

export type ImportLevel = "account" | "campaign" | "adset" | "ad";
export const IMPORT_LEVELS: readonly ImportLevel[] = ["account", "campaign", "adset", "ad"];

export interface ImportIssue {
  /** Spreadsheet row number (the header is row 1), or null for a file-wide problem. */
  row: number | null;
  message: string;
}

/** `auto` picks the conversion with the most volume in the file; `none` sets no event. */
export type ResultEventChoice = "auto" | "none" | (string & {});

export interface ImportOptions {
  csv: string;
  fileName?: string | null;
  /** Used when the file has no Account ID column. */
  accountId?: string | null;
  accountName?: string | null;
  /** ISO 4217 code; overrides whatever the file says. */
  currency?: string | null;
  resultEvent?: ResultEventChoice | null;
}

/** Large enough for years of ad-level daily rows; small enough to parse inside one request. */
export const MAX_CSV_CHARS = 20 * 1024 * 1024;
const MAX_ISSUES = 50;

/** Header row of the downloadable template. Ads Manager's own English column names. */
export const IMPORT_TEMPLATE_HEADERS = [
  "Day",
  "Account ID",
  "Account name",
  "Campaign ID",
  "Campaign name",
  "Objective",
  "Ad set ID",
  "Ad set name",
  "Ad ID",
  "Ad name",
  "Amount spent (USD)",
  "Impressions",
  "Reach",
  "Clicks (all)",
  "Link clicks",
  "Landing page views",
  "Registrations Completed",
  "Purchases",
  "Purchases conversion value",
  "Leads",
] as const;

/** The conversion events an imported campaign's ad sets can be labelled with. */
export const RESULT_EVENTS = CUSTOM_EVENT_RESULTS;

// ── CSV ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * RFC 4180 parsing: quoted cells may hold delimiters, doubled quotes and newlines. The delimiter is
 * whichever of `,` `;` tab occurs most in the header line, because spreadsheet re-saves in some
 * locales turn Meta's commas into semicolons. A UTF-8 BOM (Excel's default) is dropped.
 */
export function parseCsv(text: string): { rows: string[][]; error: string | null } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delim = detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    rows.push(row);
    row = [];
    cell = "";
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (src[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") endRow();
    else if (ch === "\r") {
      if (src[i + 1] !== "\n") endRow();
    } else cell += ch;
  }
  if (quoted)
    return { rows, error: "The file ends inside a quoted cell — it is truncated or not a CSV." };
  if (cell !== "" || row.length > 0) endRow();
  return { rows, error: null };
}

function detectDelimiter(src: string): string {
  let commas = 0;
  let semis = 0;
  let tabs = 0;
  let quoted = false;
  for (const ch of src) {
    if (ch === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (ch === "\n" || ch === "\r") break;
    else if (ch === ",") commas++;
    else if (ch === ";") semis++;
    else if (ch === "\t") tabs++;
  }
  if (tabs > commas && tabs >= semis) return "\t";
  if (semis > commas) return ";";
  return ",";
}

// ── Columns ──────────────────────────────────────────────────────────────────────────────────────

type BaseField =
  | "date"
  | "reportingStarts"
  | "reportingEnds"
  | "accountId"
  | "accountName"
  | "currency"
  | "campaignId"
  | "campaignName"
  | "objective"
  | "adsetId"
  | "adsetName"
  | "adId"
  | "adName"
  | "spend"
  | "impressions"
  | "reach"
  | "clicks"
  | "linkClicks";

const BASE_COLUMNS: Record<string, BaseField> = {
  day: "date",
  date: "date",
  "reporting starts": "reportingStarts",
  "reporting ends": "reportingEnds",
  "account id": "accountId",
  "account name": "accountName",
  currency: "currency",
  "campaign id": "campaignId",
  "campaign name": "campaignName",
  objective: "objective",
  "ad set id": "adsetId",
  "ad set name": "adsetName",
  "ad id": "adId",
  "ad name": "adName",
  "amount spent": "spend",
  spend: "spend",
  impressions: "impressions",
  reach: "reach",
  "clicks (all)": "clicks",
  clicks: "clicks",
  "link clicks": "linkClicks",
};

/**
 * Ads Manager conversion columns → the event family (`EVENT_MEMBERS` in agg.ts) they are stored
 * under. Each family's value column is the same name plus " conversion value".
 */
const EVENT_COLUMNS: Record<string, string> = {
  "registrations completed": "Registrations",
  purchases: "Purchases",
  leads: "Leads",
  "adds to cart": "Add to cart",
  "checkouts initiated": "Checkouts initiated",
  "content views": "View content",
  "adds of payment info": "Add payment info",
  subscriptions: "Subscriptions",
  "trials started": "Trials started",
  searches: "Searches",
  contacts: "Contacts",
  "app installs": "App installs",
  "messaging conversations started": "Messaging conversations",
  "landing page views": "Landing page views",
  "post engagements": "Post engagements",
  "3-second video plays": "Video views",
};

type ColumnTarget =
  | { kind: "base"; field: BaseField }
  | { kind: "count" | "value"; family: string };

function targetOf(key: string): ColumnTarget | null {
  const base = BASE_COLUMNS[key];
  if (base) return { kind: "base", field: base };
  if (EVENT_COLUMNS[key]) return { kind: "count", family: EVENT_COLUMNS[key] };
  const valueOf = key.endsWith(" conversion value")
    ? key.slice(0, -" conversion value".length)
    : "";
  if (EVENT_COLUMNS[valueOf]) return { kind: "value", family: EVENT_COLUMNS[valueOf] };
  return null;
}

/**
 * Map a header to its target. The exact text is tried first so "Clicks (all)" is never read as a
 * currency suffix ("ALL" is a real ISO code); only then is a trailing 3-letter code stripped.
 */
function resolveHeader(header: string): { target: ColumnTarget; currency: string | null } | null {
  const key = header.trim().replace(/\s+/g, " ").toLowerCase();
  const exact = targetOf(key);
  if (exact) return { target: exact, currency: null };
  const m = /^(.*?)\s*\(([a-z]{3})\)$/.exec(key);
  if (!m) return null;
  const stripped = targetOf(m[1]);
  return stripped ? { target: stripped, currency: m[2].toUpperCase() } : null;
}

// ── Values ───────────────────────────────────────────────────────────────────────────────────────

/**
 * A non-negative number as Ads Manager writes it: plain decimals, optional thousands commas
 * ("1,234.56"), an optional leading currency symbol. Blank and "-" mean zero (Meta leaves a metric
 * blank when it did not occur). Returns null for anything else — a decimal comma is ambiguous
 * with a thousands separator, so it is refused rather than guessed.
 */
export function parseAmount(raw: string): number | null {
  const t = raw.trim().replace(/^[$€£]/, "");
  if (t === "" || t === "-" || t === "—") return 0;
  const plain = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) ? t.replace(/,/g, "") : t;
  if (!/^\d+(\.\d+)?$/.test(plain)) return null;
  return Number(plain);
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
function isIsoDay(s: string): boolean {
  const m = ISO_DAY.exec(s);
  if (!m) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** `123` or `act_123` → `act_123`; anything else → null. */
export function normalizeAccountId(raw: string): string | null {
  const t = raw.trim();
  const m = /^(?:act_)?(\d{5,})$/.exec(t);
  return m ? `act_${m[1]}` : null;
}

/** Ads Manager's objective names (ODAX) and the API enums → the stored API enum. */
const OBJECTIVE_BY_NAME: Record<string, string> = {
  sales: "OUTCOME_SALES",
  leads: "OUTCOME_LEADS",
  traffic: "OUTCOME_TRAFFIC",
  engagement: "OUTCOME_ENGAGEMENT",
  awareness: "OUTCOME_AWARENESS",
  "app promotion": "OUTCOME_APP_PROMOTION",
};
function normalizeObjective(raw: string): string | null {
  const t = raw.trim();
  if (t === "") return null;
  if (/^[A-Z][A-Z_]+$/.test(t)) return t;
  return OBJECTIVE_BY_NAME[t.toLowerCase()] ?? null;
}

// ── Plan ─────────────────────────────────────────────────────────────────────────────────────────

export interface Metrics {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  linkClicks: number;
  /** Event family label → count / value. */
  counts: Record<string, number>;
  values: Record<string, number>;
}

export interface PlannedInsight {
  level: ImportLevel;
  entityId: string;
  date: string;
  /** True when summed from finer rows rather than read from the file. */
  derived: boolean;
  m: Metrics;
}

export interface PlannedCampaign {
  id: string;
  name: string;
  objective: string | null;
}
export interface PlannedAdSet {
  id: string;
  campaignId: string;
  name: string;
}
export interface PlannedAd {
  id: string;
  adSetId: string;
  campaignId: string;
  name: string;
}

export interface ImportPlan {
  errors: ImportIssue[];
  warnings: ImportIssue[];
  accountId: string | null;
  accountName: string | null;
  currency: string;
  dateFrom: string | null;
  dateTo: string | null;
  levelsInFile: ImportLevel[];
  derivedLevels: ImportLevel[];
  rowsByLevel: Record<ImportLevel, number>;
  /** Ad-set optimisation event (`promoted_object.custom_event_type`), or null. */
  resultEvent: string | null;
  resultLabel: string | null;
  mappedColumns: { header: string; field: string }[];
  ignoredColumns: string[];
  campaigns: PlannedCampaign[];
  adSets: PlannedAdSet[];
  ads: PlannedAd[];
  insights: PlannedInsight[];
}

function addInto(into: Metrics, m: Metrics): void {
  into.spend += m.spend;
  into.impressions += m.impressions;
  // Reach is not additive (people overlap across ad sets and campaigns). Summing is the only
  // estimate a finer export allows; it is an upper bound, and the plan warns when it is used.
  into.reach += m.reach;
  into.clicks += m.clicks;
  into.linkClicks += m.linkClicks;
  for (const [k, v] of Object.entries(m.counts)) into.counts[k] = (into.counts[k] ?? 0) + v;
  for (const [k, v] of Object.entries(m.values)) into.values[k] = (into.values[k] ?? 0) + v;
}

/** Money as stored and shown: cents. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Parse and validate an export, then build every row the import would write. Never throws on bad
 * input: problems land in `errors` (blocking) or `warnings` (shown, not blocking).
 */
export function planImport(opts: ImportOptions): ImportPlan {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const fail = (row: number | null, message: string) => {
    if (errors.length < MAX_ISSUES) errors.push({ row, message });
  };
  const warn = (row: number | null, message: string) => {
    if (warnings.length < MAX_ISSUES) warnings.push({ row, message });
  };
  const plan: ImportPlan = {
    errors,
    warnings,
    accountId: null,
    accountName: null,
    currency: "USD",
    dateFrom: null,
    dateTo: null,
    levelsInFile: [],
    derivedLevels: [],
    rowsByLevel: { account: 0, campaign: 0, adset: 0, ad: 0 },
    resultEvent: null,
    resultLabel: null,
    mappedColumns: [],
    ignoredColumns: [],
    campaigns: [],
    adSets: [],
    ads: [],
    insights: [],
  };

  if (opts.csv.length > MAX_CSV_CHARS) {
    fail(null, `The file is over ${MAX_CSV_CHARS / 1024 / 1024} MB. Split it by date range.`);
    return plan;
  }
  const parsed = parseCsv(opts.csv);
  if (parsed.error) {
    fail(null, parsed.error);
    return plan;
  }
  const [header, ...body] = parsed.rows;
  if (!header || header.every((h) => h.trim() === "")) {
    fail(null, "The file is empty.");
    return plan;
  }

  // Resolve the header.
  const base = new Map<BaseField, number>();
  const countCols = new Map<string, number>();
  const valueCols = new Map<string, number>();
  const headerCurrencies = new Set<string>();
  header.forEach((h, i) => {
    const r = resolveHeader(h);
    if (!r) {
      if (h.trim() !== "") plan.ignoredColumns.push(h.trim());
      return;
    }
    const { target } = r;
    const slot =
      target.kind === "base"
        ? { map: base as Map<string, number>, key: target.field, field: target.field }
        : target.kind === "count"
          ? { map: countCols, key: target.family, field: `${target.family} (count)` }
          : { map: valueCols, key: target.family, field: `${target.family} (value)` };
    if (slot.map.has(slot.key)) {
      fail(
        1,
        `Two columns map to the same field "${slot.field}": "${header[slot.map.get(slot.key)!]}" and "${h}".`,
      );
      return;
    }
    slot.map.set(slot.key, i);
    plan.mappedColumns.push({ header: h.trim(), field: slot.field });
    // Only a money column's " (USD)"-style suffix names the account currency.
    if (
      r.currency &&
      (target.kind === "value" || (target.kind === "base" && target.field === "spend"))
    )
      headerCurrencies.add(r.currency);
  });
  if (!base.has("date") && !(base.has("reportingStarts") && base.has("reportingEnds")))
    fail(1, 'No "Day" column. Export with Breakdown → By time → Day.');
  if (!base.has("spend")) fail(1, 'No "Amount spent" column.');
  if (!base.has("impressions")) fail(1, 'No "Impressions" column.');
  if (!base.has("adsetId"))
    fail(
      1,
      'No "Ad set ID" column. Export from the Ad sets or Ads tab with the ID columns added — ad sets ' +
        "carry the conversion event that labels each campaign's results.",
    );
  if (!base.has("campaignId")) fail(1, 'No "Campaign ID" column.');
  if (!base.has("accountId") && !opts.accountId)
    fail(1, 'No "Account ID" column — enter the account ID instead.');
  if (headerCurrencies.size > 1)
    fail(1, `Money columns disagree on the currency: ${[...headerCurrencies].join(", ")}.`);
  if (errors.length) return plan;

  const cellOf = (row: string[], f: BaseField): string => {
    const i = base.get(f);
    return i === undefined ? "" : (row[i] ?? "").trim();
  };

  // Parse rows.
  const formAccount = opts.accountId ? normalizeAccountId(opts.accountId) : null;
  if (opts.accountId && !formAccount) fail(null, `"${opts.accountId}" is not an ad account ID.`);
  const accountIds = new Set<string>();
  const accountNames = new Set<string>();
  const fileCurrencies = new Set<string>();
  const campaigns = new Map<string, PlannedCampaign>();
  const adSets = new Map<string, PlannedAdSet>();
  const ads = new Map<string, PlannedAd>();
  const fileRows = new Map<string, PlannedInsight & { line: number }>();
  const objectivesSeen = new Set<string>();

  body.forEach((row, idx) => {
    const line = idx + 2;
    if (row.every((c) => c.trim() === "")) return;
    const ids = {
      campaign: cellOf(row, "campaignId"),
      adset: cellOf(row, "adsetId"),
      ad: cellOf(row, "adId"),
    };
    let date = cellOf(row, "date");
    if (!date) {
      const start = cellOf(row, "reportingStarts");
      const end = cellOf(row, "reportingEnds");
      if (start && end && start !== end) {
        fail(
          line,
          `Covers ${start} to ${end}, not one day. Export with Breakdown → By time → Day.`,
        );
        return;
      }
      date = start;
    }
    if (!date) {
      // Ads Manager can append a totals line with no day and no ids; it would double-count.
      if (!ids.campaign && !ids.adset && !ids.ad)
        warn(line, "Skipped a row with no day (a totals row).");
      else fail(line, "Missing the day.");
      return;
    }
    if (!isIsoDay(date)) {
      fail(line, `"${date}" is not a YYYY-MM-DD date.`);
      return;
    }

    const rawAccount = cellOf(row, "accountId");
    const accountId = rawAccount ? normalizeAccountId(rawAccount) : formAccount;
    if (!accountId) {
      fail(
        line,
        rawAccount ? `"${rawAccount}" is not an ad account ID.` : "Missing the account ID.",
      );
      return;
    }
    if (formAccount && accountId !== formAccount) {
      fail(line, `Account ${accountId} does not match the account entered (${formAccount}).`);
      return;
    }
    accountIds.add(accountId);
    const accountName = cellOf(row, "accountName");
    if (accountName) accountNames.add(accountName);
    const currency = cellOf(row, "currency").toUpperCase();
    if (currency) fileCurrencies.add(currency);

    // Excel turns 18-digit ids into "1.20211E+17", which no longer identifies anything.
    for (const [label, v] of Object.entries(ids)) {
      if (v && !/^\d+$/.test(v)) {
        fail(line, `${label} ID "${v}" is not a plain number (a spreadsheet may have rounded it).`);
        return;
      }
    }
    const level: ImportLevel = ids.ad
      ? "ad"
      : ids.adset
        ? "adset"
        : ids.campaign
          ? "campaign"
          : "account";
    if (level === "ad" && (!ids.adset || !ids.campaign)) {
      fail(line, "An ad row needs its Ad set ID and Campaign ID.");
      return;
    }
    if (level === "adset" && !ids.campaign) {
      fail(line, "An ad set row needs its Campaign ID.");
      return;
    }

    // Structure.
    if (ids.campaign) {
      const c = campaigns.get(ids.campaign) ?? { id: ids.campaign, name: "", objective: null };
      const name = cellOf(row, "campaignName");
      if (name) c.name = name;
      const objRaw = cellOf(row, "objective");
      if (objRaw) {
        const obj = normalizeObjective(objRaw);
        if (obj) c.objective = obj;
        else if (!objectivesSeen.has(objRaw)) {
          objectivesSeen.add(objRaw);
          warn(line, `Unknown objective "${objRaw}" — stored without one.`);
        }
      }
      campaigns.set(c.id, c);
    }
    if (ids.adset) {
      const s = adSets.get(ids.adset) ?? { id: ids.adset, campaignId: ids.campaign, name: "" };
      if (s.campaignId !== ids.campaign) {
        fail(
          line,
          `Ad set ${ids.adset} appears under two campaigns (${s.campaignId}, ${ids.campaign}).`,
        );
        return;
      }
      const name = cellOf(row, "adsetName");
      if (name) s.name = name;
      adSets.set(s.id, s);
    }
    if (ids.ad) {
      const a = ads.get(ids.ad) ?? {
        id: ids.ad,
        adSetId: ids.adset,
        campaignId: ids.campaign,
        name: "",
      };
      if (a.adSetId !== ids.adset) {
        fail(line, `Ad ${ids.ad} appears under two ad sets (${a.adSetId}, ${ids.adset}).`);
        return;
      }
      const name = cellOf(row, "adName");
      if (name) a.name = name;
      ads.set(a.id, a);
    }

    // Metrics.
    const num = (col: number | undefined, what: string, integer: boolean): number | null => {
      if (col === undefined) return 0;
      const raw = (row[col] ?? "").trim();
      const v = parseAmount(raw);
      if (v === null) {
        fail(line, `${what} "${raw}" is not a number.`);
        return null;
      }
      if (integer && !Number.isInteger(v)) {
        fail(line, `${what} "${raw}" must be a whole number.`);
        return null;
      }
      return v;
    };
    const spend = num(base.get("spend"), "Amount spent", false);
    const impressions = num(base.get("impressions"), "Impressions", true);
    const reach = num(base.get("reach"), "Reach", true);
    const clicks = num(base.get("clicks"), "Clicks", true);
    const linkClicks = num(base.get("linkClicks"), "Link clicks", true);
    if (
      spend === null ||
      impressions === null ||
      reach === null ||
      clicks === null ||
      linkClicks === null
    )
      return;
    const m: Metrics = { spend, impressions, reach, clicks, linkClicks, counts: {}, values: {} };
    for (const [family, col] of countCols) {
      const v = num(col, family, false);
      if (v === null) return;
      if (v > 0) m.counts[family] = v;
    }
    for (const [family, col] of valueCols) {
      const v = num(col, `${family} value`, false);
      if (v === null) return;
      if (v > 0) m.values[family] = v;
    }

    const entityId =
      level === "ad"
        ? ids.ad
        : level === "adset"
          ? ids.adset
          : level === "campaign"
            ? ids.campaign
            : accountId;
    const key = `${level}|${entityId}|${date}`;
    const prev = fileRows.get(key);
    if (prev) {
      fail(line, `Duplicate ${level} row for ${entityId} on ${date} (also row ${prev.line}).`);
      return;
    }
    fileRows.set(key, { level, entityId, date, derived: false, m, line });
  });

  if (accountIds.size > 1)
    fail(null, `One account per file; this one has ${[...accountIds].join(", ")}.`);
  if (fileRows.size === 0 && errors.length === 0) fail(null, "The file has no data rows.");

  // Currency: the form wins, then the header suffix, then a Currency column.
  const formCurrency = opts.currency?.trim().toUpperCase() || null;
  if (formCurrency && !/^[A-Z]{3}$/.test(formCurrency))
    fail(null, `"${opts.currency}" is not a currency code.`);
  const fromFile = new Set([...headerCurrencies, ...fileCurrencies]);
  if (!formCurrency && fromFile.size > 1)
    fail(null, `The file mixes currencies: ${[...fromFile].join(", ")}.`);
  plan.currency = formCurrency ?? [...fromFile][0] ?? "USD";

  if (errors.length) return plan;

  const accountId = [...accountIds][0];
  plan.accountId = accountId;
  plan.accountName = [...accountNames].pop() ?? (opts.accountName?.trim() || null);
  if (accountNames.size > 1)
    warn(
      null,
      `The file names the account ${accountNames.size} ways; using "${plan.accountName}".`,
    );

  for (const c of campaigns.values()) if (!c.name) c.name = c.id;
  for (const s of adSets.values()) if (!s.name) s.name = s.id;
  for (const a of ads.values()) if (!a.name) a.name = a.id;
  const withAdSet = new Set([...adSets.values()].map((s) => s.campaignId));
  for (const c of campaigns.values())
    if (!withAdSet.has(c.id))
      fail(null, `Campaign ${c.id} (${c.name}) has no ad set rows. Export at ad set or ad level.`);
  if (errors.length) return plan;

  // Fill in every missing parent row by summing its children, finest level first. A parent row the
  // file does contain wins; when both exist they are compared so a partial export is visible.
  const parentOf = (r: PlannedInsight): { level: ImportLevel; id: string } | null => {
    if (r.level === "ad") return { level: "adset", id: ads.get(r.entityId)!.adSetId };
    if (r.level === "adset") return { level: "campaign", id: adSets.get(r.entityId)!.campaignId };
    if (r.level === "campaign") return { level: "account", id: accountId };
    return null;
  };
  const all = new Map<string, PlannedInsight>();
  for (const [k, r] of fileRows)
    all.set(k, { level: r.level, entityId: r.entityId, date: r.date, derived: false, m: r.m });
  const derivedLevels = new Set<ImportLevel>();
  let summedReach = false;
  for (const level of ["ad", "adset", "campaign"] as const) {
    const sums = new Map<string, PlannedInsight>();
    for (const r of all.values()) {
      if (r.level !== level) continue;
      const p = parentOf(r)!;
      const key = `${p.level}|${p.id}|${r.date}`;
      const s = sums.get(key) ?? {
        level: p.level,
        entityId: p.id,
        date: r.date,
        derived: true,
        m: { spend: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, counts: {}, values: {} },
      };
      addInto(s.m, r.m);
      sums.set(key, s);
    }
    for (const [key, s] of sums) {
      const own = all.get(key);
      if (!own) {
        all.set(key, s);
        derivedLevels.add(s.level);
        if (s.m.reach > 0) summedReach = true;
        continue;
      }
      if (Math.abs(own.m.spend - s.m.spend) > Math.max(0.01, own.m.spend * 0.005))
        warn(
          null,
          `${own.level} ${own.entityId} on ${own.date}: the file says ${round2(own.m.spend)} spent but its ` +
            `${level} rows add up to ${round2(s.m.spend)}. The ${own.level} row is kept.`,
        );
    }
  }
  if (summedReach)
    warn(
      null,
      `Reach for ${[...derivedLevels].join(", ")} rows is summed from finer rows, which over-counts people ` +
        "reached by more than one ad. Add rows at those levels to the file for Meta's exact reach.",
    );

  // Result event: the form's choice, else the conversion with the most volume in the file.
  const totals = new Map<string, number>();
  for (const r of all.values())
    if (r.level === "account")
      for (const [k, v] of Object.entries(r.m.counts)) totals.set(k, (totals.get(k) ?? 0) + v);
  const choice = opts.resultEvent ?? "auto";
  if (choice === "auto") {
    let best: { event: string; label: string; n: number } | null = null;
    for (const e of RESULT_EVENTS) {
      const n = totals.get(e.label) ?? 0;
      if (n > 0 && (!best || n > best.n)) best = { ...e, n };
    }
    plan.resultEvent = best?.event ?? null;
    plan.resultLabel = best?.label ?? null;
  } else if (choice !== "none") {
    const e = RESULT_EVENTS.find((x) => x.event === choice);
    if (!e) fail(null, `Unknown result event "${choice}".`);
    else {
      plan.resultEvent = e.event;
      plan.resultLabel = e.label;
      if (!totals.get(e.label))
        warn(null, `No ${e.label} in the file, so every campaign will show 0 results.`);
    }
  }

  const insights = [...all.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      IMPORT_LEVELS.indexOf(a.level) - IMPORT_LEVELS.indexOf(b.level) ||
      a.entityId.localeCompare(b.entityId),
  );
  const levelsInFile = new Set([...fileRows.values()].map((r) => r.level));
  plan.levelsInFile = IMPORT_LEVELS.filter((l) => levelsInFile.has(l));
  plan.derivedLevels = IMPORT_LEVELS.filter((l) => derivedLevels.has(l));
  for (const r of insights) plan.rowsByLevel[r.level]++;
  plan.dateFrom = insights[0]?.date ?? null;
  plan.dateTo = insights[insights.length - 1]?.date ?? null;
  plan.campaigns = [...campaigns.values()];
  plan.adSets = [...adSets.values()];
  plan.ads = [...ads.values()];
  plan.insights = insights;
  return plan;
}

// ── Database row shapes ──────────────────────────────────────────────────────────────────────────

const div = (a: number, b: number): number => (b > 0 ? a / b : 0);

/**
 * Meta's `actions` shape: one entry per event family, under the family's preferred alias. One alias
 * only — readers take the first alias PRESENT, so a second alias would be read instead or counted
 * twice. Zero events are omitted, as Meta omits them.
 */
function actionList(
  byFamily: Record<string, number>,
): { action_type: string; value: string }[] | null {
  const out = Object.entries(byFamily)
    .filter(([, v]) => v > 0)
    .map(([family, v]) => ({ action_type: EVENT_MEMBERS[family][0], value: String(v) }));
  return out.length ? out : null;
}

/** Every `insights_daily` row the plan writes, shaped like `normalizeInsightRow`'s output. */
export function insightRowsOf(plan: ImportPlan) {
  const accountId = plan.accountId!;
  const adById = new Map(plan.ads.map((a) => [a.id, a]));
  const campaignOfAdSet = new Map(plan.adSets.map((s) => [s.id, s.campaignId]));
  return plan.insights.map((r) => {
    const { m } = r;
    const counts = { ...m.counts };
    if (m.linkClicks > 0) counts["Link clicks"] = m.linkClicks;
    const actions = actionList(counts);
    const actionValues = actionList(m.values);
    const purchaseValue = m.values.Purchases ?? 0;
    const ad = r.level === "ad" ? adById.get(r.entityId) : undefined;
    const adSetId = r.level === "adset" ? r.entityId : ad?.adSetId;
    const campaignId =
      r.level === "campaign" ? r.entityId : adSetId ? campaignOfAdSet.get(adSetId) : undefined;
    return {
      level: r.level,
      entityId: r.entityId,
      date: r.date,
      accountId,
      spend: round2(m.spend),
      impressions: m.impressions,
      reach: m.reach,
      clicks: m.clicks,
      inlineLinkClicks: m.linkClicks,
      ctr: div(m.clicks, m.impressions) * 100,
      cpc: div(m.spend, m.clicks),
      cpm: div(m.spend, m.impressions) * 1000,
      conversions: m.counts.Purchases ?? 0,
      conversionValues: purchaseValue,
      purchaseRoas: div(purchaseValue, m.spend),
      actions,
      actionValues,
      // Meta-named fields, so report columns that read `raw` resolve exactly as for synced rows.
      // Undefined keys vanish when jsonb is serialised, as Meta omits fields that do not apply.
      raw: {
        account_id: accountId.replace(/^act_/, ""),
        account_name: plan.accountName ?? undefined,
        account_currency: plan.currency,
        campaign_id: campaignId,
        adset_id: adSetId,
        ad_id: ad?.id,
        date_start: r.date,
        date_stop: r.date,
        spend: String(round2(m.spend)),
        impressions: String(m.impressions),
        reach: String(m.reach),
        clicks: String(m.clicks),
        inline_link_clicks: String(m.linkClicks),
        actions: actions ?? undefined,
        action_values: actionValues ?? undefined,
      },
      frequency: m.reach > 0 ? m.impressions / m.reach : null,
    };
  });
}

/** The result count of one planned row under the plan's result event (0 when none is set). */
export function resultsOf(r: PlannedInsight, plan: ImportPlan): number {
  return plan.resultLabel ? (r.m.counts[plan.resultLabel] ?? 0) : 0;
}
