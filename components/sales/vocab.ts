import type { Tone } from "@/lib/domain/vocab";

/** Sale status vocabulary (not part of the shared vocab file, which another module owns). */
export const SALE_STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const TASK_PRIORITY: Record<string, { label: string; tone: Tone }> = {
  low: { label: "Low", tone: "neutral" },
  normal: { label: "Normal", tone: "info" },
  high: { label: "High", tone: "danger" },
};

export const OPEN_LEAD_STAGES = ["new", "contacted", "qualified", "proposal", "negotiation"] as const;
