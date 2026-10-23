import { format, formatDistanceStrict } from "date-fns";

export function fmtDate(d: Date | string | null | undefined, pattern = "MMM d, yyyy") {
  if (!d) return "—";
  return format(typeof d === "string" ? new Date(d) : d, pattern);
}

export function fmtDateTime(d: Date | string | null | undefined) {
  return fmtDate(d, "MMM d, yyyy · HH:mm");
}

export function fmtRelative(d: Date | string | null | undefined, now: Date) {
  if (!d) return "—";
  return `${formatDistanceStrict(typeof d === "string" ? new Date(d) : d, now)} ago`;
}

export function fmtNumber(n: number) {
  return new Intl.NumberFormat("en-US").format(n);
}

export function fmtPercent(n: number, digits = 1) {
  return `${(n * 100).toFixed(digits)}%`;
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export function titleCase(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
