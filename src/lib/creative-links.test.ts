import { test, expect } from "bun:test";
import { clickDestinations, groupByLandingPage } from "./creative-links";

test("a link ad's destination is its link, and the displayed domain is never used", () => {
  const urls = clickDestinations({
    objectStorySpec: {
      link_data: {
        link: "https://tracker.example/abc",
        // Advertisers show a brand domain while linking to a tracker. Reporting this as the
        // destination would state the opposite of where the click goes.
        caption: "brand.example",
        picture: "https://cdn.example/creative.jpg",
      },
    },
  });
  expect(urls).toEqual(["https://tracker.example/abc"]);
});

test("dynamic creative reports every rotating destination", () => {
  // This is the real shape behind the board's two-URL ads: Meta serves one per impression, so both
  // are pages a user can land on.
  const urls = clickDestinations({
    assetFeedSpec: {
      link_urls: [
        { website_url: "https://a.example/1", display_url: "brand.example" },
        { website_url: "https://b.example/2" },
      ],
    },
  });
  expect(urls).toEqual(["https://a.example/1", "https://b.example/2"]);
});

test("a live asset feed wins over the object story spec left beside it", () => {
  // The shell is pre-DCO configuration; serving comes from the feed. Merging them would report a page
  // the ad no longer sends anyone to.
  const urls = clickDestinations({
    objectStorySpec: { link_data: { link: "https://stale.example/old" } },
    assetFeedSpec: { link_urls: [{ website_url: "https://live.example/new" }] },
  });
  expect(urls).toEqual(["https://live.example/new"]);
});

test("a carousel reports one destination per card", () => {
  const urls = clickDestinations({
    objectStorySpec: {
      link_data: {
        link: "https://shop.example/",
        child_attachments: [
          { link: "https://shop.example/a" },
          { link: "https://shop.example/b" },
          { link: "https://shop.example/a" }, // duplicate card target collapses
        ],
      },
    },
  });
  expect(urls).toEqual([
    "https://shop.example/",
    "https://shop.example/a",
    "https://shop.example/b",
  ]);
});

test("video and photo ads report their call-to-action target", () => {
  expect(
    clickDestinations({
      objectStorySpec: {
        video_data: { call_to_action: { value: { link: "https://v.example/x" } } },
      },
    }),
  ).toEqual(["https://v.example/x"]);
  expect(
    clickDestinations({
      objectStorySpec: {
        photo_data: { call_to_action: { value: { link: "https://p.example/y" } } },
      },
    }),
  ).toEqual(["https://p.example/y"]);
});

test("non-web targets are not landing pages", () => {
  // App deeplinks and macro-only catalog patterns resolve to no single page.
  expect(
    clickDestinations({
      objectStorySpec: { link_data: { link: "myapp://product/12" } },
    }),
  ).toEqual([]);
  expect(
    clickDestinations({ objectStorySpec: { link_data: { link: "{{product.url}}" } } }),
  ).toEqual([]);
  expect(clickDestinations({})).toEqual([]);
  // A lead form / messenger ad genuinely has no website destination.
  expect(clickDestinations({ objectStorySpec: { link_data: { picture: "x" } } })).toEqual([]);
});

test("grouping collapses tracking parameters but keeps distinct pages apart", () => {
  const grouped = groupByLandingPage([
    "https://t.example/go?utm_campaign={{campaign.name}}&id=1",
    "https://t.example/go?utm_campaign=other&id=2",
    "https://t.example/other",
    "https://t.example/go/", // trailing slash is the same page
  ]);
  expect(grouped.map((g) => g.page)).toEqual(["https://t.example/go", "https://t.example/other"]);
  // The first full URL is retained, so nothing is silently rewritten.
  expect(grouped[0].full).toBe("https://t.example/go?utm_campaign={{campaign.name}}&id=1");
});

test("an unparseable destination is kept whole rather than dropped", () => {
  expect(groupByLandingPage(["https://ok.example/a", "http://[bad"]).map((g) => g.page)).toEqual([
    "https://ok.example/a",
    "http://[bad",
  ]);
});
