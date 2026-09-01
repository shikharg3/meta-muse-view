import { fetchActivity, type ActivityEvent } from "@/server/fns/activity";
import { WINDOW_PROPS, toolWindow, type AgentTool, type DateWindow } from "./kit";

/**
 * Change history — who changed a budget/status/creative, and when.
 *
 * `fetchActivity` only takes a row limit (newest first, all accounts interleaved), so every filter
 * below is applied in memory. Pull generously, return a small slice: a busy 90-day log across all
 * accounts is a few thousand rows, which is fine for one indexed query but would obliterate the
 * model's context if returned whole.
 */
const FETCH_LIMIT = 2500;
const MAX_ROWS = 60;
const MAX_TYPES = 25;

/** Lowercase, punctuation-flattened words, so "update_campaign_budget" == "Update Campaign Budget". */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Every word of the query must appear in the event type — order and separators do not matter, so
 * "campaign budget" and "budget campaign" both hit update_campaign_budget. */
function typeMatches(type: string, query: string[]): boolean {
  const hay = words(type);
  return query.every((q) => hay.some((h) => h.includes(q)));
}

function inWindow(iso: string, w: DateWindow): boolean {
  const day = iso.slice(0, 10);
  return day >= w.since && day <= w.until;
}

interface HistoryRow {
  time: string;
  account: string;
  type: string;
  object?: string;
  actor?: string;
}

function toRow(e: ActivityEvent & { eventTime: string }): HistoryRow {
  return {
    // "2026-08-30T14:05Z" — minute precision is plenty and costs half the tokens of a full ISO stamp.
    time: `${e.eventTime.slice(0, 16)}Z`,
    account: e.accountName ?? e.accountId,
    type: e.eventType,
    ...(e.objectName ? { object: e.objectName } : {}),
    ...(e.actorName ? { actor: e.actorName } : {}),
  };
}

export const getChangeHistory: AgentTool = {
  label: "change history",
  definition: {
    name: "get_change_history",
    description:
      "Meta's own ad-account CHANGE LOG — who changed what, and when. This is the ONLY tool that answers questions about actions taken on an account rather than performance numbers: 'who paused this campaign', 'when was the budget changed and by whom', 'what changed on this account last week', 'was anything touched right before spend dropped'. Returns `events` (newest first, max 60): `time` (UTC, minute precision), `account` (ad-account name), `type` (the change Meta logged, e.g. update_campaign_budget / update_ad_set_run_status / ad_account_update_status), `object` (the campaign/ad set/ad that was changed, when Meta names it), and `actor` (the person or system that made the change — absent when Meta attributes it to no user, which is normal for automated changes). Also returns `matched` (how many changes fit the filters, before the 60-row cap) and `types`: every distinct event type present in the window for the matching accounts, with counts — use it to offer a follow-up ('I also see 12 budget changes on this account, want those?'). All filters are optional and combine: `account` and `object` are case-insensitive substring matches; `event_type` matches when EVERY word you pass appears in the type, ignoring case and underscores, so 'budget' or 'campaign budget' both find update_campaign_budget. Defaults to the LAST 30 DAYS — pass days=90 or preset=last_90d to search the whole retained log. COVERAGE: this is not our own audit trail, it is Meta's change history as captured by the hourly sync, which re-requests only the trailing 90 DAYS per account. The last 90 days are reliable; older events survive only if an earlier sync run captured them, and anything Meta itself does not log is simply absent. NEVER conclude 'nothing changed' from an empty result — say the change log has no entry for it.",
    input_schema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description:
            "Filter to ad accounts whose name (or act_ id) contains this text, case-insensitive. Omit for all accounts.",
        },
        event_type: {
          type: "string",
          description:
            "Filter to change types containing this text, e.g. 'budget', 'status', 'campaign', 'update_ad_set_run_status'. Matching ignores underscores/case. Call once without it first to see the `types` actually present.",
        },
        object: {
          type: "string",
          description:
            "Filter to changes made to a named campaign / ad set / ad, case-insensitive substring. Use for 'who paused <campaign>'.",
        },
        ...WINDOW_PROPS,
      },
    },
  },
  async run(input) {
    const w = toolWindow(input);
    const account = typeof input.account === "string" ? input.account.trim().toLowerCase() : "";
    const object = typeof input.object === "string" ? input.object.trim().toLowerCase() : "";
    const typeQuery = typeof input.event_type === "string" ? words(input.event_type) : [];

    const raw = await fetchActivity(FETCH_LIMIT);
    // Undated rows cannot be placed in a window (and Postgres sorts NULLs first on DESC, so they
    // would otherwise squat at the top of the pull). Drop them.
    const dated = raw.filter(
      (e): e is ActivityEvent & { eventTime: string } => typeof e.eventTime === "string",
    );

    // Scope = window + account/object. `types` is summarised over THIS set, deliberately before the
    // event_type filter, so a narrow query still shows the model what else happened.
    const scoped = dated.filter(
      (e) =>
        inWindow(e.eventTime, w) &&
        (!account ||
          (e.accountName ?? "").toLowerCase().includes(account) ||
          e.accountId.toLowerCase().includes(account)) &&
        (!object || (e.objectName ?? "").toLowerCase().includes(object)),
    );

    const counts = new Map<string, number>();
    for (const e of scoped) counts.set(e.eventType, (counts.get(e.eventType) ?? 0) + 1);
    const types = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_TYPES)
      .map(([type, count]) => ({ type, count }));

    const matched =
      typeQuery.length > 0 ? scoped.filter((e) => typeMatches(e.eventType, typeQuery)) : scoped;
    matched.sort((a, b) => b.eventTime.localeCompare(a.eventTime));

    // The pull is a global newest-first slice: if it filled up and its oldest row is still inside the
    // requested window, older events in that window were never seen. Say so rather than imply "none".
    const oldestFetched =
      dated.length > 0 ? dated[dated.length - 1].eventTime.slice(0, 10) : w.since;
    const scanIncomplete = raw.length >= FETCH_LIMIT && oldestFetched > w.since;

    const filters = {
      ...(account ? { account: String(input.account) } : {}),
      ...(object ? { object: String(input.object) } : {}),
      ...(typeQuery.length > 0 ? { eventType: String(input.event_type) } : {}),
    };

    if (matched.length === 0) {
      return {
        window: w,
        ...(Object.keys(filters).length > 0 ? { filters } : {}),
        matched: 0,
        events: [],
        types,
        note:
          types.length > 0
            ? `No change-history entry matches event_type "${String(input.event_type)}". Other types DID occur in this window — pick one from \`types\` and retry.`
            : Object.keys(filters).length > 0
              ? "No change-history entries for these filters in this window. The account/object text may not match anything — confirm the exact ad-account name with list_accounts, widen the window (days=90), or retry without filters."
              : "No change-history entries in this window. The hourly sync re-pulls only the trailing 90 days of Meta's log per account, and Meta records only some in-platform actions, so this means the log has no entry — NOT that nothing changed.",
        ...(scanIncomplete
          ? { partialScan: `Only scanned back to ${oldestFetched}; narrow with an account filter.` }
          : {}),
      };
    }

    return {
      window: w,
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
      matched: matched.length,
      events: matched.slice(0, MAX_ROWS).map(toRow),
      ...(matched.length > MAX_ROWS
        ? { truncated: `showing the ${MAX_ROWS} newest of ${matched.length} matching changes` }
        : {}),
      types,
      ...(scanIncomplete
        ? {
            partialScan: `Only scanned back to ${oldestFetched} (row cap hit); older changes in this window were not read. Narrow with an account filter or a shorter window.`,
          }
        : {}),
    };
  },
};

export const activityTools: AgentTool[] = [getChangeHistory];
