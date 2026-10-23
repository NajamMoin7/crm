import { z } from "zod";

/** Shared Zod schemas. Server Actions re-validate everything the client sends. */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const emailSchema = z
  .string()
  .trim()
  .min(1, "Email is required.")
  .max(200)
  .transform((v) => v.toLowerCase())
  .refine((v) => z.email().safeParse(v).success, "Enter a valid email address.");

const requiredPhone = z
  .string()
  .trim()
  .min(1, "Phone number is required.")
  .max(40)
  .refine((v) => v.replace(/\D/g, "").length >= 7, "Enter a valid phone number (at least 7 digits).");

/** Customer creation asks for the essentials only. Billing details are collected by the billing flow. */
export const customerSchema = z.object({
  fullName: z.string().trim().min(2, "Full name is required.").max(120),
  email: emailSchema,
  phone: requiredPhone,
  companyName: optionalText(120),
  notes: optionalText(2000),
  /** Super Admin may assign the owner; agents always own the customers they create. */
  assignedAgentId: optionalText(40),
  /** Set when the user reviewed possible duplicates and confirmed this is a different person. */
  confirmNotDuplicate: z.boolean().default(false),
});
export type CustomerInput = z.input<typeof customerSchema>;

export const customerUpdateSchema = z.object({
  fullName: z.string().trim().min(2, "Full name is required.").max(120),
  email: emailSchema,
  phone: requiredPhone,
  companyName: optionalText(120),
  status: z.enum(["active", "prospect", "inactive", "blocked"]).default("active"),
  assignedAgentId: optionalText(40),
});

export const noteSchema = z.object({
  body: z.string().trim().min(1, "Write a note.").max(2000),
  visibility: z.enum(["internal", "finance"]).default("internal"),
});

export const moneyString = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, "Enter an amount with up to 2 decimals.");

export const currencyCode = z.string().regex(/^[A-Z]{3}$/, "Use an ISO 4217 currency code.");
