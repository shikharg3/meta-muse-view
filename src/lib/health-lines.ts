/**
 * The sidebar health badge's derivation, as a pure function.
 *
 * Lives here rather than inside `MetaStatus.tsx` for the reason `delivery-status.ts` does: deciding
 * which of several health sources gets to speak, and in what tone, is precedence logic worth testing
 * in isolation. This module imports nothing from `server/`, `db/` or `sync/` — the caller passes the
 * already-fetched health in, and `now` is an argument so the staleness branches are testable.
 */

/** One background service's last recorded health, reduced to what the badge needs. */
export interface HealthSource {
  ok: boolean;
  checkedAt: string | null;
  note: string | null;
}

export interface HealthInput {
  tokenValid: boolean | null;
  checkedAt: string | null;
  /** Meta access tier, as `normalizeTier` reports it. */
  tier: string | null;
  note: string | null;
  /** `notion` — reads the client/account mapping off the board. */
  notion: HealthSource | null;
  /** `notion-budget` — writes the 🤖 columns back to the board. */
  notionBudget: HealthSource | null;
  /**
   * `sync-cycle` — the cycle itself, whose `note` is `full|core: running|completed`.
   *
   * Needed because the token check and the `notion` read are stamped at the TOP of a cycle, so
   * their age is really "how long ago the current pass started". A daily full pass takes 4-5h
   * against dev-tier rate limits, which made both of them trip the 2h window every single day
   * while the sync was working perfectly. This is what tells the difference.
   */
  syncCycle: HealthSource | null;
}

export type Tone = "ok" | "warn" | "bad" | "idle";

export interface StatusLine {
  tone: Tone;
  label: string;
  title: string;
}

/** The Meta token check and the `notion` read sync run on EVERY cycle, i.e. hourly, so two missed
 *  cycles is the first unambiguous sign the worker is down rather than merely between runs. */
export const STALE_AFTER_MIN = 120;

/**
 * The write-back's own window. `syncNotionDailyBudgets` runs only under `runCycle({ full: true })`,
 * which `worker.ts` fires on the first tick of each new calendar day — so consecutive runs sit ~24h
 * apart and the hourly threshold above would paint it amber for twenty-two hours out of every
 * twenty-four. A badge that cries wolf daily is a badge nobody reads, which is the failure this
 * whole line exists to prevent. 36h = a full daily slot missed, with slack for restart jitter.
 */
export const WRITE_BACK_STALE_AFTER_MIN = 36 * 60;

/**
 * How long a pass may claim to be `running` before the claim is the alarm.
 *
 * A worker killed mid-pass leaves `sync-cycle` reading `running` forever, and that must not
 * suppress the staleness warning indefinitely — the outage it hides is precisely the one the 2h
 * window exists to catch. Observed full passes run ~4h45m on dev-tier pacing through a storm of
 * Meta "Service temporarily unavailable"; 8h is comfortably past the worst legitimate case.
 */
export const MAX_CYCLE_MIN = 8 * 60;

/** `Date.parse`, or null when there is no usable timestamp. A malformed one must read as "never
 *  checked" rather than sliding through the `> STALE_AFTER_MIN` comparison as NaN, which is false
 *  and would paint a broken service green. */
function stamp(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Minutes since `iso`, or null when there is no usable timestamp. */
function ageMin(iso: string | null | undefined, now: number): number | null {
  const t = stamp(iso);
  return t === null ? null : (now - t) / 60_000;
}

/** Wall-clock time for a tooltip. Shares `stamp`'s guard so a timestamp too broken to age is never
 *  rendered as the literal string "Invalid Date". */
function clock(iso: string | null | undefined): string {
  const t = stamp(iso);
  return t === null ? "never" : new Date(t).toLocaleTimeString();
}

/**
 * Why a cycle-start stamp is older than its window — or null when there is no excuse and the age
 * is a real warning.
 *
 * `running`: a pass is in flight, so the token/Notion stamps are already as fresh as they can be;
 * the next refresh happens when it ends. `settling`: a pass finished within the normal window, so
 * the next one re-stamps shortly. `null` also covers the stuck case — a pass claiming `running`
 * past {@link MAX_CYCLE_MIN} means the worker died mid-pass, which must warn rather than excuse.
 */
function cycleExcuse(
  cycle: HealthSource | null,
  now: number,
): { kind: "running" | "settling"; phase: string; age: number } | null {
  if (!cycle?.ok) return null;
  const age = ageMin(cycle.checkedAt, now);
  if (age === null) return null;
  const note = cycle.note ?? "";
  const phase = note.startsWith("full") ? "full" : "core";
  if (note.endsWith("running")) {
    return age <= MAX_CYCLE_MIN ? { kind: "running", phase, age } : null;
  }
  return age <= STALE_AFTER_MIN ? { kind: "settling", phase, age } : null;
}

/** How the excuse reads in a tooltip, so both lines say the same thing. */
function excuseTitle(e: { kind: "running" | "settling"; phase: string; age: number }): string {
  const hrs = e.age >= 60 ? `${Math.round(e.age / 60)}h` : `${Math.round(e.age)}m`;
  return e.kind === "running"
    ? `a ${e.phase} sync pass has been running for ${hrs} and re-checks when it finishes`
    : `the ${e.phase} pass finished ${hrs} ago and the next one re-checks shortly`;
}

function metaLine(d: HealthInput, now: number): StatusLine {
  const age = ageMin(d.checkedAt, now);
  const tierLabel =
    d.tier === "standard" ? "Standard" : d.tier === "development" ? "Dev tier" : null;
  if (d.tokenValid === false) {
    return {
      tone: "bad",
      label: "Meta: token invalid",
      title: d.note
        ? `Meta system-user token invalid/blocked: ${d.note}`
        : "Meta system-user token is invalid or blocked — check Settings.",
    };
  }
  if (d.tokenValid === null) {
    return {
      tone: "idle",
      label: "Meta: not checked",
      title: "Meta token not verified yet — the sync will check it on the next cycle.",
    };
  }
  if (age !== null && age > STALE_AFTER_MIN) {
    // The token is re-checked at the TOP of each cycle, so this age is the age of the current
    // pass's start, not evidence the worker is down. Only warn when the cycle cannot explain it.
    const excuse = cycleExcuse(d.syncCycle, now);
    if (!excuse) {
      return {
        tone: "warn",
        label: "Meta: sync stale",
        title: `Token OK, but last verified ${Math.round(age / 60)}h ago — the sync worker may be down.`,
      };
    }
    return {
      tone: "ok",
      label: tierLabel ? `Meta OK · ${tierLabel}` : "Meta OK",
      title:
        `Meta app + system token OK${tierLabel ? ` · ${tierLabel} rate limits` : ""} · ` +
        `last verified ${clock(d.checkedAt)} — ${excuseTitle(excuse)}`,
    };
  }
  return {
    tone: "ok",
    label: tierLabel ? `Meta OK · ${tierLabel}` : "Meta OK",
    title:
      `Meta app + system token OK${tierLabel ? ` · ${tierLabel} rate limits` : ""}` +
      (d.checkedAt ? ` · checked ${clock(d.checkedAt)}` : ""),
  };
}

/**
 * The Notion integration as ONE line, covering both directions of travel.
 *
 * Two jobs run against the same board and fail INDEPENDENTLY: `notion` reads the client/account
 * mapping in, `notion-budget` writes the 🤖 columns back. Measured 2026-08-31, the read stayed green
 * for six days while the write-back skipped all 658 cells because the board's status column had been
 * renamed — invisible here, because only the read half was ever rendered.
 *
 * Worst tone wins and the label names the failing half, so neither half can hide behind the other's
 * green dot. The read is reported before the write when both are down: the write-back re-reads the
 * same board, so a broken read (revoked token, board unshared) is the likelier root cause and the
 * one worth fixing first.
 */
function notionLine(d: HealthInput, now: number): StatusLine | null {
  const { notion: read, notionBudget: write } = d;
  if (!read && !write) return null; // neither has ever run; nothing honest to say

  if (read && !read.ok) {
    return {
      tone: "bad",
      label: "Notion: sync failing",
      title: read.note
        ? `Notion client-board sync failing: ${read.note}`
        : "Notion client-board sync is failing — re-share the board with the integration.",
    };
  }
  if (write && !write.ok) {
    return {
      tone: "bad",
      label: "Notion: board writes failing",
      title: write.note
        ? `Notion write-back failing: ${write.note}`
        : "The 🤖 columns are no longer being maintained — check the board's column names.",
    };
  }

  const rAge = ageMin(read?.checkedAt, now);
  const wAge = ageMin(write?.checkedAt, now);
  const stale: { which: string; age: number }[] = [];
  // The read runs at the top of each cycle, so a long pass makes it look stale when it is not; the
  // write-back has its own 36h window and needs no such allowance.
  const excuse = cycleExcuse(d.syncCycle, now);
  if (read && rAge !== null && rAge > STALE_AFTER_MIN && !excuse) {
    stale.push({ which: "sync", age: rAge });
  }
  if (write && wAge !== null && wAge > WRITE_BACK_STALE_AFTER_MIN) {
    stale.push({ which: "board writes", age: wAge });
  }
  if (stale.length > 0) {
    const worst = stale.reduce((a, b) => (b.age > a.age ? b : a));
    return {
      tone: "warn",
      label: `Notion: ${worst.which} stale`,
      title: `Notion ${worst.which} OK but last succeeded ${Math.round(worst.age / 60)}h ago.`,
    };
  }
  if (read && rAge !== null && rAge > STALE_AFTER_MIN && excuse) {
    return {
      tone: "ok",
      label: "Notion OK",
      title: `Notion board OK · sync ${clock(read.checkedAt)} — ${excuseTitle(excuse)}`,
    };
  }

  // A half that has never run is reported as such rather than folded into the OK claim: "Notion OK"
  // must not stand for a write-back that has produced nothing.
  const parts: string[] = [];
  if (read) parts.push(`sync ${clock(read.checkedAt)}`);
  if (write) parts.push(`writes ${clock(write.checkedAt)}`);
  else parts.push("write-back has not run yet");
  return { tone: "ok", label: "Notion OK", title: `Notion board OK · ${parts.join(" · ")}` };
}

/** Every line the sidebar badge should render, in order. `data` null = still loading. */
export function buildStatusLines(
  data: HealthInput | null | undefined,
  now: number = Date.now(),
): StatusLine[] {
  if (!data) return [{ tone: "idle", label: "Meta: checking…", title: "App health" }];
  const notion = notionLine(data, now);
  return notion ? [metaLine(data, now), notion] : [metaLine(data, now)];
}
