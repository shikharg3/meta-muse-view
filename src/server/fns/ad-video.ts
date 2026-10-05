import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getCredentials } from "@/lib/credentials";
import { MetaAuthError, MetaClient } from "@/meta/client";
import type { GraphNode } from "@/meta/types";
import { specVideoId } from "@/server/creative";
import { requireApproved } from "./auth";

/**
 * A creative's playable video, for the Base44 creative viewer.
 *
 * Only the droplet holds a Meta token, so only it can turn a video id into the MP4 Meta serves. The
 * sync never stores that URL — it is signed and expires within hours — so it is asked for on demand.
 */
export interface AdVideo {
  adId: string;
  /** `act_<digits>` of the ad, so the viewer can link to Ads Manager. */
  accountId: string | null;
  /** Null when the ad's creative carries no video at all. */
  videoId: string | null;
  /** Meta's signed MP4 URL; null when Meta would not hand one over. */
  source: string | null;
  poster: string | null;
  durationSec: number | null;
  permalinkUrl: string | null;
  /** Why `source` is null, as a sentence the viewer can show beside the poster. */
  reason: string | null;
}

/** What Meta says about one video — the cacheable half of an `AdVideo`. */
type MetaVideo = Pick<AdVideo, "source" | "poster" | "durationSec" | "permalinkUrl" | "reason">;

const VIDEO_FIELDS = ["source", "picture", "length", "permalink_url"];

/**
 * Meta's signed `source` URLs live for hours, so half an hour is comfortably inside their life and
 * stops someone flicking between creatives from re-asking Meta — whose budget this shares with the
 * sync worker — for the same video every time.
 */
const CACHE_TTL_MS = 30 * 60_000;
const cache = new Map<string, { expires: number; video: MetaVideo }>();

function remember(videoId: string, video: MetaVideo): void {
  const now = Date.now();
  // Swept on write rather than on a timer: the map only grows when someone is looking at videos.
  for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id);
  cache.set(videoId, { expires: now + CACHE_TTL_MS, video });
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Meta returns `permalink_url` as a site-relative path (`/123/videos/456/`). */
function absolutePermalink(v: unknown): string | null {
  const path = text(v);
  if (!path) return null;
  return path.startsWith("/") ? `https://www.facebook.com${path}` : path;
}

/**
 * Ask Meta for the video, never throwing: a refusal becomes `reason`, because the viewer degrades
 * to the poster and a 500 would blank the whole panel instead.
 *
 * The node read is the natural ask, but Meta refuses `source` on a video the token does not own —
 * typically one uploaded through the Page rather than the ad account. The ad account's video library
 * is the second door: it lists videos the account may advertise with, page-owned ones included.
 */
async function readVideo(
  client: MetaClient,
  videoId: string,
  accountId: string,
): Promise<MetaVideo> {
  let node: GraphNode | null = null;
  let refusal: string | null = null;
  try {
    node = await client.getNodeFull(videoId, VIDEO_FIELDS, "advideo", accountId);
  } catch (e) {
    // A dead token fails the library read identically; spare Meta the second call.
    if (e instanceof MetaAuthError) return noSource(message(e));
    refusal = message(e);
  }
  if (!text(node?.source)) {
    try {
      const rows = await client.getChildren(accountId, "advideos", ["id", ...VIDEO_FIELDS], {
        filtering: [{ field: "id", operator: "IN", value: [videoId] }],
      });
      // Matched by id rather than trusting the first row: should Meta ignore the filter, the first
      // row is some other video in the library.
      const listed = rows.find((r) => String(r.id) === videoId);
      if (listed && (text(listed.source) || !node)) node = listed;
    } catch (e) {
      refusal ??= message(e);
    }
  }
  const source = text(node?.source);
  const length = Number(node?.length);
  return {
    source,
    poster: text(node?.picture),
    durationSec: Number.isFinite(length) && length > 0 ? length : null,
    permalinkUrl: absolutePermalink(node?.permalink_url),
    reason: source ? null : (refusal ?? "Meta did not return a playable source for this video."),
  };
}

function noSource(reason: string): MetaVideo {
  return { source: null, poster: null, durationSec: null, permalinkUrl: null, reason };
}

// The three places a video id can live, exactly as `specVideoId` reads them — projected, never `raw`
// itself, whose blobs are large. The spec columns are coalesced with `raw` because pre-pause
// creative rows kept only `raw` (see `portal-creative.ts`).
const videoDataSql = sql<unknown>`coalesce(${schema.adCreatives.objectStorySpec} -> 'video_data', ${schema.adCreatives.raw} -> 'object_story_spec' -> 'video_data')`;
const feedVideosSql = sql<unknown>`coalesce(${schema.adCreatives.assetFeedSpec} -> 'videos', ${schema.adCreatives.raw} -> 'asset_feed_spec' -> 'videos')`;

/**
 * `specVideoId(...) !== null`, in SQL, for the listings that label a creative's format. Meta's
 * `object_type` says VIDEO only for a plain video ad; a dynamic or Advantage+ creative whose video
 * lives in the asset feed reports SHARE and was being shown as an image. False, never null, for an
 * ad whose creative row is missing, so a left join still yields a boolean.
 */
export const hasVideoSql = sql<boolean>`(coalesce(nullif(${schema.adCreatives.videoId}, ''), nullif(${videoDataSql} ->> 'video_id', ''), nullif(${feedVideosSql} -> 0 ->> 'video_id', '')) is not null)`;

export async function fetchAdVideo(input: { adId: string }): Promise<AdVideo> {
  await requireApproved();
  // Only the three places a video id can live are projected — never `raw` itself, whose blobs are
  // large. The spec columns are coalesced with `raw` because pre-pause creative rows kept only
  // `raw` (see `portal-creative.ts`).
  const [row] = await db
    .select({
      accountId: schema.ads.accountId,
      videoId: schema.adCreatives.videoId,
      videoData: videoDataSql,
      feedVideos: feedVideosSql,
    })
    .from(schema.ads)
    .leftJoin(schema.adCreatives, eq(schema.adCreatives.id, schema.ads.creativeId))
    .where(eq(schema.ads.id, input.adId));

  const base = { adId: input.adId, accountId: row?.accountId ?? null, videoId: null };
  if (!row) return { ...base, ...noSource("Ad not found.") };
  const videoId = specVideoId({
    videoId: row.videoId,
    objectStorySpec: { video_data: row.videoData },
    assetFeedSpec: { videos: row.feedVideos },
  });
  if (!videoId) return { ...base, ...noSource("This ad's creative has no video.") };

  const cached = cache.get(videoId);
  if (cached && cached.expires > Date.now()) return { ...base, videoId, ...cached.video };

  const creds = await getCredentials();
  if (!creds) return { ...base, videoId, ...noSource("No Meta credentials are configured.") };
  const client = new MetaClient(
    {
      appId: creds.appId,
      appSecret: creds.appSecret,
      token: creds.token,
      version: creds.apiVersion,
    },
    // Someone is waiting on this: one rate-limit retry, not the sync's five minutes-long backoffs.
    // No `fieldStore` either — a field refused for one video must not be blocklisted for the sync.
    { maxRetries: 1 },
  );
  const video = await readVideo(client, videoId, row.accountId);
  if (video.source) remember(videoId, video);
  return { ...base, videoId, ...video };
}
