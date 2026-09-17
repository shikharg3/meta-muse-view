/**
 * Which Meta campaign names are safe to show a client as-is.
 *
 * The portal now defaults a campaign's client-facing name to `campaigns.name`, because most of
 * them were already written for a human to read. That is true of the majority and false of a
 * measurable tail, so rather than gate the whole feature on naming 627 campaigns by hand, the tail
 * is flagged and an operator deals with just that.
 *
 * Measured over the live board at the time of writing (627 campaigns):
 *   99  " - Copy" / " - Copy 3"      duplication artefacts
 *   54  TOF / prospecting / LAL …    agency strategy vocabulary (NOT flagged — see below)
 *   38  opaque ids                   e.g. `fbmdpwa4oUnBF0505cab2266_4`
 *   13  Meta placeholder text        "New Traffic Campaign with recommended settings"
 *    4  another client's name        one of them shipping a competitor's tracking URL
 *
 * Strategy vocabulary is deliberately NOT flagged. "Prospecting", "broad" and "lookalike" describe
 * the work the client is paying for, and an agency that cannot say "prospecting" to its client has
 * a different problem. Flagging 54 rows nobody would act on would train people to ignore the flag.
 */

export type NameFlag =
  /** Names a different current client. The only flag that is a disclosure problem, not a polish one. */
  | "mentions-other-client"
  /** Carries a URL — usually a tracker, which is noise at best and a competitor's domain at worst. */
  | "contains-url"
  /** Meta's own default text for a campaign nobody renamed. */
  | "placeholder"
  /** An id or hash rather than a name; meaningless to a client. */
  | "opaque-id"
  /** A duplication artefact from Meta's "Duplicate" button. */
  | "copy-suffix";

export interface NameReview {
  flags: NameFlag[];
  /** The other client's name, when `mentions-other-client` fired — so the warning can say who. */
  mentionsClient: string | null;
}

/** Letters and digits only, lowercased: how two names are compared for containment. */
export const nameToken = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

const COPY_SUFFIX = /\s[-–]\s*copy(\s*\d+)?\s*$/i;
const PLACEHOLDER = /^(new\s+.*campaign|untitled)|recommended settings/i;
const URL_LIKE = /https?:\/\/|www\.|\.com\/|\.io\/|\.ag\//i;
/** No separators at all and long enough that it cannot be a word — an id, not a name. */
const OPAQUE_ID = /^[A-Za-z0-9_]{18,}$/;

/**
 * A client whose name could appear inside a campaign name.
 *
 * Tokens shorter than six characters are excluded by the caller, not here: short ones ("omni",
 * "bol") collide with ordinary words and would flag most of the board.
 */
export interface ClientToken {
  id: string;
  name: string;
  token: string;
}

/**
 * Review one campaign name.
 *
 * `ownerClientId` is resolved through the ownership ladder, not the account, because a shared
 * account is claimed by several clients and comparing against the wrong owner would flag a campaign
 * for naming its own client.
 */
export function reviewName(
  name: string,
  ownerClientId: string | null,
  clients: readonly ClientToken[],
): NameReview {
  const flags: NameFlag[] = [];
  let mentionsClient: string | null = null;

  const token = nameToken(name);
  for (const c of clients) {
    if (c.id === ownerClientId) continue;
    if (!token.includes(c.token)) continue;
    // The owner's own token winning is the common case for a well-named campaign, so only report a
    // foreign one, and report the first: listing every partial match is noise.
    mentionsClient = c.name;
    flags.push("mentions-other-client");
    break;
  }

  if (URL_LIKE.test(name)) flags.push("contains-url");
  if (PLACEHOLDER.test(name.trim())) flags.push("placeholder");
  if (OPAQUE_ID.test(name.trim())) flags.push("opaque-id");
  if (COPY_SUFFIX.test(name)) flags.push("copy-suffix");

  return { flags, mentionsClient };
}

/** Build the comparison set once per request. Short names are dropped — see `ClientToken`. */
export function clientTokens(clients: readonly { id: string; name: string }[]): ClientToken[] {
  const out: ClientToken[] = [];
  for (const c of clients) {
    const token = nameToken(c.name);
    if (token.length < 6) continue;
    out.push({ id: c.id, name: c.name, token });
  }
  return out;
}
