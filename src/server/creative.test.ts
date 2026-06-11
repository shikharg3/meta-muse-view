import { test, expect } from "bun:test";
import { creativeFormat, hueFromId } from "./creative";

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
