import { describe, expect, it } from "bun:test";
import { pageFields } from "@/server/fns/portal-admin";
import {
  creativePageResolver,
  shapePortalCreatives,
  type AdCreativeRow,
  type CreativePage,
} from "@/server/fns/portal-creative";

describe("pageFields", () => {
  /**
   * The contract that matters most: `saveBrand` is also called by the create form and by anything
   * written before these columns existed. Sending neither key must touch neither column, or every
   * such save would silently erase the page identity an operator set up.
   */
  it("touches neither column when the caller sent neither key", () => {
    expect(pageFields({})).toEqual({ fields: {} });
  });

  it("clears a column with null or a blank value", () => {
    expect(pageFields({ pageName: "   ", pageAvatarUrl: null })).toEqual({
      fields: { pageName: null, pageAvatarUrl: null },
    });
  });

  it.each(["http://cdn.example.com/a.png", "javascript:alert(1)", "not a url"])(
    "refuses a profile photo that is not an https URL: %s",
    (url) => {
      expect(pageFields({ pageAvatarUrl: url })).toEqual({
        error: "Profile photo must be an https:// image URL",
      });
    },
  );

  it("accepts a page name up to Facebook's 75-character limit and no longer", () => {
    expect(pageFields({ pageName: "x".repeat(75) })).toEqual({
      fields: { pageName: "x".repeat(75) },
    });
    expect("error" in pageFields({ pageName: "x".repeat(76) })).toBe(true);
  });
});

const ad = (id: string, campaignId: string): AdCreativeRow => ({
  id,
  campaignId,
  creativeName: null,
  thumbnailUrl: null,
  body: null,
  title: null,
  callToActionType: null,
  linkUrl: "https://landing.example/offer",
  storySpec: null,
  feedSpec: null,
  objectType: null,
  imageUrl: null,
  videoImageUrl: null,
  linkPicture: null,
  childAttachments: 0,
});

describe("shapePortalCreatives page identity", () => {
  /**
   * A client granted two brands sees both on one Creative page. Each card must carry the page of
   * the brand that owns ITS campaign — a card showing the other brand's name is exactly the mix-up
   * a single fixed page per brand exists to prevent.
   */
  it("gives each card the page of its own campaign's brand", () => {
    const pages: Record<string, CreativePage> = {
      c_one: { name: "Brand One", avatarUrl: "https://media.example/one.png" },
      c_two: { name: "Brand Two", avatarUrl: null },
    };
    const cards = shapePortalCreatives(
      [ad("ad_1", "c_one"), ad("ad_2", "c_two")],
      [],
      new Map(),
      () => 0,
      (campaignId) => pages[campaignId] ?? null,
    );
    const pageOf = Object.fromEntries(cards.map((c) => [c.id, c.page]));
    expect(pageOf).toEqual({ ad_1: pages.c_one, ad_2: pages.c_two });
  });
});

describe("creativePageResolver", () => {
  const brand = {
    id: "b1",
    clientId: "owner",
    name: "Acme",
    pageName: "Acme Casino",
    pageAvatarUrl: "https://media.example/acme.png",
    defaultCommission: null,
    accountIds: [],
  };
  const project = (pageId: string, pageName: string | null, pageAvatarUrl: string | null) => ({
    pageId,
    title: pageId,
    brandId: "b1",
    pageName,
    pageAvatarUrl,
    commission: null,
  });
  const pageOf = creativePageResolver({
    brands: [brand, { ...brand, id: "b_bare", pageName: null, pageAvatarUrl: null }],
    brandOf: new Map([
      ["c_named", "b1"],
      ["c_inherit", "b1"],
      ["c_bare", "b_bare"],
    ]),
    projectOf: new Map([
      ["c_named", "p_named"],
      ["c_inherit", "p_inherit"],
    ]),
    projects: new Map([
      ["p_named", project("p_named", "Acme Sports", null)],
      ["p_inherit", project("p_inherit", null, null)],
    ]),
  });

  it("overrides field by field, so a project that renames its page keeps the client's photo", () => {
    expect(pageOf("c_named")).toEqual({
      name: "Acme Sports",
      avatarUrl: "https://media.example/acme.png",
    });
  });

  it("inherits the client's ad page when the project sets nothing", () => {
    expect(pageOf("c_inherit")).toEqual({
      name: "Acme Casino",
      avatarUrl: "https://media.example/acme.png",
    });
  });

  it("falls back to the client's own name, and no photo, when nothing is set", () => {
    expect(pageOf("c_bare")).toEqual({ name: "Acme", avatarUrl: null });
  });

  it("returns nothing for a campaign outside the scope", () => {
    expect(pageOf("c_elsewhere")).toBeNull();
  });
});
