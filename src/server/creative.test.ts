import { test, expect } from "bun:test";
import { creativeFormat, creativeImageUrl, hueFromId, resultSpec } from "./creative";

test("creativeFormat maps creative raw payloads to display formats", () => {
  expect(creativeFormat({ object_type: "VIDEO" })).toBe("Video");
  expect(creativeFormat({ object_type: "SHARE" })).toBe("Image");
  expect(creativeFormat(null)).toBe("Image");
  expect(creativeFormat(undefined)).toBe("Image");
  expect(
    creativeFormat({ object_story_spec: { link_data: { child_attachments: [{}, {}] } } }),
  ).toBe("Carousel");
  // a single attachment is not a carousel
  expect(creativeFormat({ object_story_spec: { link_data: { child_attachments: [{}] } } })).toBe(
    "Image",
  );
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
      {
        image_url: "https://cdn/full.jpg",
        object_story_spec: { video_data: { image_url: "https://cdn/poster.jpg" } },
      },
      "https://cdn/thumb.jpg",
    ),
  ).toBe("https://cdn/full.jpg");
  expect(
    creativeImageUrl(
      { object_story_spec: { video_data: { image_url: "https://cdn/poster.jpg" } } },
      "https://cdn/thumb.jpg",
    ),
  ).toBe("https://cdn/poster.jpg");
  expect(
    creativeImageUrl(
      { object_story_spec: { link_data: { picture: "https://cdn/link.jpg" } } },
      "https://cdn/thumb.jpg",
    ),
  ).toBe("https://cdn/link.jpg");
  expect(creativeImageUrl({}, "https://cdn/thumb.jpg")).toBe("https://cdn/thumb.jpg");
  expect(creativeImageUrl(null, null)).toBeNull();
  // empty strings are skipped, not returned
  expect(creativeImageUrl({ image_url: "" }, "https://cdn/thumb.jpg")).toBe(
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
