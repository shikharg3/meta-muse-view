/** Trigger a browser download of in-memory content (client-only; needs a DOM). */
export function downloadBlob(content: BlobPart, type: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Quote a CSV cell only when it contains a delimiter, quote, or newline. */
export const csvCell = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Serialize a matrix to CSV and download it. */
export function downloadCsvRows(rows: string[][], filename: string): void {
  downloadBlob(
    rows.map((r) => r.map(csvCell).join(",")).join("\n"),
    "text/csv;charset=utf-8",
    filename,
  );
}
