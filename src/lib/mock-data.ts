// Mock data for the Meta Ads dashboard UI.
// SWAP POINT: replace these exports with calls to the Meta Marketing API
// (system user token, 1 BM, 50+ ad accounts) when wiring real data.

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(42);
const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
const range = (min: number, max: number) => min + rand() * (max - min);

export type AccountStatus = "ACTIVE" | "PAUSED" | "DISABLED" | "PENDING";
export type CampaignObjective =
  | "CONVERSIONS"
  | "TRAFFIC"
  | "REACH"
  | "VIDEO_VIEWS"
  | "APP_INSTALLS"
  | "LEAD_GEN"
  | "BRAND_AWARENESS";

export interface AdAccount {
  id: string;
  name: string;
  currency: string;
  status: AccountStatus;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  ctr: number;
  cpc: number;
  cpm: number;
  roas: number;
  reach: number;
  frequency: number;
  spark: number[];
}

const brands = [
  "Phoenix Retail", "Lumina Apparel", "Vanguard Tech", "Northwind Foods",
  "Atlas Outdoors", "Brio Beverages", "Halo Beauty", "Kairos Watches",
  "Meridian Travel", "Orion Fitness", "Sable Home", "Tessera Jewelry",
  "Verge Auto", "Zenith Audio", "Aurora Pets", "Cobalt Bikes",
  "Ember Coffee", "Fjord Outdoor", "Grove Organics", "Hearth Furniture",
  "Indigo Stationery", "Junipr Skincare", "Kindred Toys", "Lattice Books",
];
const regions = ["US", "EU", "UK", "APAC", "LATAM", "MENA", "CA", "AU", "DE", "JP"];
const segments = ["Prospecting", "Retargeting", "Brand", "Performance", "DPA", "Lookalike"];

function buildSpark(n = 14) {
  let v = range(40, 80);
  return Array.from({ length: n }, () => {
    v += range(-12, 14);
    v = Math.max(8, Math.min(100, v));
    return Math.round(v);
  });
}

export const accounts: AdAccount[] = Array.from({ length: 54 }, (_, i) => {
  const brand = brands[i % brands.length];
  const region = regions[i % regions.length];
  const segment = segments[i % segments.length];
  const spend = Math.round(range(4_000, 180_000) * 100) / 100;
  const cpm = Math.round(range(4, 28) * 100) / 100;
  const impressions = Math.round((spend / cpm) * 1000);
  const ctr = Math.round(range(0.4, 4.5) * 100) / 100;
  const clicks = Math.round(impressions * (ctr / 100));
  const cpc = Math.round((spend / Math.max(1, clicks)) * 100) / 100;
  const conversions = Math.round(clicks * range(0.01, 0.08));
  const roas = Math.round(range(0.8, 6.2) * 100) / 100;
  const revenue = Math.round(spend * roas * 100) / 100;
  const reach = Math.round(impressions / range(1.1, 3.5));
  const frequency = Math.round((impressions / Math.max(1, reach)) * 100) / 100;
  const statuses: AccountStatus[] = ["ACTIVE", "ACTIVE", "ACTIVE", "ACTIVE", "PAUSED", "PENDING", "DISABLED"];
  return {
    id: `act_${10_000_000 + i * 137}`,
    name: `${brand} – ${region} ${segment}`,
    currency: "USD",
    status: statuses[i % statuses.length],
    spend, impressions, clicks, conversions, revenue,
    ctr, cpc, cpm, roas, reach, frequency,
    spark: buildSpark(),
  };
});

export const businessManager = {
  id: "1029384756102938",
  name: "Vantage Media Group",
  accountCount: accounts.length,
};

export function aggregate(list: AdAccount[]) {
  const spend = list.reduce((s, a) => s + a.spend, 0);
  const impressions = list.reduce((s, a) => s + a.impressions, 0);
  const clicks = list.reduce((s, a) => s + a.clicks, 0);
  const conversions = list.reduce((s, a) => s + a.conversions, 0);
  const revenue = list.reduce((s, a) => s + a.revenue, 0);
  const reach = list.reduce((s, a) => s + a.reach, 0);
  return {
    spend, impressions, clicks, conversions, revenue, reach,
    ctr: (clicks / Math.max(1, impressions)) * 100,
    cpc: spend / Math.max(1, clicks),
    cpm: (spend / Math.max(1, impressions)) * 1000,
    roas: revenue / Math.max(1, spend),
    frequency: impressions / Math.max(1, reach),
  };
}

// 30-day time series of spend + conversions + revenue
export const timeSeries = (() => {
  const days = 30;
  const today = new Date();
  let spend = range(8000, 14000);
  let conv = range(300, 600);
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (days - 1 - i));
    spend += range(-1200, 1500);
    conv += range(-50, 80);
    spend = Math.max(3000, spend);
    conv = Math.max(80, conv);
    const revenue = spend * range(2.5, 4.6);
    return {
      date: d.toISOString().slice(5, 10),
      spend: Math.round(spend),
      conversions: Math.round(conv),
      revenue: Math.round(revenue),
      roas: Math.round((revenue / spend) * 100) / 100,
    };
  });
})();

export type CampaignStatus = "ACTIVE" | "PAUSED" | "LEARNING" | "COMPLETED";

export interface Ad {
  id: string;
  name: string;
  status: CampaignStatus;
  spend: number;
  impressions: number;
  ctr: number;
  cpc: number;
  roas: number;
  conversions: number;
  format: "Image" | "Video" | "Carousel" | "Collection";
  thumbHue: number;
}
export interface AdSet {
  id: string;
  name: string;
  status: CampaignStatus;
  spend: number;
  ctr: number;
  roas: number;
  audience: string;
  ads: Ad[];
}
export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  objective: CampaignObjective;
  accountId: string;
  accountName: string;
  spend: number;
  impressions: number;
  conversions: number;
  ctr: number;
  cpc: number;
  cpm: number;
  roas: number;
  adSets: AdSet[];
}

const objectives: CampaignObjective[] = [
  "CONVERSIONS", "TRAFFIC", "REACH", "VIDEO_VIEWS", "APP_INSTALLS", "LEAD_GEN", "BRAND_AWARENESS",
];
const campStatuses: CampaignStatus[] = ["ACTIVE", "ACTIVE", "ACTIVE", "LEARNING", "PAUSED", "COMPLETED"];
const audiences = [
  "Lookalike 1% – Purchasers", "Retargeting – Cart Abandoners", "Broad – 18-65",
  "Interest – Outdoor Enthusiasts", "Custom – Site Visitors 30d",
  "Lookalike 3% – Top Spenders", "Interest – Tech Early Adopters",
];

export const campaigns: Campaign[] = accounts.flatMap((acc, ai) => {
  const n = 2 + Math.floor(rand() * 3);
  return Array.from({ length: n }, (_, ci) => {
    const objective = objectives[(ai + ci) % objectives.length];
    const spend = Math.round(range(500, 40_000) * 100) / 100;
    const ctr = Math.round(range(0.3, 5) * 100) / 100;
    const cpm = Math.round(range(4, 30) * 100) / 100;
    const impressions = Math.round((spend / cpm) * 1000);
    const clicks = Math.round(impressions * (ctr / 100));
    const cpc = Math.round((spend / Math.max(1, clicks)) * 100) / 100;
    const conversions = Math.round(clicks * range(0.01, 0.08));
    const roas = Math.round(range(0.6, 7) * 100) / 100;
    const adSetCount = 1 + Math.floor(rand() * 3);
    const adSets: AdSet[] = Array.from({ length: adSetCount }, (_, si) => {
      const adCount = 1 + Math.floor(rand() * 3);
      const ads: Ad[] = Array.from({ length: adCount }, (_, adi) => ({
        id: `ad_${ai}_${ci}_${si}_${adi}`,
        name: `Creative_${["A", "B", "C", "D"][adi % 4]}_${["Square", "Story", "Reel", "Feed"][adi % 4]}`,
        status: pick(campStatuses),
        spend: Math.round(range(100, 8000) * 100) / 100,
        impressions: Math.round(range(5000, 200_000)),
        ctr: Math.round(range(0.3, 5.2) * 100) / 100,
        cpc: Math.round(range(0.4, 4.5) * 100) / 100,
        roas: Math.round(range(0.5, 7.5) * 100) / 100,
        conversions: Math.round(range(5, 600)),
        format: pick(["Image", "Video", "Carousel", "Collection"] as const),
        thumbHue: Math.floor(rand() * 360),
      }));
      return {
        id: `adset_${ai}_${ci}_${si}`,
        name: `${pick(["US", "EU", "UK", "APAC", "Global"])} | ${audiences[(si + ci) % audiences.length]}`,
        status: pick(campStatuses),
        spend: Math.round(ads.reduce((s, a) => s + a.spend, 0) * 100) / 100,
        ctr: Math.round(range(0.4, 4.8) * 100) / 100,
        roas: Math.round(range(0.7, 6.5) * 100) / 100,
        audience: audiences[(si + ci) % audiences.length],
        ads,
      };
    });
    return {
      id: `camp_${ai}_${ci}`,
      name: `[${objective.slice(0, 3)}] ${acc.name.split(" – ")[0]} ${["Q4 Launch", "Always-On", "Black Friday", "Spring Drop", "Brand Lift", "App Drive"][ci % 6]}`,
      status: pick(campStatuses),
      objective,
      accountId: acc.id,
      accountName: acc.name,
      spend, impressions, conversions, ctr, cpc, cpm, roas,
      adSets,
    };
  });
});

export const creatives = campaigns.flatMap(c => c.adSets.flatMap(s => s.ads.map(ad => ({
  ...ad,
  campaign: c.name,
  account: c.accountName,
})))).slice(0, 36);

// Breakdowns
export const ageBreakdown = [
  { label: "13–17", spend: 12_500, conversions: 320, roas: 1.8 },
  { label: "18–24", spend: 84_200, conversions: 2_140, roas: 3.1 },
  { label: "25–34", spend: 168_900, conversions: 5_220, roas: 4.4 },
  { label: "35–44", spend: 124_300, conversions: 3_410, roas: 3.9 },
  { label: "45–54", spend: 78_400, conversions: 1_820, roas: 2.7 },
  { label: "55–64", spend: 41_200, conversions: 920, roas: 2.1 },
  { label: "65+", spend: 18_600, conversions: 380, roas: 1.6 },
];
export const genderBreakdown = [
  { label: "Female", spend: 312_400, conversions: 8_120, roas: 3.8 },
  { label: "Male", spend: 198_700, conversions: 5_240, roas: 3.2 },
  { label: "Unknown", spend: 17_000, conversions: 220, roas: 1.4 },
];
export const placementBreakdown = [
  { label: "Facebook Feed", spend: 184_300, conversions: 4_910, roas: 3.6 },
  { label: "Instagram Feed", spend: 142_900, conversions: 4_120, roas: 4.1 },
  { label: "Instagram Reels", spend: 98_400, conversions: 2_840, roas: 3.9 },
  { label: "Instagram Stories", spend: 62_700, conversions: 1_510, roas: 3.2 },
  { label: "Facebook Stories", spend: 24_800, conversions: 480, roas: 2.4 },
  { label: "Audience Network", spend: 9_200, conversions: 180, roas: 1.7 },
  { label: "Messenger", spend: 5_400, conversions: 95, roas: 1.5 },
];
export const deviceBreakdown = [
  { label: "iOS", spend: 248_100, conversions: 6_420, roas: 4.0 },
  { label: "Android", spend: 201_800, conversions: 5_310, roas: 3.5 },
  { label: "Desktop", spend: 64_900, conversions: 1_640, roas: 3.0 },
  { label: "Other", spend: 12_300, conversions: 210, roas: 1.8 },
];
export const countryBreakdown = [
  { label: "United States", spend: 218_400, conversions: 5_810, roas: 4.2 },
  { label: "United Kingdom", spend: 84_200, conversions: 2_140, roas: 3.8 },
  { label: "Germany", spend: 64_900, conversions: 1_710, roas: 3.5 },
  { label: "France", spend: 52_300, conversions: 1_320, roas: 3.3 },
  { label: "Canada", spend: 41_800, conversions: 1_040, roas: 3.6 },
  { label: "Australia", spend: 38_200, conversions: 920, roas: 3.4 },
  { label: "Japan", spend: 27_100, conversions: 610, roas: 2.9 },
  { label: "Brazil", spend: 21_400, conversions: 480, roas: 2.4 },
];

export function fmtCurrency(n: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency, maximumFractionDigits: n >= 1000 ? 0 : 2,
  }).format(n);
}
export function fmtNumber(n: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}
export function fmtCompact(n: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
export function fmtPct(n: number, digits = 2) {
  return `${n.toFixed(digits)}%`;
}
