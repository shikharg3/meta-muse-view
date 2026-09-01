import {
  buildStatusLines,
  STALE_AFTER_MIN,
  WRITE_BACK_STALE_AFTER_MIN,
  type HealthSource,
} from "@/lib/health-lines";
import { fetchMetaHealth } from "@/server/fns/health";
import { fetchSyncStatus, type DatasetProgress, type SyncStatusView } from "@/server/fns/status";
import type { AgentTool } from "./kit";

/** Whole minutes since `iso`, or null when there is no usable timestamp (never ran / malformed). */
function ageMinutes(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / 60_000));
}

const hours = (minutes: number): string =>
  minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;

/** One background job's health, flattened and given an age so the model needn't do date maths. */
const service = (s: HealthSource | null, now: number): Record<string, unknown> =>
  s === null
    ? { state: "never run" }
    : {
        ok: s.ok,
        lastSucceededAt: s.checkedAt,
        ...(ageMinutes(s.checkedAt, now) === null
          ? {}
          : { minutesAgo: ageMinutes(s.checkedAt, now) }),
        ...(s.note ? { note: s.note } : {}),
      };

const progress = (p: DatasetProgress): Record<string, unknown> => ({
  pctComplete: Math.round(p.pctComplete),
  remainingChunks: p.remainingChunks,
  deepestDate: p.deepest,
  shallowestDate: p.shallowest,
});

export const getDataFreshness: AgentTool = {
  label: "data freshness",
  definition: {
    name: "get_data_freshness",
    description:
      "IS THE DATA CURRENT? Call this BEFORE making any claim about how up to date the numbers are — never assert 'as of today' or 'the latest data' from a hunch, and call it whenever a figure looks wrong, whenever a client's spend has apparently gone to zero, or whenever the user asks why something looks stale. " +
      "Returns: `verdict` (a one-line plain-English judgement — relay it verbatim when the answer is anything other than fresh), `statusLines` (the same tone/status/detail lines the app's own sidebar health badge shows, so what you say matches what the user can see on screen), " +
      "`lastRefreshAt` + `minutesSinceLastRefresh` (the most recent SUCCESSFUL insights refresh across all accounts — the real 'data as of' timestamp), " +
      "`token` (Meta system-user token `valid` / `checkedAt` / `tier` — 'standard' or 'development' access, which sets our rate limits — plus the last error `note`; valid=null means it has never been verified, which is 'unknown', not 'broken'), " +
      "`notion` (the read that pulls the client→ad-account mapping and contract budgets off the Notion board) and `notionBudget` (the INDEPENDENT write-back that maintains the 🤖 daily-budget columns on that board — it can be broken for days while the read stays green, so report the two separately). " +
      `Freshness rules: the token check and the Notion read run every cycle (hourly), so anything older than ${STALE_AFTER_MIN} minutes means the sync worker is probably down; the write-back runs once per calendar day, so it is only stale past ${WRITE_BACK_STALE_AFTER_MIN / 60} hours. ` +
      "Any approved user can call this. It says nothing about backfill depth, rate-limit pressure or per-account sync errors — that is get_sync_status (admin only).",
    input_schema: { type: "object", properties: {} },
  },
  async run() {
    const now = Date.now();
    const h = await fetchMetaHealth();
    const refreshAge = ageMinutes(h.lastRefreshAt, now);

    // Ordered worst-first: a dead token is why nothing refreshed, so it must not be reported as a
    // mere staleness warning.
    const verdict =
      h.tokenValid === false
        ? `BROKEN — the Meta system-user token is invalid or blocked${h.note ? ` (${h.note})` : ""}, so nothing is being refreshed. Warn the user that every figure is as old as lastRefreshAt before quoting any of it.`
        : refreshAge === null
          ? "UNKNOWN — no successful insights refresh has ever been recorded. Do not claim the data is current."
          : refreshAge > STALE_AFTER_MIN
            ? `STALE — the last successful refresh was ${hours(refreshAge)} ago; the hourly sync worker may be down. Say this before quoting numbers, and caveat anything about recent days.`
            : `FRESH — data last refreshed ${hours(refreshAge)} ago. Yesterday is the last COMPLETE day; today's figures are partial until the day ends and syncs.`;

    return {
      verdict,
      statusLines: buildStatusLines(h, now).map((l) => ({
        tone: l.tone,
        status: l.label,
        detail: l.title,
      })),
      lastRefreshAt: h.lastRefreshAt,
      ...(refreshAge === null ? {} : { minutesSinceLastRefresh: refreshAge }),
      token: {
        valid: h.tokenValid,
        checkedAt: h.checkedAt,
        ...(ageMinutes(h.checkedAt, now) === null
          ? {}
          : { minutesSinceCheck: ageMinutes(h.checkedAt, now) }),
        tier: h.tier,
        ...(h.note ? { note: h.note } : {}),
      },
      notion: service(h.notion, now),
      notionBudget: service(h.notionBudget, now),
      staleAfterMinutes: STALE_AFTER_MIN,
      writeBackStaleAfterMinutes: WRITE_BACK_STALE_AFTER_MIN,
    };
  },
};

// Both arrays are diagnostic samples, not the record: the model needs the shape of the problem, and
// a hundred throttle events would cost more context than the whole rest of the answer.
const SAMPLE_CAP = 15;

export const getSyncStatus: AgentTool = {
  label: "sync status",
  requires: "admin",
  definition: {
    name: "get_sync_status",
    description:
      "ADMIN-ONLY deep sync diagnostics — the data behind the Sync page. Use it when get_data_freshness says something is stale or broken and the user wants to know WHY, when an account's history looks short or missing, or when an admin asks about backfill progress or rate limiting. For the simple 'is the data current?' question use get_data_freshness instead (any user can call that one, and you should call it before claiming the data is current rather than asserting freshness yourself). " +
      "Returns: `accounts` — `total` ad accounts we can see, `structured` (campaign/ad-set/ad tree synced), `insighted` (daily insights synced) and `errored` (accounts whose last sync failed); a gap between total and insighted means those accounts contribute NOTHING to any figure. " +
      "`refresh.lastAt` / `refresh.oldestAt` — newest and oldest per-account refresh timestamps, with `minutesAgo` for each; a very old `oldestAt` means one account has been left behind even while the rest are current. " +
      "`backfill.insights` and `backfill.breakdown` — how deep the historical fill has got: `pctComplete` (average coverage of each account's achievable window, creation date → today), `remainingChunks` (90-day chunk-advances still to run), `deepestDate` and `shallowestDate` (the oldest date the best- and worst-covered account has reached). A backfill still in progress is the normal explanation for missing old data — it is not data loss. " +
      "`rateLimit` — `eventsLast24h` (throttle/backoff events; a high number explains slow or partial refreshes), token validity and the Meta access `tier`. " +
      "`notion` / `notionBudget` — the board read and the independent 🤖 write-back. " +
      `\`events\` — the most recent sync events (kind, HTTP code, account, message, \`pressure\`, \`retryAfterMin\`), and \`errors\` — accounts stuck in the error state with their last error. Both are capped at ${SAMPLE_CAP} rows with \`eventsTotal\` / \`errorsTotal\` giving the true counts; summarize the pattern rather than reciting every row.`,
    input_schema: { type: "object", properties: {} },
  },
  async run() {
    const now = Date.now();
    // `fetchSyncStatus` re-checks the session itself; the `requires` gate above merely keeps the tool
    // out of a non-admin's tool list so the model never offers a capability it cannot deliver.
    let s: SyncStatusView;
    try {
      s = await fetchSyncStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // No HTTP request means no session cookie to check: the scheduled Ask job calls `chatTurn`
      // from the sync worker. Without this the model is handed a raw AsyncLocalStorage error and
      // reports it to the user as if the sync itself were broken.
      if (msg.includes("AsyncLocalStorage") || msg.includes("StartEvent"))
        return {
          error:
            "Deep sync diagnostics need a live signed-in admin session and this run has none (a scheduled/background Ask has no browser session). Use get_data_freshness for the freshness picture and say that the sync detail needs an admin to open the Sync page.",
        };
      return { error: msg };
    }
    const lastAge = ageMinutes(s.refresh.lastAt, now);
    const oldestAge = ageMinutes(s.refresh.oldestAt, now);

    return {
      accounts: s.accounts,
      unsyncedAccounts: Math.max(0, s.accounts.total - s.accounts.insighted),
      refresh: {
        lastAt: s.refresh.lastAt,
        ...(lastAge === null ? {} : { lastMinutesAgo: lastAge }),
        oldestAt: s.refresh.oldestAt,
        ...(oldestAge === null ? {} : { oldestMinutesAgo: oldestAge }),
      },
      backfill: {
        insights: progress(s.backfill.insights),
        breakdown: progress(s.backfill.breakdown),
      },
      rateLimit: {
        eventsLast24h: s.rateLimit.eventsLast24h,
        tokenValid: s.rateLimit.tokenValid,
        tokenCheckedAt: s.rateLimit.tokenCheckedAt,
        tier: s.rateLimit.tier,
      },
      notion: service(s.notion, now),
      notionBudget: service(s.notionBudget, now),
      eventsTotal: s.events.length,
      events: s.events.slice(0, SAMPLE_CAP).map((e) => ({
        at: e.at,
        kind: e.kind,
        code: e.code,
        accountId: e.accountId,
        message: e.message,
        ...(e.pressure === null ? {} : { pressure: Math.round(e.pressure * 100) / 100 }),
        ...(e.retryAfterMin === null ? {} : { retryAfterMin: e.retryAfterMin }),
      })),
      errorsTotal: s.errors.length,
      errors: s.errors.slice(0, SAMPLE_CAP),
      ...(s.events.length > SAMPLE_CAP || s.errors.length > SAMPLE_CAP
        ? { truncated: `events and errors are capped at ${SAMPLE_CAP} rows each` }
        : {}),
      staleAfterMinutes: STALE_AFTER_MIN,
    };
  },
};

/** Data freshness and integration health — is what I am about to say current? */
export const healthTools: AgentTool[] = [getDataFreshness, getSyncStatus];
