import type { Tone } from "@/lib/domain/vocab";

/** Display vocabularies for configuration / administration screens. */

export const RECORD_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "success" },
  inactive: { label: "Inactive", tone: "neutral" },
  suspended: { label: "Suspended", tone: "warning" },
};

export const USER_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "success" },
  suspended: { label: "Suspended", tone: "danger" },
};

export const INTEGRATION_STATUS: Record<string, { label: string; tone: Tone }> = {
  demo_not_connected: { label: "Demo / Not Connected", tone: "warning" },
  connected: { label: "Connected", tone: "success" },
  error: { label: "Error", tone: "danger" },
  disabled: { label: "Disabled", tone: "neutral" },
};

export const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  success: { label: "Success", tone: "success" },
  partial: { label: "Partial", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
};

export const RUN_KIND: Record<string, string> = {
  test_connection: "Test connection",
  dry_run: "Dry-run import",
  import: "Import",
};

export const TXN_TYPE_LABEL: Record<string, string> = {
  payment: "Payment",
  refund: "Refund",
  chargeback: "Chargeback",
  chargeback_reversal: "Chargeback reversal",
  adjustment: "Adjustment",
  intercompany_recharge: "Intercompany recharge",
};
