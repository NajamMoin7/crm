import { z } from "zod";
import { moneyString } from "@/lib/validation";
import { referenceError } from "./math";

/** Shared (client + server) input schemas for billing. The server re-parses everything. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date.");
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const PAYMENT_STATUS_CHOICES = ["draft", "pending", "paid", "partially_paid"] as const;
export type WizardPaymentStatus = (typeof PAYMENT_STATUS_CHOICES)[number];

export const referenceSchema = z
  .string()
  .trim()
  .superRefine((v, ctx) => {
    const err = referenceError(v);
    if (err) ctx.addIssue({ code: "custom", message: err });
  });

/** A line is free text; picking a catalogue product (if the brand has any) is optional. */
export const billingLineSchema = z
  .object({
    productId: optionalText(40),
    description: optionalText(200),
    quantity: z.coerce.number().int("Quantity must be a whole number.").min(1, "Quantity must be at least 1.").max(10_000),
    unitPrice: moneyString,
    discount: moneyString.default("0"),
  })
  .refine((l) => !!(l.productId || l.description), { path: ["description"], message: "Describe what was sold." });

export const billingSchema = z
  .object({
    brandId: z.string().min(1, "Select a brand."),
    customerId: z.string().regex(/^CUS-\d+$/, "Select or create a customer."),
    saleDate: isoDate,
    agentId: optionalText(40),
    currency: z.string().regex(/^[A-Z]{3}$/, "Select a currency."),
    lines: z.array(billingLineSchema).min(1, "Add at least one product or service.").max(50),
    saleNotes: optionalText(2000),
    billingDate: isoDate,
    dueDate: isoDate,
    billingAddress: optionalText(300),
    paymentMethod: z.enum(["card", "bank_transfer", "ach", "wire", "paypal", "stripe_link", "other"]),
    paymentStatus: z.enum(PAYMENT_STATUS_CHOICES),
    amountReceived: optionalText(20),
    paymentReference: optionalText(80),
    billingNotes: optionalText(2000),
    /** The agent's own invoice / order number, shown alongside the CRM invoice number. */
    externalInvoiceNumber: optionalText(40),
    legalEntityId: z.string().min(1, "Select the responsible legal entity."),
  })
  .superRefine((v, ctx) => {
    if (v.dueDate < v.billingDate) ctx.addIssue({ code: "custom", path: ["dueDate"], message: "Due date cannot be before the billing date." });
    if (v.billingDate < v.saleDate) ctx.addIssue({ code: "custom", path: ["billingDate"], message: "Billing date cannot be before the sale date." });
    if (v.paymentStatus === "paid" || v.paymentStatus === "partially_paid") {
      const err = referenceError(v.paymentReference ?? "");
      if (err) ctx.addIssue({ code: "custom", path: ["paymentReference"], message: err });
    }
    if (v.paymentStatus === "partially_paid") {
      if (!v.amountReceived || !moneyString.safeParse(v.amountReceived).success)
        ctx.addIssue({ code: "custom", path: ["amountReceived"], message: "Enter the amount received." });
    }
  });

export type BillingInput = z.input<typeof billingSchema>;

/**
 * The one-page billing form: the agent types (or pastes) the customer's
 * details with the order. The server matches the customer by email or
 * creates the record — there is no separate customer step.
 */
export const orderSchema = z
  .object({
    brandId: z.string().min(1, "Select a brand."),
    agentId: optionalText(40),
    amount: moneyString.refine((v) => Number(v) > 0, "Enter an amount greater than zero."),
    description: optionalText(200),
    invoiceNumber: optionalText(40),
    firstName: z.string().trim().min(1, "First name is required.").max(60),
    lastName: z.string().trim().min(1, "Last name is required.").max(60),
    company: optionalText(120),
    email: z
      .string()
      .trim()
      .min(1, "Email is required.")
      .max(200)
      .transform((v) => v.toLowerCase())
      .refine((v) => z.email().safeParse(v).success, "Enter a valid email address."),
    phone: z
      .string()
      .trim()
      .min(1, "Phone number is required.")
      .max(40)
      .refine((v) => v.replace(/\D/g, "").length >= 7, "Enter a valid phone number."),
    country: optionalText(80),
    address1: optionalText(200),
    address2: optionalText(200),
    city: optionalText(80),
    state: optionalText(80),
    zip: optionalText(20),
    paymentStatus: z.enum(PAYMENT_STATUS_CHOICES),
    paymentMethod: z.enum(["card", "bank_transfer", "ach", "wire", "paypal", "stripe_link", "other"], { message: "Choose a payment method." }),
    paymentReference: optionalText(80),
    amountReceived: optionalText(20),
    notes: optionalText(2000),
  })
  .superRefine((v, ctx) => {
    if (v.paymentStatus === "paid" || v.paymentStatus === "partially_paid") {
      const err = referenceError(v.paymentReference ?? "");
      if (err) ctx.addIssue({ code: "custom", path: ["paymentReference"], message: err });
    }
    if (v.paymentStatus === "partially_paid") {
      if (!v.amountReceived || !moneyString.safeParse(v.amountReceived).success)
        ctx.addIssue({ code: "custom", path: ["amountReceived"], message: "Enter the amount received." });
      else if (Number(v.amountReceived) >= Number(v.amount))
        ctx.addIssue({ code: "custom", path: ["amountReceived"], message: "Must be less than the amount — use Paid instead." });
    }
  });
export type OrderInput = z.input<typeof orderSchema>;

export const paymentSchema = z.object({
  amount: moneyString,
  method: z.enum(["card", "bank_transfer", "ach", "wire", "paypal", "stripe_link", "other"]),
  reference: referenceSchema,
  date: isoDate,
  note: optionalText(500),
});
export type PaymentInput = z.input<typeof paymentSchema>;

export const refundSchema = z.object({
  paymentId: z.string().min(1, "Select the payment to refund."),
  amount: moneyString,
  reason: z.string().trim().min(3, "Give a reason for the refund.").max(500),
});
export type RefundInput = z.input<typeof refundSchema>;

export const adjustmentRequestSchema = z.object({
  invoiceId: z.string().min(1, "Look up an invoice first."),
  type: z.enum(["credit_note", "write_off", "correction", "refund"]),
  amount: moneyString,
  reason: z.string().trim().min(5, "Explain the reason (min. 5 characters).").max(1000),
});
export type AdjustmentRequestInput = z.input<typeof adjustmentRequestSchema>;

export const PROCESSOR_LABEL: Record<string, string> = {
  card: "Stripe (demo)",
  stripe_link: "Stripe (demo)",
  paypal: "PayPal (demo)",
  ach: "Plaid ACH (demo)",
  bank_transfer: "Bank (demo)",
  wire: "Bank (demo)",
  other: "Manual (demo)",
};

/** Local calendar date (YYYY-MM-DD) for date inputs. */
export function localIsoDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDaysIso(iso: string, days: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}
