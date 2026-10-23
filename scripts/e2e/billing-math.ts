/** Unit checks for the pure billing arithmetic (no server needed): npx tsx scripts/e2e/billing-math.ts */
import { applyRate, computeLine, computeTotals, parseMoneyInput, rateToBasisPoints, referenceError, statusAfterMoney } from "../../components/billing/math";
import { check, summary } from "./harness";

console.log("billing math");
check(rateToBasisPoints("8.25") === 825 && rateToBasisPoints("5") === 500 && rateToBasisPoints("0.00") === 0, "tax rate → basis points");
// 1,999.00 × 8.25% = 164.9175 → 164.92 (half-up)
check(applyRate(199900, 825) === 16492, "8.25% of 1999.00 rounds to 164.92", applyRate(199900, 825));
// exact half: 0.10 × 5% = 0.005 → 0.01 (half-up), float would give 0.01 too but 1.005-type cases differ
check(applyRate(10, 500) === 1, "half-cent rounds up", applyRate(10, 500));
check(applyRate(1, 4999) === 0, "below half rounds down");
// 100.50 × 8.25% = 8.29125 → 8.29
check(applyRate(10050, 825) === 829, "8.25% of 100.50 = 8.29", applyRate(10050, 825));

const line = computeLine({ quantity: 3, unitPrice: 119900, discount: 10000, taxRate: "8.25", taxable: true });
// gross 3597.00, discount 100.00, base 3497.00, tax 288.5025 → 288.50, total 3785.50
check(line.gross === 359700 && line.discount === 10000 && line.tax === 28850 && line.total === 378550, "discount applied before tax", line);

const untaxed = computeLine({ quantity: 2, unitPrice: 59900, discount: 0, taxRate: "8.25", taxable: false });
check(untaxed.tax === 0 && untaxed.total === 119800, "non-taxable product gets no tax", untaxed);

const over = computeLine({ quantity: 1, unitPrice: 1000, discount: 5000, taxRate: "5", taxable: true });
check(over.discount === 1000 && over.total === 0, "discount is clamped to the line amount", over);

const t = computeTotals([
  { quantity: 1, unitPrice: 149900, discount: 0, taxRate: "8.25", taxable: true }, // tax 123.6675 → 123.67
  { quantity: 2, unitPrice: 79900, discount: 1999, taxRate: "8.25", taxable: true }, // base 1578.01, tax 130.185825 → 130.19
  { quantity: 1, unitPrice: 59900, discount: 0, taxRate: "8.25", taxable: false },
]);
check(t.subtotal === 369600, "subtotal = Σ gross", t.subtotal);
check(t.discount === 1999, "discount = Σ line discounts", t.discount);
check(t.tax === 12367 + 13019, "tax = Σ per-line rounded tax", t.tax);
check(t.total === t.subtotal - t.discount + t.tax, "total = subtotal − discount + tax", t.total);
check(t.lines.reduce((s, l) => s + l.total, 0) === t.total, "line totals sum to the invoice total");

check(parseMoneyInput("1,299.5") === 129950 && parseMoneyInput("0.07") === 7 && parseMoneyInput("1.234") === null && parseMoneyInput("-5") === null, "money input parsing");

check(referenceError("pi_3QxDemo123") === null, "tokenised reference accepted");
check(/card numbers/i.test(referenceError("4242424242424242") ?? ""), "16-digit card number rejected");
check(/card numbers/i.test(referenceError("4242 4242 4242 4242") ?? ""), "spaced card number rejected");
check(/card numbers/i.test(referenceError("pi_4111111111111") ?? ""), "13 consecutive digits rejected");
check(referenceError("abc") !== null, "too-short reference rejected");
check(referenceError("pi_demo$123") !== null, "invalid characters rejected");

check(statusAfterMoney("pending", 1000, 1000, 0) === "paid", "full payment → paid");
check(statusAfterMoney("pending", 1000, 400, 0) === "partially_paid", "part payment → partially paid");
check(statusAfterMoney("overdue", 1000, 400, 0) === "overdue", "part payment keeps overdue");
check(statusAfterMoney("paid", 1000, 0, 1000) === "refunded", "full refund → refunded");
check(statusAfterMoney("paid", 1000, 600, 400) === "partially_paid", "partial refund → partially paid");

process.exit(summary() ? 1 : 0);
