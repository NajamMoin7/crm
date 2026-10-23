/**
 * Decimal-safe money helpers. Values travel as numeric strings ("1234.50")
 * from Postgres and are converted to integer cents for arithmetic, so we
 * never accumulate binary floating-point error.
 */

export function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const s = typeof value === "number" ? value.toFixed(2) : value.trim();
  const neg = s.startsWith("-");
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".");
  const cents = Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isFinite(cents)) throw new Error(`Invalid money value: ${value}`);
  return neg ? -cents : cents;
}

export function fromCents(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  return `${neg ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Percentage of an amount in cents, rounded half-up to the cent. */
export function percentOf(cents: number, rate: number | string): number {
  return Math.round((cents * Number(rate)) / 100);
}

const formatters = new Map<string, Intl.NumberFormat>();
function fmt(currency: string, compact: boolean) {
  const key = `${currency}:${compact}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: compact ? "compact" : "standard",
      maximumFractionDigits: compact ? 1 : 2,
      minimumFractionDigits: compact ? 0 : 2,
    });
    formatters.set(key, f);
  }
  return f;
}

export function formatMoney(value: string | number, currency = "USD", opts: { compact?: boolean } = {}) {
  return fmt(currency, !!opts.compact).format(toCents(value) / 100);
}

export function formatCents(cents: number, currency = "USD", opts: { compact?: boolean } = {}) {
  return fmt(currency, !!opts.compact).format(cents / 100);
}
