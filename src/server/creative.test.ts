import { test, expect } from "bun:test";
import {
  creativeFormat,
  creativeImageUrl,
  hueFromId,
  resultSpec,
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

test("resultSpec maps objectives to result actions with purchase default", () => {
  expect(resultSpec("OUTCOME_LEADS")).toEqual({ type: "lead", label: "Leads" });
  expect(resultSpec("LEAD_GENERATION").type).toBe("lead");
  expect(resultSpec("OUTCOME_TRAFFIC").type).toBe("link_click");
  expect(resultSpec("OUTCOME_SALES").type).toBe("omni_purchase");
  expect(resultSpec("OUTCOME_AWARENESS").type).toBe("reach");
  expect(resultSpec("VIDEO_VIEWS").type).toBe("video_view");
  expect(resultSpec(null)).toEqual({ type: "omni_purchase", label: "Purchases" });
  expect(resultSpec("SOMETHING_NEW").type).toBe("omni_purchase");
});
