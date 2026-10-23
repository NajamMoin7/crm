/** Display vocabularies shared by server and client code. */

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "violet";

export const INVOICE_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  pending: { label: "Pending", tone: "info" },
  paid: { label: "Paid", tone: "success" },
  partially_paid: { label: "Partially Paid", tone: "warning" },
  overdue: { label: "Overdue", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  refunded: { label: "Refunded", tone: "violet" },
};

export const CASE_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  pending_review: { label: "Pending Review", tone: "info" },
  pending_approval: { label: "Pending Approval", tone: "warning" },
  approved: { label: "Approved", tone: "violet" },
  processing: { label: "Processing", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
/** Statuses that still consume the original transaction's chargeable balance. */
export const CASE_ACTIVE_STATUSES = ["draft", "pending_review", "pending_approval", "approved", "processing", "completed"] as const;
export const CASE_OPEN_STATUSES = ["draft", "pending_review", "pending_approval", "approved", "processing"] as const;

export const CASE_TYPE: Record<string, { label: string; description: string }> = {
  chargeback: {
    label: "Recharge / Chargeback",
    description: "A customer payment disputed and reversed through the card network or payment processor.",
  },
  intercompany_recharge: {
    label: "Intercompany Recharge",
    description:
      "An internal reimbursement between our own legal entities. Never counted as revenue or as a customer chargeback.",
  },
};

export const TRANSACTION_TYPE: Record<string, { label: string; tone: Tone; sign: 1 | -1 }> = {
  payment: { label: "Payment", tone: "success", sign: 1 },
  refund: { label: "Refund", tone: "violet", sign: -1 },
  chargeback: { label: "Chargeback", tone: "danger", sign: -1 },
  chargeback_reversal: { label: "Chargeback Reversal", tone: "success", sign: 1 },
  adjustment: { label: "Adjustment", tone: "warning", sign: -1 },
  intercompany_recharge: { label: "Intercompany Recharge", tone: "info", sign: 1 },
};

export const TRANSACTION_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "info" },
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  reversed: { label: "Reversed", tone: "neutral" },
};

export const PAYMENT_METHOD: Record<string, string> = {
  card: "Card (tokenised)",
  bank_transfer: "Bank transfer",
  ach: "ACH",
  wire: "Wire",
  paypal: "PayPal",
  stripe_link: "Stripe payment link",
  other: "Other",
};

export const LEAD_STAGE: Record<string, { label: string; tone: Tone; order: number }> = {
  new: { label: "New", tone: "neutral", order: 0 },
  contacted: { label: "Contacted", tone: "info", order: 1 },
  qualified: { label: "Qualified", tone: "violet", order: 2 },
  proposal: { label: "Proposal", tone: "warning", order: 3 },
  negotiation: { label: "Negotiation", tone: "warning", order: 4 },
  won: { label: "Won", tone: "success", order: 5 },
  lost: { label: "Lost", tone: "danger", order: 6 },
};

export const CUSTOMER_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "success" },
  prospect: { label: "Prospect", tone: "info" },
  inactive: { label: "Inactive", tone: "neutral" },
  blocked: { label: "Blocked", tone: "danger" },
};

export const ADJUSTMENT_TYPE: Record<string, string> = {
  credit_note: "Credit note",
  write_off: "Write-off",
  correction: "Correction",
  refund: "Refund",
};

export const APPROVAL_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
};

export const RECON_STATUS: Record<string, { label: string; tone: Tone }> = {
  matched: { label: "Matched", tone: "success" },
  exception: { label: "Exception", tone: "danger" },
  resolved: { label: "Resolved", tone: "neutral" },
};

/** Demo reason-code catalogue (Visa / Mastercard style). Confirm with the processor before production. */
export const REASON_CODES: { code: string; label: string; network: string }[] = [
  { code: "10.4", label: "Fraud — card-absent environment", network: "Visa" },
  { code: "13.1", label: "Merchandise / services not received", network: "Visa" },
  { code: "13.3", label: "Not as described or defective", network: "Visa" },
  { code: "13.6", label: "Credit not processed", network: "Visa" },
  { code: "12.6", label: "Duplicate processing", network: "Visa" },
  { code: "4837", label: "No cardholder authorisation", network: "Mastercard" },
  { code: "4853", label: "Cardholder dispute", network: "Mastercard" },
  { code: "4834", label: "Point-of-interaction error", network: "Mastercard" },
  { code: "IC-01", label: "Intercompany cost reallocation", network: "Internal" },
  { code: "IC-02", label: "Intercompany chargeback reimbursement", network: "Internal" },
];

export const ACQUISITION_SOURCES = ["Website form", "Referral", "Paid search", "Social", "Outbound", "Partner", "Event", "Legacy import"];
export const COUNTRIES = ["United States", "United Kingdom", "Canada", "Australia", "Germany", "United Arab Emirates", "Pakistan", "Ireland", "Netherlands", "Singapore"];
