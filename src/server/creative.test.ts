import { test, expect } from "bun:test";
import {
  creativeFormat,
  creativeImageUrl,
  hueFromId,
  resultSpec,
  resultCount,
  isReachSpec,
  unanimousEvent,
  type CreativeFacts,
} from "./creative";

const facts = (over: Partial<CreativeFacts> = {}): CreativeFacts => ({
  objectType: null,
  imageUrl: null,
  videoImageUrl: null,
  linkPicture: null,
  childAttachments: 0,
  thumbnailUrl: null,
  ...over,
});

test("creativeFormat maps projected creative fields to display formats", () => {
  expect(creativeFormat(facts({ objectType: "VIDEO" }))).toBe("Video");
  expect(creativeFormat(facts({ objectType: "SHARE" }))).toBe("Image");
  expect(creativeFormat(facts())).toBe("Image");
  expect(creativeFormat(undefined)).toBe("Image");
  expect(creativeFormat(facts({ childAttachments: 2 }))).toBe("Carousel");
  // a single attachment is not a carousel
  expect(creativeFormat(facts({ childAttachments: 1 }))).toBe("Image");
  // carousel wins over object type
  expect(creativeFormat(facts({ childAttachments: 3, objectType: "VIDEO" }))).toBe("Carousel");
});

test("hueFromId is stable and in range", () => {
  expect(hueFromId("123456")).toBe(hueFromId("123456"));
  expect(hueFromId("a")).not.toBe(hueFromId("b"));
  for (const id of ["1", "abc", "act_999", ""]) {
    const h = hueFromId(id);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  }
});

test("creativeImageUrl prefers original image, then video poster, then link picture, then thumbnail", () => {
  expect(
    creativeImageUrl(
      facts({
        imageUrl: "https://cdn/full.jpg",
        videoImageUrl: "https://cdn/poster.jpg",
        thumbnailUrl: "https://cdn/thumb.jpg",
      }),
    ),
  ).toBe("https://cdn/full.jpg");
  expect(
    creativeImageUrl(
      facts({ videoImageUrl: "https://cdn/poster.jpg", thumbnailUrl: "https://cdn/thumb.jpg" }),
    ),
  ).toBe("https://cdn/poster.jpg");
  expect(
    creativeImageUrl(
      facts({ linkPicture: "https://cdn/link.jpg", thumbnailUrl: "https://cdn/thumb.jpg" }),
    ),
  ).toBe("https://cdn/link.jpg");
  expect(creativeImageUrl(facts({ thumbnailUrl: "https://cdn/thumb.jpg" }))).toBe(
    "https://cdn/thumb.jpg",
  );
  expect(creativeImageUrl(facts())).toBeNull();
  expect(creativeImageUrl(undefined)).toBeNull();
  // empty strings are skipped, not returned
  expect(creativeImageUrl(facts({ imageUrl: "", thumbnailUrl: "https://cdn/thumb.jpg" }))).toBe(
    "https://cdn/thumb.jpg",
  );
});

test("resultSpec falls back to the objective, purchases by default", () => {
  expect(resultSpec("OUTCOME_LEADS").label).toBe("Leads");
  expect(resultSpec("OUTCOME_LEADS").types).toContain("lead");
  expect(resultSpec("LEAD_GENERATION").label).toBe("Leads");
  expect(resultSpec("OUTCOME_TRAFFIC").types).toContain("link_click");
  expect(resultSpec("OUTCOME_SALES").types).toContain("omni_purchase");
  expect(isReachSpec(resultSpec("OUTCOME_AWARENESS"))).toBe(true);
  expect(resultSpec("VIDEO_VIEWS").types).toContain("video_view");
  expect(resultSpec(null).label).toBe("Purchases");
  expect(resultSpec("SOMETHING_NEW").label).toBe("Purchases");
});

test("the ad sets' optimised event outranks the objective", () => {
  // betonline: objective OUTCOME_LEADS, but the ad sets optimise COMPLETE_REGISTRATION. Meta never
  // emits a `lead` action for these, so trusting the objective reported a confident "0 Leads".
  const spec = resultSpec("OUTCOME_LEADS", "COMPLETE_REGISTRATION");
  expect(spec.label).toBe("Registrations");
  expect(spec.types).toContain("complete_registration");
  expect(spec.types).not.toContain("lead");

  // A real lead-form campaign is unaffected.
  expect(resultSpec("OUTCOME_LEADS", "LEAD").label).toBe("Leads");
  // An unrecognised event falls back rather than reporting nothing.
  expect(resultSpec("OUTCOME_SALES", "SOME_NEW_EVENT").label).toBe("Purchases");
  expect(resultSpec("OUTCOME_LEADS", null).label).toBe("Leads");
});

test("resultCount reads the first PRESENT alias and never sums them", () => {
  // Meta reported betonline's 47 registrations under five aliases, all 47. Summing gives 235.
  const reported = new Map([
    ["complete_registration", 47],
    ["omni_complete_registration", 47],
    ["offsite_conversion.fb_pixel_complete_registration", 47],
    ["offsite_complete_registration_add_meta_leads", 47],
    ["offsite_complete_registration_add_20_s_calls", 47],
  ]);
  const spec = resultSpec("OUTCOME_LEADS", "COMPLETE_REGISTRATION");
  expect(resultCount(spec, (t) => reported.get(t))).toBe(47);
});

test("resultCount distinguishes a reported zero from an absent action", () => {
  const spec = resultSpec("OUTCOME_SALES");
  // Absent everywhere → 0, and no crash.
  expect(resultCount(spec, () => undefined)).toBe(0);
  // A REPORTED zero on the preferred alias stops the search: it genuinely fired zero times, and
  // falling through to a later alias would invent a number from a different variant.
  const zeroFirst = new Map([
    [spec.types[0]!, 0],
    [spec.types[1]!, 9],
  ]);
  expect(resultCount(spec, (t) => zeroFirst.get(t))).toBe(0);
});

test("unanimousEvent needs agreement, and ignores ad sets declaring nothing", () => {
  expect(unanimousEvent(["PURCHASE", "PURCHASE"])).toBe("PURCHASE");
  // A leftover ad set with no event must not mask an otherwise unanimous conversion.
  expect(unanimousEvent(["COMPLETE_REGISTRATION", null, undefined])).toBe("COMPLETE_REGISTRATION");
  // Genuine disagreement has no honest single label → fall back to the objective.
  expect(unanimousEvent(["PURCHASE", "LEAD"])).toBeNull();
  expect(unanimousEvent([])).toBeNull();
  expect(unanimousEvent([null, null])).toBeNull();
});
