import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { clickDestinations } from "@/lib/creative-links";
import { resolveWindow, type DateWindow, type RangeSpec } from "@/lib/range";
import type { Ad } from "@/lib/types";
import { currentPortalActor } from "@/portal/context";
import {
  loadCommissions,
  markupRows,
  totalSpend,
  PORTAL_DEFAULT_COMMISSION,
  type CommissionTable,
  type DefaultRateLookup,
  type RawDayRow,
} from "@/portal/markup";
import {
  defaultCommissionLookup,
  narrowToPortalBrands,
  portalScope,
  type PortalScope,
} from "@/portal/scope";
import { deriveKpis } from "@/server/agg";
import { creativeFormat, creativeImageUrl, type CreativeFacts } from "@/server/creative";
import { hasVideoSql } from "./ad-video";

/**
 * The portal's Creative page: one card per ad, with its media, its copy and its performance.
 *
 * ## Why this reads ad-level insights when every other portal op is campaign-level
 *
 * The portal rule is "campaign rows only", because an account-level row cannot be split between
 * the campaigns under it, so neither ownership nor markup is defined for it. An AD row has neither
 * problem: an ad sits in exactly one ad set, which sits in exactly one campaign, so the row has
 * one unambiguous owner. That makes the ad level the one justified exception — and it comes with
 * an obligation, because a commission rate is recorded per CAMPAIGN and there is no such thing as
 * an ad's own rate. The ad -> campaign map is therefore built before any markup, and each daily
 * row is marked up at the rate its OWNING CAMPAIGN was on that day.
 *
 * Ownership still comes from `scope.campaignIds`: the ads are found by joining down from the
 * whitelisted campaigns, so an ad outside the scope is unreachable rather than filtered out later.
 */

/**
 * The advertiser identity a card's header shows: the owning brand's configured page name and
 * photo, never the Facebook page an ad actually ran under (the agency rotates those) and never the
 * landing domain. A brand with no page name set shows its client-facing brand name.
 */
export interface CreativePage {
  name: string;
  avatarUrl: string | null;
}

/** A creative as the client sees it. Carries no rate, no raw spend and no internal Meta names. */
export interface PortalCreative {
  /** The ad id — the unit a card represents, since two ads can share one creative. */
  id: string;
  campaignId: string;
  /** The owning brand's page; null only if the campaign's brand could not be resolved. */
  page: CreativePage | null;
  name: string;
  format: Ad["format"];
  /** Best full-size asset: the image, or a video's poster frame. */
  mediaUrl: string | null;
  /** The small stored thumbnail, for list rendering before the full asset loads. */
  thumbnailUrl: string | null;
  primaryText: string | null;
  headline: string | null;
  description: string | null;
  cta: string | null;
  link: string | null;
  /** Marked up. The raw column never leaves this module. */
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  conversions: number;
  costPerConversion: number;
}

export interface PortalCreativesInput extends RangeSpec {
  brandIds?: string[];
  campaignIds?: string[];
}

/** One ad joined to its creative, exactly as `fetchPortalCreatives` projects it. */
export interface AdCreativeRow {
  id: string;
  campaignId: string;
  creativeName: string | null;
  thumbnailUrl: string | null;
  body: string | null;
  title: string | null;
  callToActionType: string | null;
  linkUrl: string | null;
  storySpec: unknown;
  feedSpec: unknown;
  objectType: string | null;
  imageUrl: string | null;
  videoImageUrl: string | null;
  linkPicture: string | null;
  childAttachments: number;
  hasVideo: boolean;
}

/** One ad-level daily insight row, before markup. */
export interface AdDayRow {
  adId: string;
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  conversions: number;
  conversionValues: number;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A copy field, or null when absent or blank — a blank string would render as an empty line. */
const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

/** The first non-blank `text` in an `asset_feed_spec` asset list (`bodies`, `titles`, …). */
function firstAsset(list: unknown): string | null {
  for (const entry of arr(list)) {
    const t = text(obj(entry)?.text);
    if (t) return t;
  }
  return null;
}

/** `SHOP_NOW` -> `Shop Now`. Meta's enum is an implementation detail; the card shows a button. */
function ctaLabel(value: string | null): string | null {
  if (!value) return null;
  return value
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface CreativeCopy {
  primaryText: string | null;
  headline: string | null;
  description: string | null;
  cta: string | null;
}

/**
 * The words on the ad.
 *
 * Read from `object_story_spec` first, because that is the creative as it actually renders; then
 * from `asset_feed_spec` (a dynamic creative has no story spec — Meta assembles a combination per
 * impression, so the first asset is the only sensible single value a card can show); then from the
 * flat `ad_creatives` columns, which pre-date both spec columns.
 *
 * The three story blocks are probed with one key list rather than branched on: a creative carries
 * exactly one of `link_data` / `video_data` / `photo_data`, and they disagree only on which name
 * they give the headline (`name` vs `title`) and the description (`description` vs
 * `link_description`).
 */
function creativeCopy(
  storySpec: unknown,
  feedSpec: unknown,
  flat: { body: string | null; title: string | null; cta: string | null },
): CreativeCopy {
  const oss = obj(storySpec);
  const block = obj(oss?.link_data) ?? obj(oss?.video_data) ?? obj(oss?.photo_data);
  const feed = obj(feedSpec);
  const feedCta = arr(feed?.call_to_action_types).find((v) => text(v) !== null);

  return {
    primaryText: text(block?.message) ?? firstAsset(feed?.bodies) ?? text(flat.body),
    headline:
      text(block?.name) ?? text(block?.title) ?? firstAsset(feed?.titles) ?? text(flat.title),
    description:
      text(block?.description) ?? text(block?.link_description) ?? firstAsset(feed?.descriptions),
    cta: ctaLabel(text(obj(block?.call_to_action)?.type) ?? text(feedCta) ?? text(flat.cta)),
  };
}

/**
 * Shape joined ad/creative rows and their daily insights into client-facing cards.
 *
 * Pure, and separated from the queries because this is where the invariants live: the markup is
 * keyed on the owning campaign, an ad with no rows in the window keeps its card, and nothing that
 * identifies the agency's internal naming reaches the output.
 */
export function shapePortalCreatives(
  ads: AdCreativeRow[],
  perf: AdDayRow[],
  commissions: CommissionTable,
  defaultFor: DefaultRateLookup,
  pageOf: (campaignId: string) => CreativePage | null,
): PortalCreative[] {
  const campaignOfAd = new Map(ads.map((a) => [a.id, a.campaignId]));

  // Each daily row is stamped with the ad's OWNING CAMPAIGN id, which is exactly what `markupRows`
  // keys its rate lookup on — so the owning campaign's rate (or defaults) on that day is what runs,
  // and an ad never picks up a rate belonging to another campaign. Going through `markupRows`
  // rather than re-applying the uplift here keeps one implementation of the formula in the tree.
  // A row for an ad that is not in `ads` is dropped: its owner is unknown, so it cannot be marked
  // up, and it is not in scope in the first place.
  const perfByAd = new Map<string, RawDayRow[]>();
  for (const r of perf) {
    const campaignId = campaignOfAd.get(r.adId);
    if (campaignId === undefined) continue;
    const row: RawDayRow = {
      campaignId,
      date: r.date,
      spend: r.spend,
      impressions: r.impressions,
      reach: r.reach,
      clicks: r.clicks,
      conversions: r.conversions,
      conversionValues: r.conversionValues,
    };
    const list = perfByAd.get(r.adId);
    if (list) list.push(row);
    else perfByAd.set(r.adId, [row]);
  }

  const out = ads.map((ad) => {
    const facts: CreativeFacts = {
      objectType: ad.objectType,
      imageUrl: ad.imageUrl,
      videoImageUrl: ad.videoImageUrl,
      linkPicture: ad.linkPicture,
      childAttachments: ad.childAttachments,
      thumbnailUrl: ad.thumbnailUrl,
      hasVideo: ad.hasVideo,
    };
    const copy = creativeCopy(ad.storySpec, ad.feedSpec, {
      body: ad.body,
      title: ad.title,
      cta: ad.callToActionType,
    });

    // An ad with no rows in the window still gets a card, at zero: the Creative page is a library
    // of what is running, and omitting the quiet ones would read as "this creative was deleted".
    const marked = markupRows(perfByAd.get(ad.id) ?? [], commissions, defaultFor);
    const totals = {
      spend: totalSpend(marked),
      impressions: 0,
      clicks: 0,
      conversions: 0,
      revenue: 0,
      // Reach de-duplicates within a day, so days cannot be added; the largest single day is the
      // only defensible window figure. Only `deriveKpis` consumes it — reach is not serialised.
      reach: 0,
    };
    for (const r of marked) {
      totals.impressions += r.impressions;
      totals.clicks += r.clicks;
      totals.conversions += r.conversions;
      totals.revenue += r.conversionValues;
      if (r.reach > totals.reach) totals.reach = r.reach;
    }
    const k = deriveKpis(totals);

    return {
      id: ad.id,
      campaignId: ad.campaignId,
      page: pageOf(ad.campaignId),
      // Never `ads.name`: the agency's ad names encode the account and objective codes the portal
      // exists to hide. The client-facing label is the creative's own headline, then the creative's
      // own label, and only then a neutral placeholder built from the ad id that is already in the
      // payload — a nameless card would be unaddressable in a support conversation.
      name: copy.headline ?? text(ad.creativeName) ?? `Creative ${ad.id.slice(-6)}`,
      format: creativeFormat(facts),
      mediaUrl: creativeImageUrl(facts),
      thumbnailUrl: ad.thumbnailUrl,
      primaryText: copy.primaryText,
      headline: copy.headline,
      description: copy.description,
      cta: copy.cta,
      // Where a click actually lands. A dynamic or carousel creative rotates several and a card
      // shows one, so it is the first — `clickDestinations` already orders them and rejects the
      // displayed-domain fields that lie about the destination.
      link:
        clickDestinations({ objectStorySpec: ad.storySpec, assetFeedSpec: ad.feedSpec })[0] ??
        text(ad.linkUrl),
      spend: k.spend,
      impressions: k.impressions,
      clicks: k.clicks,
      ctr: k.ctr,
      conversions: k.conversions,
      costPerConversion: k.conversions > 0 ? k.spend / k.conversions : 0,
    } satisfies PortalCreative;
  });

  // Spend descending, with the ad id breaking ties so a page full of zero-spend creatives keeps a
  // stable order between requests.
  out.sort((a, b) => b.spend - a.spend || a.id.localeCompare(b.id));
  return out;
}

// Pre-pause creative rows kept only `raw`; `syncCreativeSpecs` fills the two spec columns for
// creatives behind ACTIVE ads. Coalescing means an older creative still yields its copy and media
// instead of a blank card. Both forms stay in Postgres — the projections below ship a handful of
// fields, never the ~77 MB of stored payloads.
const storySpecSql = sql<unknown>`coalesce(${schema.adCreatives.objectStorySpec}, ${schema.adCreatives.raw} -> 'object_story_spec')`;
const feedSpecSql = sql<unknown>`coalesce(${schema.adCreatives.assetFeedSpec}, ${schema.adCreatives.raw} -> 'asset_feed_spec')`;

export async function fetchPortalCreatives(input: PortalCreativesInput): Promise<PortalCreative[]> {
  const scope = narrowToPortalBrands(await portalScope(currentPortalActor()), input.brandIds);
  return buildCreatives(scope, resolveWindow(input), input.campaignIds);
}

/**
 * `fetchPortalCreatives` over an already-resolved scope — for a caller that narrowed it once
 * itself (the portal assistant; see `buildOverview` in `./portal.ts`).
 */
export async function buildCreatives(
  scope: PortalScope,
  w: DateWindow,
  requested: string[] | undefined,
): Promise<PortalCreative[]> {
  // The requested campaigns are a FILTER over the whitelist, never a lookup: an id the caller was
  // not granted matches nothing instead of widening the query.
  let campaignIds = scope.campaignIds;
  if (requested) {
    const asked = new Set(requested);
    campaignIds = campaignIds.filter((id) => asked.has(id));
  }
  if (campaignIds.length === 0) return [];

  const ads: AdCreativeRow[] = await db
    .select({
      id: schema.ads.id,
      campaignId: schema.adSets.campaignId,
      creativeName: schema.adCreatives.name,
      thumbnailUrl: schema.adCreatives.thumbnailUrl,
      body: schema.adCreatives.body,
      title: schema.adCreatives.title,
      callToActionType: schema.adCreatives.callToActionType,
      linkUrl: schema.adCreatives.linkUrl,
      storySpec: storySpecSql,
      feedSpec: feedSpecSql,
      objectType: sql<
        string | null
      >`coalesce(${schema.adCreatives.objectType}, ${schema.adCreatives.raw} ->> 'object_type')`,
      imageUrl: sql<
        string | null
      >`coalesce(${schema.adCreatives.imageUrl}, ${schema.adCreatives.raw} ->> 'image_url')`,
      videoImageUrl: sql<string | null>`${storySpecSql} -> 'video_data' ->> 'image_url'`,
      linkPicture: sql<string | null>`${storySpecSql} -> 'link_data' ->> 'picture'`,
      childAttachments: sql<number>`coalesce(jsonb_array_length(${storySpecSql} -> 'link_data' -> 'child_attachments'), 0)`,
      hasVideo: hasVideoSql,
    })
    .from(schema.ads)
    .innerJoin(schema.adSets, eq(schema.adSets.id, schema.ads.adSetId))
    // Left, not inner: an ad whose creative row was never fetched still has performance worth
    // showing, and dropping it would make this page's spend disagree with the campaign page's.
    .leftJoin(schema.adCreatives, eq(schema.adCreatives.id, schema.ads.creativeId))
    .where(inArray(schema.adSets.campaignId, campaignIds));
  if (ads.length === 0) return [];

  const perf = await db
    .select({
      adId: schema.insightsDaily.entityId,
      date: schema.insightsDaily.date,
      spend: schema.insightsDaily.spend,
      impressions: schema.insightsDaily.impressions,
      reach: schema.insightsDaily.reach,
      clicks: schema.insightsDaily.clicks,
      conversions: schema.insightsDaily.conversions,
      conversionValues: schema.insightsDaily.conversionValues,
    })
    .from(schema.insightsDaily)
    .where(
      and(
        eq(schema.insightsDaily.level, "ad"),
        // The ad ids come from the scoped join above, so this reaches no ad the caller cannot see.
        inArray(
          schema.insightsDaily.entityId,
          ads.map((a) => a.id),
        ),
        gte(schema.insightsDaily.date, w.since),
        lte(schema.insightsDaily.date, w.until),
      ),
    );

  return shapePortalCreatives(
    ads,
    perf,
    await loadCommissions(campaignIds),
    defaultCommissionLookup(scope, PORTAL_DEFAULT_COMMISSION),
    creativePageResolver(scope),
  );
}

/**
 * The page a campaign's ads show as the advertiser, field by field: its Brand's (group's) override,
 * else the client's default ad page, else the client's own name (and no photo, so the card draws
 * initials).
 *
 * Resolved from the scope that already decided what the caller may see, so a card can only ever
 * carry the page of a client — and a group — in that scope. Field-wise on purpose: a group that
 * sets only its own name keeps the client's photo rather than losing it.
 */
export function creativePageResolver(
  scope: Pick<PortalScope, "brands" | "brandOf" | "groupOf" | "groups">,
): (campaignId: string) => CreativePage | null {
  const brandById = new Map(scope.brands.map((b) => [b.id, b]));
  return (campaignId) => {
    const brand = brandById.get(scope.brandOf.get(campaignId) ?? "");
    if (!brand) return null;
    const group = scope.groups.get(scope.groupOf.get(campaignId) ?? "");
    return {
      name: group?.pageName ?? brand.pageName ?? brand.name,
      avatarUrl: group?.pageAvatarUrl ?? brand.pageAvatarUrl,
    };
  };
}
