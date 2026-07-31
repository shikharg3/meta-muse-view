// Attributing a campaign to a client by NAME.
//
// An ad account is often reused for a different client over time (e.g. one account ran ACR Poker in
// June and SweatBet in July). Both clients then reference the same account in Notion, so a purely
// account-based mapping shows each client the OTHER's campaigns. Campaign names carry the brand, so
// on a *contested* account (2+ current clients) we split campaigns by name.
//
// Two matching modes are needed, because both patterns occur in real data:
//   1. containment — "Rolling Slots/03.04/…" -> rollingslots, "Jackbit Aviator" -> jackbit
//   2. token       — "ACR Bonus" shares only the token `acr` with the row title "ACR Poker"
// Containment is the stronger signal and wins; tokens are the fallback.

/** Generic marketing/structure words that must never link a campaign to a brand. */
const STOPWORDS = new Set([
  // TLDs / suffixes
  "com",
  "net",
  "org",
  "io",
  "eu",
  "gg",
  "ag",
  "fun",
  "bg",
  "app",
  "ai",
  "co",
  "www",
  "https",
  "http",
  // campaign structure + creative variants
  "copy",
  "new",
  "old",
  "test",
  "final",
  "draft",
  "pwa",
  "website",
  "websites",
  "web",
  "site",
  "prelander",
  "prelander2",
  "lander",
  "link",
  "links",
  "linki",
  "wheel",
  "game",
  "games",
  // funnel/objective words
  "reg",
  "regs",
  "regis",
  "registration",
  "registrations",
  "dep",
  "deposit",
  "deposits",
  "lead",
  "leads",
  "purchase",
  "purchases",
  "conv",
  "conversions",
  "traffic",
  "awareness",
  "retargeting",
  "prospecting",
  "tof",
  "mof",
  "bof",
  "cbo",
  "abo",
  "broad",
  "lal",
  "interests",
  "static",
  "video",
  // commercial words that appear in engagement titles
  "bonus",
  "welcome",
  "money",
  "maker",
  "launch",
  "relaunch",
  "campaign",
  "agency",
  "partners",
  "affiliate",
  "affiliates",
  "aff",
  "media",
  "group",
  "renewal",
  "onboarding",
  "statewise",
  // months
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  "january",
  "february",
  "march",
  "april",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]);

/** Suffixes stripped when deriving a brand key, so "rollingslots.com" -> "rollingslots". */
const TLD_RE = /(com|net|org|io|eu|gg|ag|fun|bg|app|ai|co)$/;

/** Lowercase, drop everything that is not a letter or digit. */
export const normalizeName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Distinctive lowercase words of a name, minus stopwords, pure numbers, and 1-2 char noise. */
export function nameTokens(s: string): string[] {
  return [
    ...new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !STOPWORDS.has(t)),
    ),
  ];
}

/** What a client can be recognised by: its name plus its Notion campaign-row titles. */
export interface BrandVocab {
  clientId: string;
  /** Normalized strings to look for INSIDE a normalized campaign name. */
  keys: string[];
  /** Distinctive tokens, used only when no key matches. */
  tokens: string[];
}

/**
 * Build the recognition vocabulary for a client. Row titles matter: "ACR Poker" is what supplies the
 * `acr` token that links the campaign "ACR Bonus" to the client "acrpoker.eu".
 */
export function brandVocab(clientId: string, clientName: string, rowTitles: string[]): BrandVocab {
  const sources = [clientName, ...rowTitles];
  const keys = new Set<string>();
  for (const s of sources) {
    const n = normalizeName(s);
    if (n.length >= 4) keys.add(n);
    // Also index the name with a trailing TLD removed ("rollingslotscom" -> "rollingslots").
    const stripped = n.replace(TLD_RE, "");
    if (stripped.length >= 4 && stripped !== n) keys.add(stripped);
  }
  const tokens = new Set<string>();
  for (const s of sources) for (const t of nameTokens(s)) tokens.add(t);
  return { clientId, keys: [...keys], tokens: [...tokens] };
}

/**
 * Which candidate owns this campaign? Containment first, tokens as fallback; a tie at the winning
 * level is ambiguous and yields null so callers can fall back to account-level attribution rather
 * than silently dropping spend.
 */
export function attributeCampaign(campaignName: string, candidates: BrandVocab[]): string | null {
  const norm = normalizeName(campaignName);
  const toks = new Set(nameTokens(campaignName));

  const byKey = candidates.filter((c) => c.keys.some((k) => norm.includes(k)));
  if (byKey.length === 1) return byKey[0].clientId;
  if (byKey.length > 1) {
    // Prefer the longest matched key — "acrpokereumoneymaker" beats a generic short key.
    const best = byKey
      .map((c) => ({
        id: c.clientId,
        len: Math.max(...c.keys.filter((k) => norm.includes(k)).map((k) => k.length)),
      }))
      .sort((a, b) => b.len - a.len);
    return best[0].len > best[1].len ? best[0].id : null;
  }

  const byToken = candidates.filter((c) => c.tokens.some((t) => toks.has(t)));
  return byToken.length === 1 ? byToken[0].clientId : null;
}
