/**
 * Pure billing arithmetic shared by the wizard (live preview) and the server
 * (authoritative recomputation). All amounts are integer cents; tax rates are
 * percentage strings ("8.25") converted to integer basis points so rounding is
 * exact (half-up to the cent) and never depends on binary floating point.
 */

export type LineInput = {
  quantity: number;
  /** Unit price in cents. */
  unitPrice: number;
  /** Line discount amount in cents (absolute, not a percentage). */
  discount: number;
  /** Percentage, e.g. "8.25". Ignored when the product is not taxable. */
  taxRate: string | number;
  taxable: boolean;
};

export type LineResult = { gross: number; discount: number; taxBase: number; tax: number; total: number; taxRateBp: number };
export type Totals = { subtotal: number; discount: number; tax: number; total: number; lines: LineResult[] };

/** "8.25" → 825 basis points. Accepts up to 2 decimals; anything else throws. */
export function rateToBasisPoints(rate: string | number): number {
  const s = typeof rate === "number" ? rate.toFixed(2) : rate.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) throw new Error(`Invalid tax rate: ${rate}`);
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

/** cents × basisPoints / 10000, rounded half-up, computed exactly with BigInt. */
export function applyRate(cents: number, basisPoints: number): number {
  if (cents <= 0 || basisPoints <= 0) return 0;
  const n = BigInt(Math.round(cents)) * BigInt(basisPoints);
  return Number((n + BigInt(5000)) / BigInt(10000));
}

export function computeLine(line: LineInput): LineResult {
  const gross = line.unitPrice * line.quantity;
  const discount = Math.min(Math.max(0, line.discount), gross);
  const taxBase = gross - discount;
  const taxRateBp = line.taxable ? rateToBasisPoints(line.taxRate) : 0;
  const tax = applyRate(taxBase, taxRateBp);
  return { gross, discount, taxBase, tax, total: taxBase + tax, taxRateBp };
}

/** Line totals are rounded individually; the invoice totals are their exact sums. */
export function computeTotals(lines: LineInput[]): Totals {
  const results = lines.map(computeLine);
  const subtotal = results.reduce((a, r) => a + r.gross, 0);
  const discount = results.reduce((a, r) => a + r.discount, 0);
  const tax = results.reduce((a, r) => a + r.tax, 0);
  return { subtotal, discount, tax, total: subtotal - discount + tax, lines: results };
}

/** Parses a user-entered money string ("1,299.5" / "1299.50") to cents, or null if invalid. */
export function parseMoneyInput(value: string): number | null {
  const s = value.replace(/[,\s$]/g, "").trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

export function centsToInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/* ------------------------------------------------- payment references */

export const REFERENCE_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * Validates a tokenised processor reference. Returns an error message, or
 * null when valid. Anything containing 13–19 consecutive digits (ignoring
 * spaces/dashes) is treated as a possible card number and rejected outright.
 */
export function referenceError(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "A payment reference is required.";
  if (/\d{13,19}/.test(v.replace(/[\s-]/g, ""))) return "Never enter card numbers — use the processor's tokenised reference (e.g. pi_…).";
  if (!REFERENCE_PATTERN.test(v)) return "Use the tokenised reference: 6–64 characters, letters, digits, _ or - only.";
  return null;
}

/* ---------------------------------------------------- invoice status */

export type InvoiceStatus = "draft" | "pending" | "paid" | "partially_paid" | "overdue" | "cancelled" | "refunded";

/**
 * Status after a money movement. Explicit workflow transitions (issue, mark
 * overdue, cancel) are validated separately by `canTransition`.
 */
export function statusAfterMoney(current: InvoiceStatus, totalCents: number, paidCents: number, refundedCents: number): InvoiceStatus {
  if (paidCents >= totalCents && totalCents > 0) return "paid";
  if (paidCents > 0) return current === "overdue" ? "overdue" : "partially_paid";
  if (refundedCents > 0) return "refunded";
  return current;
}

export const MANUAL_TRANSITIONS: Record<"issue" | "mark_overdue" | "cancel", { from: InvoiceStatus[]; to: InvoiceStatus; label: string }> = {
  issue: { from: ["draft"], to: "pending", label: "Issue invoice" },
  mark_overdue: { from: ["pending", "partially_paid"], to: "overdue", label: "Mark overdue" },
  cancel: { from: ["draft", "pending", "overdue"], to: "cancelled", label: "Cancel invoice" },
};

export const PAYABLE_STATUSES: InvoiceStatus[] = ["pending", "partially_paid", "overdue"];
export const OUTSTANDING_STATUSES: InvoiceStatus[] = ["pending", "partially_paid", "overdue"];
