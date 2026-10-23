/** Client-safe value formatting for charts (values arrive as plain numbers; money in dollars). */
export type ValueFormat = "money" | "number" | "percent";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const moneyCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const numCompact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function fmtValue(v: number | null | undefined, format: ValueFormat, compact = false): string {
  const n = Number(v ?? 0);
  if (format === "percent") return `${(n * 100).toFixed(1)}%`;
  if (format === "money") return (compact ? moneyCompact : money).format(n);
  return (compact ? numCompact : num).format(n);
}
