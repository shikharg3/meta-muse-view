/**
 * Report export — the one document shape that becomes an on-screen table, a CSV file, and the
 * branded PDF.
 *
 * The internal report engine (`ReportBlock`) and the client portal's self-serve export both render
 * through here, so a report reads the same whoever produced it and a cell can never say one thing in
 * the CSV and another in the PDF.
 *
 * The DOT palette below is the only definition of the brand for print.
 */
import type { jsPDF } from "jspdf";

import { downloadCsvRows } from "@/lib/download";
import { fmtCompact, fmtCurrency, fmtNumber, fmtPct } from "@/lib/format";
import { metric, type ReportColumnKind } from "@/lib/report-catalog";
import { DOT_LOGO } from "@/lib/report-logo";

// ------------------------------------------------------------------ brand

type Rgb = [number, number, number];

/** DOT colour palette, as jsPDF channel triples. */
export const DOT: {
  violet: Rgb;
  mint: Rgb;
  indigo: Rgb;
  graphite: Rgb;
  ink: Rgb;
  mist: Rgb;
  white: Rgb;
} = {
  violet: [88, 40, 196], // #5828c4 — primary
  mint: [0, 219, 150], // #00db96 — secondary series
  indigo: [45, 20, 111], // #2d146f — deep accent
  graphite: [62, 62, 62], // #3e3e3e — body text
  ink: [33, 33, 33], // #212121 — headings, table head
  mist: [238, 238, 238], // #eeeeee — rules, zebra, chart tracks
  white: [255, 255, 255], // #ffffff — type on the violet band
};

// ------------------------------------------------------------------ document

export interface ReportDocColumn {
  key: string;
  label: string;
  kind: ReportColumnKind;
}

export interface ReportDoc {
  title: string;
  subtitle: string;
  note?: string | null;
  /** Columns in display order. The leading run of `text` columns identifies the row. */
  columns: ReportDocColumn[];
  /**
   * Cells aligned to `columns`: strings for the leading columns, numbers for metrics. A null cell is
   * a metric this row cannot report — Meta de-duplicates it per row, so it is withheld rather than
   * summed. It prints as an em dash in the table, the CSV and the PDF: a blank would read as zero,
   * and a zero would be a lie.
   */
  rows: (string | number | null)[][];
  /** Totals aligned to `columns`, or null when the only row already is the total. */
  totals?: (string | number | null)[] | null;
  /** Download name, without extension. */
  filename: string;
}

const WITHHELD = "—";

/** Display form of a cell, per column kind — the on-screen table and the PDF summary agree by this. */
export function showCell(value: string | number | null, kind: ReportColumnKind): string {
  if (value === null) return WITHHELD;
  if (typeof value === "string") return value;
  switch (kind) {
    case "money":
      return fmtCurrency(value);
    case "pct":
      return fmtPct(value);
    case "int":
      return fmtNumber(value);
    default:
      return value.toFixed(2);
  }
}

/** Plain form of a cell: rounded, no symbols, so a spreadsheet can total the column. */
export function plainCell(value: string | number | null, kind: ReportColumnKind): string {
  if (value === null) return WITHHELD;
  if (typeof value === "string") return value;
  if (kind === "int") return String(Math.round(value));
  return value.toFixed(2);
}

const plainRow = (cells: (string | number | null)[], columns: ReportDocColumn[]): string[] =>
  cells.map((v, i) => plainCell(v, columns[i].kind));

export function downloadReportCsv(d: ReportDoc): void {
  downloadCsvRows(
    [
      d.columns.map((c) => c.label),
      ...d.rows.map((r) => plainRow(r, d.columns)),
      ...(d.totals ? [plainRow(d.totals, d.columns)] : []),
    ],
    `${d.filename}.csv`,
  );
}

// ------------------------------------------------------------------ chartable metrics

/**
 * Ranking for the metric a chart is drawn from: money and volume first, since that is what a client
 * looks for. Anything unlisted keeps its column order behind these.
 */
const CHART_PRIORITY = [
  "spend",
  "results",
  "conversions",
  "purchases",
  "leads",
  "registrations",
  "regs",
  "deposits",
  "conversion_value",
  "link_clicks",
  "clicks",
  "landing_page_views",
  "impressions",
  "reach",
];

/**
 * Can this column be drawn as a bar? Only sums can: a rate or a cost-per is an average, and a bar
 * chart of averages beside a totals row misleads. Every catalog ratio is a `derived` metric, so that
 * one check covers all of them and any future one; portal-local keys fall back to their name.
 */
function isSummable(c: ReportDocColumn): boolean {
  if (c.kind !== "money" && c.kind !== "int") return false;
  const m = metric(c.key);
  if (m) return m.source.kind !== "derived";
  return !/cost|cp[cmp]|rate|ctr|roas|freq|avg|average/i.test(c.key);
}

/** Column indices worth charting, best first. Empty when the report has nothing summable. */
export function chartableColumns(d: ReportDoc): number[] {
  const rank = (key: string): number => {
    const i = CHART_PRIORITY.indexOf(key);
    return i === -1 ? CHART_PRIORITY.length : i;
  };
  return d.columns
    .map((c, i) => i)
    .filter(
      (i) =>
        isSummable(d.columns[i]) &&
        d.rows.some((r) => typeof r[i] === "number" && (r[i] as number) > 0),
    )
    .sort((a, b) => rank(d.columns[a].key) - rank(d.columns[b].key));
}

// ------------------------------------------------------------------ pdf primitives

const MARGIN = 14;
/** Height of the violet logo band on the first page. */
const BAND_H = 19;
/** Top boundary for pages after the first — clears the accent bar. */
const CONTINUED_TOP = 18;
const PLOT_H = 28;
const CHART_GAP = 8;

const fill = (doc: jsPDF, c: Rgb): void => void doc.setFillColor(c[0], c[1], c[2]);
const ink = (doc: jsPDF, c: Rgb): void => void doc.setTextColor(c[0], c[1], c[2]);

function hairline(doc: jsPDF, x: number, y: number, x2: number, c: Rgb = DOT.mist, wt = 0.3): void {
  doc.setDrawColor(c[0], c[1], c[2]);
  doc.setLineWidth(wt);
  doc.line(x, y, x2, y);
}

/**
 * jsPDF's built-in Helvetica encodes WinAnsi only, so a glyph outside it silently vanishes from the
 * page. The report engine puts "→" in every subtitle and rented-account names carry fullwidth
 * punctuation, so map what the app actually emits; anything else is left to jsPDF.
 */
const SUBSTITUTES: [RegExp, string][] = [
  [/[→⟶⇒←⟵]/g, "–"],
  [/[✓✔]/g, "+"],
  [/[✗✘✕×]/g, "x"],
  [/≥/g, ">="],
  [/≤/g, "<="],
  [/（/g, "("],
  [/）/g, ")"],
  [/[；]/g, ";"],
];

function pdfText(s: string): string {
  if (!/[^\u0020-\u007e]/.test(s)) return s;
  let out = s;
  for (const [re, to] of SUBSTITUTES) out = out.replace(re, to);
  return out;
}

/** Truncate to `maxW` mm at the current font. Call with the font and size already set. */
function fit(doc: jsPDF, text: string, maxW: number): string {
  if (doc.getTextWidth(text) <= maxW) return text;
  let s = text;
  while (s.length > 1 && doc.getTextWidth(`${s}…`) > maxW) s = s.slice(0, -1);
  return `${s}…`;
}

// ------------------------------------------------------------------ pdf blocks

/** Logo band, title, range and note. Returns the y the next block starts at. */
function drawHeader(doc: jsPDF, d: ReportDoc, pageW: number, w: number): number {
  const right = pageW - MARGIN;

  // The mark is white, so it gets a violet ground. The band also absorbs the thin accent bar
  // `drawChrome` paints on every page — same colour, so the overdraw is invisible.
  fill(doc, DOT.violet);
  doc.rect(0, 0, pageW, BAND_H, "F");
  const logoH = 6.6;
  doc.addImage(DOT_LOGO.png, "PNG", MARGIN, (BAND_H - logoH) / 2, logoH * DOT_LOGO.aspect, logoH);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(6.6);
  doc.setCharSpace(0.7);
  ink(doc, DOT.white);
  doc.text("PERFORMANCE REPORT", right, 8.4, { align: "right" });
  doc.setCharSpace(0);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  ink(doc, DOT.mist);
  doc.text(
    `Generated ${new Date().toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}`,
    right,
    13.2,
    { align: "right" },
  );

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15.5);
  ink(doc, DOT.ink);
  const titleTop = BAND_H + 9;
  const lines = (doc.splitTextToSize(pdfText(d.title), w) as string[]).slice(0, 2);
  lines.forEach((ln, i) => doc.text(ln, MARGIN, titleTop + i * 6.8));
  let y = titleTop + (lines.length - 1) * 6.8;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.4);
  ink(doc, DOT.graphite);
  y += 6.2;
  doc.text(pdfText(d.subtitle), MARGIN, y);

  if (d.note) {
    // The withheld-metrics note is two sentences long, so it wraps instead of running off the page.
    doc.setFontSize(7.4);
    ink(doc, DOT.indigo);
    for (const ln of (doc.splitTextToSize(pdfText(d.note), w) as string[]).slice(0, 3)) {
      y += 3.9;
      doc.text(ln, MARGIN, y);
    }
  }

  y += 4;
  hairline(doc, MARGIN, y, right);
  return y + 6.5;
}

/**
 * Headline figures: the report's own first four metric columns, read off the totals row (or the only
 * row). Deliberately not a curated pick — the columns the user chose are the ones they care about.
 */
function drawKpis(doc: jsPDF, d: ReportDoc, top: number, w: number): number {
  const src = d.totals ?? d.rows[0];
  if (!src) return top;
  const accents = [DOT.violet, DOT.mint, DOT.indigo, DOT.graphite];
  const cards: { label: string; value: string; accent: Rgb }[] = [];
  for (let i = 0; i < d.columns.length && cards.length < 4; i++) {
    const c = d.columns[i];
    if (c.kind === "text") continue;
    const v = src[i];
    cards.push({
      label: c.label,
      // A headline sub-$10 figure keeps its cents; whole dollars would print a CPC of $0.57 as "$1".
      value:
        typeof v === "number" && c.kind === "money" && Math.abs(v) < 10
          ? fmtCurrency(v, "USD", 2)
          : showCell(v, c.kind),
      accent: accents[cards.length],
    });
  }
  if (cards.length === 0) return top;

  const gap = 3.4;
  const h = 15.5;
  const cw = (w - gap * (cards.length - 1)) / cards.length;
  cards.forEach((card, i) => {
    const x = MARGIN + i * (cw + gap);
    fill(doc, DOT.mist);
    doc.roundedRect(x, top, cw, h, 1.4, 1.4, "F");
    fill(doc, card.accent);
    doc.circle(x + 4.2, top + 5.1, 1.05, "F");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.4);
    doc.setCharSpace(0.4);
    ink(doc, DOT.graphite);
    doc.text(fit(doc, pdfText(card.label).toUpperCase(), cw - 9), x + 7.2, top + 5.9);
    doc.setCharSpace(0);

    doc.setFontSize(13);
    ink(doc, DOT.ink);
    doc.text(fit(doc, card.value, cw - 8), x + 4.2, top + 12.6);
  });
  return top + h + 7;
}

interface Series {
  labels: string[];
  values: number[];
  metricLabel: string;
  dimLabel: string;
}

/** Columns read better for a short-labelled series; long labels need horizontal bars. */
const asColumns = (labels: string[]): boolean =>
  labels.length <= 62 && labels.every((l) => l.length <= 10);

function drawColumns(
  doc: jsPDF,
  s: Series,
  max: number,
  x: number,
  plotTop: number,
  w: number,
  color: Rgb,
): void {
  const plotBottom = plotTop + PLOT_H;
  hairline(doc, x, plotTop, x + w);
  const n = s.values.length;
  const slot = w / n;
  const bw = Math.max(0.9, Math.min(slot * 0.62, 8));

  fill(doc, color);
  s.values.forEach((v, i) => {
    if (v <= 0) return;
    const h = Math.max((v / max) * PLOT_H, 0.4);
    doc.rect(x + slot * i + (slot - bw) / 2, plotBottom - h, bw, h, "F");
  });
  hairline(doc, x, plotBottom, x + w, DOT.graphite, 0.25);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(5.6);
  if (n <= 8) {
    ink(doc, DOT.ink);
    s.values.forEach((v, i) =>
      doc.text(fmtCompact(v), x + slot * i + slot / 2, plotBottom - (v / max) * PLOT_H - 1.3, {
        align: "center",
      }),
    );
  }
  ink(doc, DOT.graphite);
  // An axis tick drops the year a bare ISO date carries — the range is already in the subtitle, and
  // the shorter tick is what lets every day of a month-long report keep a label. Anchored to the
  // whole label so a composite "date · dimension" row keeps both halves.
  const ticks = s.labels.map((l) => pdfText(/^\d{4}-(\d{2}-\d{2})$/.exec(l)?.[1] ?? l));
  const widest = Math.max(...ticks.map((t) => doc.getTextWidth(t)));
  const step = Math.max(1, Math.ceil((widest + 1.4) / slot));
  ticks.forEach((t, i) => {
    if (i % step !== 0) return;
    const cx = x + slot * i + slot / 2;
    if (cx + widest / 2 > x + w + 2) return; // would bleed into the next chart
    doc.text(t, cx, plotBottom + 3.4, { align: "center" });
  });
}

function drawBars(
  doc: jsPDF,
  s: Series,
  max: number,
  x: number,
  plotTop: number,
  w: number,
  color: Rgb,
  count: number,
): void {
  const items = s.labels
    .map((l, i) => ({ l, v: s.values[i] }))
    .sort((a, b) => b.v - a.v)
    .slice(0, count);
  const rowH = PLOT_H / items.length;
  const labelW = Math.min(38, w * 0.36);
  const trackX = x + labelW + 2;
  const trackW = Math.max(6, w - labelW - 16);

  items.forEach((it, i) => {
    const cy = plotTop + rowH * i + rowH / 2;
    fill(doc, DOT.mist);
    doc.rect(trackX, cy - 1.5, trackW, 3, "F");
    if (it.v > 0) {
      fill(doc, color);
      doc.rect(trackX, cy - 1.5, Math.max((it.v / max) * trackW, 0.4), 3, "F");
    }
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.4);
    ink(doc, DOT.ink);
    doc.text(fit(doc, pdfText(it.l), labelW), x, cy + 1.1);
    ink(doc, DOT.graphite);
    doc.text(fmtCompact(it.v), x + w, cy + 1.1, { align: "right" });
  });
}

/** Caption, peak, and one plot. `top` is the block top; the caller owns vertical layout. */
function drawChart(doc: jsPDF, s: Series, x: number, top: number, w: number, color: Rgb): void {
  const max = Math.max(...s.values);
  if (max <= 0) return;
  const columns = asColumns(s.labels);
  const count = columns ? s.values.length : Math.min(6, s.values.length);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.2);
  ink(doc, DOT.graphite);
  const peak = `peak ${fmtCompact(max)}`;
  doc.text(peak, x + w, top + 3.2, { align: "right" });
  const peakW = doc.getTextWidth(peak);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(6.6);
  doc.setCharSpace(0.45);
  ink(doc, DOT.ink);
  // Dimension labels are singular ("Campaign", "Country"), so "top 6 by campaign" reads correctly
  // where a naive plural would not.
  const caption = columns
    ? `${s.metricLabel} by ${s.dimLabel}`
    : `${s.metricLabel} · top ${count} by ${s.dimLabel}`;
  doc.text(fit(doc, pdfText(caption).toUpperCase(), w - peakW - 4), x, top + 3.2);
  doc.setCharSpace(0);

  const plotTop = top + 6.6;
  if (columns) drawColumns(doc, s, max, x, plotTop, w, color);
  else drawBars(doc, s, max, x, plotTop, w, color, count);
}

/** Up to two charts side by side. Returns the y the table starts at. */
function drawCharts(doc: jsPDF, d: ReportDoc, top: number, w: number): number {
  // A report identifies its rows with a leading run of text columns — a period, a breakdown, or
  // both. All of them together name the bar; a report with none has nothing to plot against.
  let lead = 0;
  while (lead < d.columns.length && d.columns[lead].kind === "text") lead++;
  if (lead === 0 || d.rows.length < 2) return top;
  const picks = chartableColumns(d).slice(0, 2);
  if (picks.length === 0) return top;

  const labels = d.rows.map((r) =>
    r
      .slice(0, lead)
      .map((v) => String(v ?? ""))
      .filter((v) => v !== "")
      .join(" · "),
  );
  const dimLabel = d.columns
    .slice(0, lead)
    .map((c) => c.label)
    .join(" · ");
  const cw = picks.length === 1 ? w : (w - CHART_GAP) / 2;
  picks.forEach((ci, i) => {
    drawChart(
      doc,
      {
        labels,
        values: d.rows.map((r) => Math.max(Number(r[ci]) || 0, 0)),
        metricLabel: d.columns[ci].label,
        dimLabel,
      },
      MARGIN + i * (cw + CHART_GAP),
      top,
      cw,
      i === 0 ? DOT.violet : DOT.mint,
    );
  });
  return top + 6.6 + PLOT_H + 10;
}

function drawChrome(
  doc: jsPDF,
  title: string,
  page: number,
  pages: number,
  pageW: number,
  pageH: number,
): void {
  fill(doc, DOT.violet);
  doc.rect(0, 0, pageW, 2.6, "F");

  const baseline = pageH - 7.4;
  hairline(doc, MARGIN, pageH - 11, pageW - MARGIN);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(6.4);
  doc.setCharSpace(0.5);
  ink(doc, DOT.violet);
  doc.text("dot.", MARGIN, baseline);
  doc.setCharSpace(0);

  doc.setFont("helvetica", "normal");
  ink(doc, DOT.graphite);
  const stamp = `Page ${page} of ${pages}`;
  const stampW = doc.getTextWidth(stamp);
  doc.text(fit(doc, pdfText(title), pageW - MARGIN * 2 - stampW - 18), MARGIN + 9, baseline);
  doc.text(stamp, pageW - MARGIN, baseline, { align: "right" });
}

// ------------------------------------------------------------------ pdf

/** Render the document. Separate from the download so it can be produced and inspected off-DOM. */
export async function buildReportPdf(d: ReportDoc): Promise<jsPDF> {
  // Exception (ts-no-dynamic-import): jspdf + autotable are heavy and only needed on an explicit
  // export click, so they are lazy-loaded to stay out of the main bundle.
  const { default: jsPDFCtor } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");

  const doc = new jsPDFCtor({
    orientation: d.columns.length > 6 ? "landscape" : "portrait",
    unit: "mm",
    format: "a4",
    // jsPDF embeds the logo as raw pixels plus an alpha mask (~180kB); deflating the streams takes
    // a two-page report back to ~17kB, and the table text compresses with it.
    compress: true,
  });
  doc.setDocumentProperties({
    title: d.title,
    subject: d.subtitle,
    author: "DOT",
    creator: "DOT Analytics",
  });

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const w = pageW - MARGIN * 2;

  let y = drawHeader(doc, d, pageW, w);
  y = drawKpis(doc, d, y, w);
  y = drawCharts(doc, d, y, w);

  const columnStyles: Record<string, { halign: "left" | "right"; textColor?: Rgb }> = {};
  d.columns.forEach((c, i) => {
    columnStyles[String(i)] =
      c.kind === "text" ? { halign: "left", textColor: DOT.ink } : { halign: "right" };
  });

  autoTable(doc, {
    head: [d.columns.map((c) => pdfText(c.label))],
    body: d.rows.map((r) => plainRow(r, d.columns).map(pdfText)),
    ...(d.totals ? { foot: [plainRow(d.totals, d.columns).map(pdfText)] } : {}),
    startY: y,
    margin: { top: CONTINUED_TOP, left: MARGIN, right: MARGIN, bottom: 16 },
    theme: "plain",
    styles: {
      font: "helvetica",
      fontSize: 7.6,
      textColor: DOT.graphite,
      cellPadding: { top: 1.9, bottom: 1.9, left: 2.4, right: 2.4 },
    },
    headStyles: { fillColor: DOT.ink, textColor: 255, fontStyle: "bold", fontSize: 7.2 },
    alternateRowStyles: { fillColor: DOT.mist },
    footStyles: { fillColor: DOT.violet, textColor: 255, fontStyle: "bold", fontSize: 7.6 },
    columnStyles,
    showHead: "everyPage",
    showFoot: "lastPage",
  });

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    drawChrome(doc, d.title, p, pages, pageW, pageH);
  }
  return doc;
}

export async function downloadReportPdf(d: ReportDoc): Promise<void> {
  const doc = await buildReportPdf(d);
  doc.save(`${d.filename}.pdf`);
}
