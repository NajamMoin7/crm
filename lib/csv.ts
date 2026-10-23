/**
 * RFC 4180 CSV encoding with spreadsheet formula-injection protection.
 * - Fields containing quotes, commas, CR or LF are quoted; quotes are doubled.
 * - Text cells that start with = + - @ (or TAB / CR) are prefixed with an
 *   apostrophe so spreadsheet apps never evaluate them as formulas. Numeric
 *   cells we generate ourselves (numbers, money) are written as plain numbers.
 * - Lines end with CRLF; the stream begins with a UTF-8 BOM so Excel detects UTF-8.
 */

/** `{ raw }` marks a trusted, server-generated numeric string (e.g. money "1234.50") that is written verbatim. */
export type CsvValue = string | number | boolean | Date | { raw: string } | null | undefined;
export type CsvColumn<R> = { header: string; value: (row: R) => CsvValue };

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(v: CsvValue): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (typeof v === "number") s = Number.isFinite(v) ? String(v) : "";
  else if (typeof v === "boolean") s = v ? "true" : "false";
  else if (v instanceof Date) s = Number.isNaN(v.getTime()) ? "" : v.toISOString();
  else if (typeof v === "object") s = /^-?\d+(\.\d+)?$/.test(v.raw) ? v.raw : `'${v.raw}`;
  else {
    s = String(v);
    if (FORMULA_START.test(s)) s = `'${s}`;
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values: CsvValue[]): string {
  return values.map(csvCell).join(",") + "\r\n";
}

export const BOM = "﻿";

/** Streams header + rows as a UTF-8 CSV body, in chunks so large exports don't build one giant string. */
export function csvStream<R>(columns: CsvColumn<R>[], rows: R[], chunkSize = 500): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  let started = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(enc.encode(BOM + csvLine(columns.map((c) => c.header))));
        return;
      }
      if (i >= rows.length) {
        controller.close();
        return;
      }
      let chunk = "";
      for (const end = Math.min(rows.length, i + chunkSize); i < end; i++) chunk += csvLine(columns.map((c) => c.value(rows[i])));
      controller.enqueue(enc.encode(chunk));
    },
  });
}

/** Minimal RFC 4180 parser (used by tests / tooling). */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
