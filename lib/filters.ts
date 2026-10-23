import { endOfDay, startOfDay, startOfYear, subDays, subMonths } from "date-fns";

export type RawSearchParams = Record<string, string | string[] | undefined>;

export const RANGE_PRESETS = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "12m", label: "Last 12 months" },
  { value: "ytd", label: "Year to date" },
  { value: "all", label: "All time" },
  { value: "custom", label: "Custom range" },
] as const;

export type ListFilters = {
  q: string;
  brand: string | null;
  status: string | null;
  agent: string | null;
  entity: string | null;
  type: string | null;
  customer: string | null;
  range: string;
  from: Date | null;
  to: Date | null;
  page: number;
};

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
const clean = (v: string | null, max = 80) => (v ? v.trim().slice(0, max) : null);

function parseDate(v: string | null): Date | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Resolves a date-range preset relative to `now`. */
export function resolveRange(range: string, now: Date, from?: Date | null, to?: Date | null) {
  switch (range) {
    case "7d":
      return { from: startOfDay(subDays(now, 6)), to: endOfDay(now) };
    case "30d":
      return { from: startOfDay(subDays(now, 29)), to: endOfDay(now) };
    case "90d":
      return { from: startOfDay(subDays(now, 89)), to: endOfDay(now) };
    case "12m":
      return { from: startOfDay(subMonths(now, 12)), to: endOfDay(now) };
    case "ytd":
      return { from: startOfYear(now), to: endOfDay(now) };
    case "custom":
      return { from: from ? startOfDay(from) : null, to: to ? endOfDay(to) : null };
    default:
      return { from: null, to: null };
  }
}

/** Parses the shared list/report filter vocabulary. Values are validated again by the queries' scoping. */
export function parseFilters(sp: RawSearchParams, now: Date, defaults: { range?: string } = {}): ListFilters {
  const range = clean(one(sp.range)) ?? defaults.range ?? "all";
  const valid = RANGE_PRESETS.some((r) => r.value === range) ? range : "all";
  const { from, to } = resolveRange(valid, now, parseDate(one(sp.from)), parseDate(one(sp.to)));
  const page = Math.max(1, Math.min(10_000, Number.parseInt(one(sp.page) ?? "1", 10) || 1));
  return {
    q: clean(one(sp.q), 120) ?? "",
    brand: clean(one(sp.brand)),
    status: clean(one(sp.status)),
    agent: clean(one(sp.agent)),
    entity: clean(one(sp.entity)),
    type: clean(one(sp.type)),
    customer: clean(one(sp.customer)),
    range: valid,
    from,
    to,
    page,
  };
}

export function toQueryString(sp: RawSearchParams, overrides: Record<string, string | null | undefined> = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const val = one(v);
    if (val) params.set(k, val);
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null || v === undefined || v === "") params.delete(k);
    else params.set(k, v);
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export const PAGE_SIZE = 25;
