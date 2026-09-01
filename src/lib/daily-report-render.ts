/**
 * Pure presentation for the daily performance report: `EngagementRow[]` -> Telegram message text.
 *
 * PLAIN TEXT, deliberately. `TelegramClient.sendMessage` sends no `parse_mode` (its wire payload is
 * only `chat_id`, `text`, `disable_web_page_preview`), so there is no Markdown or HTML to escape here
 * and none may be introduced without also escaping every client name — a board title containing `_`
 * or `*` would otherwise break the message or silently drop characters. Emoji is the only emphasis
 * available, which matches the existing alert headings.
 */
import { fmtCurrency } from "./format";
// Generic "Thu 13 Aug" formatter. It lives in the check-in's render module rather than beside the
// other formatters, but importing it beats a second copy that can drift.
import { dayLabel } from "./checkin-render";
import type { AccountHealth, CurrencySpend, EngagementRow } from "./daily-report";

/** Telegram's hard per-message ceiling. A longer `text` is rejected outright, not truncated. */
export const TELEGRAM_TEXT_LIMIT = 4096;

/**
 * Worst-case width of the " (12/12)" chunk counter.
 *
 * Packing has to reserve this BEFORE the chunk count is known, because the counter's own width
 * depends on how many chunks the packing produces. Reserving the maximum makes the two passes agree:
 * the real header is never wider than the budget the packer assumed.
 */
const COUNTER_RESERVE = " (99/99)".length;

/**
 * Spend across an engagement's accounts, joined by `+` when they hold different currencies.
 *
 * There is no FX rate anywhere in this codebase, so unlike currencies are NEVER summed — a
 * `$800.00 + €300.00` line is honest where a single number would be invented. Two decimals, unlike
 * the dashboard's whole-dollar display: this is a single day's figure.
 */
function spendText(spend: CurrencySpend[]): string {
  return spend.length === 0
    ? fmtCurrency(0, "USD", 2)
    : spend.map((s) => fmtCurrency(s.amount, s.currency, 2)).join(" + ");
}

const HEALTH_ICON = { DISABLED: "🚫", PENDING: "⏳", PAUSED: "⏸️", ACTIVE: "✅" } as const;

/**
 * The account badge. Healthy engagements get a bare tick — spelling out "ACTIVE" on the majority of
 * lines is noise that buries the two lines that need reading.
 *
 * A partially affected engagement is reported as `1/3 accounts`, because "DISABLED" alone would imply
 * the whole engagement is down when most of it is still delivering.
 */
function healthText(h: AccountHealth): string {
  if (h.worst === "ACTIVE") return HEALTH_ICON.ACTIVE;
  const scope = h.affected < h.total ? `${h.affected}/${h.total} accounts ` : "";
  const reason = h.reason ? ` (${h.reason})` : "";
  const icon = h.affected < h.total ? "⚠️" : HEALTH_ICON[h.worst];
  return `${icon} ${scope}${h.worst}${reason}`;
}

/**
 * One engagement line. The healthy badge is appended with a plain space rather than the ` · `
 * separator so the common case reads as a tick on the end of the sentence instead of a fourth field.
 */
function engagementLine(index: number, row: EngagementRow): string {
  const health = healthText(row.health);
  const tail = row.health.worst === "ACTIVE" ? ` ${health}` : ` · ${health}`;
  const results = row.results
    .map((r) => `${r.count.toLocaleString("en-US")} ${r.label}`)
    .join(", ");
  return `${index}. ${row.name} — ${spendText(row.spend)} · ${results}${tail}`;
}

/**
 * The closing total.
 *
 * Says "across N engagements" and NOT "total spend": campaigns that resolve to no Notion row are
 * excluded from the report, so this figure is deliberately not the day's true Meta spend and must not
 * be phrased as though it were.
 */
function totalLine(rows: EngagementRow[]): string {
  const byCurrency = new Map<string, number>();
  for (const r of rows)
    for (const s of r.spend)
      byCurrency.set(s.currency, (byCurrency.get(s.currency) ?? 0) + s.amount);
  const totals = [...byCurrency]
    .map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency, "en"));
  const noun = rows.length === 1 ? "engagement" : "engagements";
  return `Total: ${spendText(totals)} across ${rows.length} ${noun}`;
}

/**
 * Render the report as one message per 4096 characters, split only at engagement boundaries.
 *
 * Splitting rather than truncating: ranking by spend would put the tail beyond a cut-off, and a
 * low-spend engagement whose ad account just went DISABLED is exactly the line that must not be the
 * one dropped.
 *
 * An empty day still produces one message. Silence is indistinguishable from a broken worker, and a
 * day with genuinely no active campaigns is itself worth seeing.
 */
export function renderDailyReport(date: string, rows: EngagementRow[]): string[] {
  const heading = `📊 Yesterday · ${dayLabel(date)}`;
  if (rows.length === 0) return [`${heading}\n\nNo active campaigns.`];

  const lines = rows.map((r, i) => engagementLine(i + 1, r));
  const footer = totalLine(rows);
  // Reserved in EVERY chunk, not just the last: which chunk is last is only known once packing ends,
  // and a footer that does not fit would be dropped silently.
  const budget = TELEGRAM_TEXT_LIMIT - heading.length - COUNTER_RESERVE - footer.length - 4;

  const chunks: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const line of lines) {
    // A single line wider than the whole budget cannot be packed; hard-truncate it so one absurd
    // board title cannot make the message unsendable or spin this loop forever.
    const safe = line.length > budget ? `${line.slice(0, Math.max(0, budget - 1))}…` : line;
    if (current.length > 0 && used + safe.length + 1 > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(safe);
    used += safe.length + 1;
  }
  if (current.length > 0) chunks.push(current);

  const total = chunks.length;
  return chunks.map((body, i) => {
    const counter = total > 1 ? ` (${i + 1}/${total})` : "";
    const tail = i === total - 1 ? `\n\n${footer}` : "";
    return `${heading}${counter}\n\n${body.join("\n")}${tail}`;
  });
}
