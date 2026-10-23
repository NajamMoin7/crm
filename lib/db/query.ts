/** Small helpers shared by the MongoDB queries. */
import type { Document } from "mongodb";

export const NONE = "__none__";
/** `$in` list that never matches when empty. */
export const ids = (list: readonly string[]) => (list.length ? [...list] : [NONE]);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Case-insensitive "contains" match (SQL ILIKE '%q%'). */
export const contains = (q: string) => new RegExp(escape(q), "i");
/** Case-insensitive exact match (lower(a) = lower(b)). */
export const equalsCi = (q: string) => new RegExp(`^${escape(q)}$`, "i");

/** Money fields are decimal strings; aggregate them exactly as Decimal128. */
export const dec = (expr: unknown) => ({ $toDecimal: { $ifNull: [expr, "0"] } });
export const sumDec = (expr: unknown) => ({ $sum: dec(expr) });

/** Decimal128 / number / string → plain decimal string ("123.45"). */
export function decStr(v: unknown): string {
  if (v == null) return "0";
  const s = typeof v === "object" && "toString" in (v as object) ? String(v) : String(v);
  return /e/i.test(s) ? String(Number(s)) : s;
}

/** Map rows by a key, for application-side joins. */
export function byKey<T, K extends keyof T>(rows: T[], key: K): Map<T[K], T> {
  return new Map(rows.map((r) => [r[key], r]));
}

/** Unique non-null values of a field, for `$in` lookups. */
export function uniq<T>(values: (T | null | undefined)[]): T[] {
  return [...new Set(values.filter((v): v is T => v != null))];
}

/** Start of the current UTC day / month / year, as used by the dashboard periods. */
export const startOf = (unit: "day" | "month" | "year", d = new Date()) =>
  unit === "day"
    ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    : unit === "month"
      ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
      : new Date(Date.UTC(d.getUTCFullYear(), 0, 1));

export type Pipeline = Document[];
