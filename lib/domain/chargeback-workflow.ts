/**
 * Recharge / Chargeback workflow — a pure state machine shared by the UI
 * (which actions to offer, and why others are blocked) and the server (which
 * re-evaluates it inside the transaction before every change).
 *
 *   draft ─submit→ pending_review ─forward→ pending_approval ─approve→ approved
 *     ↑                 │  │                   │  │                      │
 *     └──── return ─────┘  └─ reject ┐        │  └─ reject ┐       start_processing
 *     └──────────────── return ──────┼────────┘            │             ↓
 *                                    ↓                     ↓        processing ─complete→ completed
 *                                 rejected              rejected         └─fail→ failed
 *   draft | pending_review | pending_approval ─cancel→ cancelled
 */
import type { Permission } from "./permissions";

export type CaseStatus =
  | "draft"
  | "pending_review"
  | "pending_approval"
  | "approved"
  | "processing"
  | "completed"
  | "rejected"
  | "failed"
  | "cancelled";

export type WorkflowAction =
  | "submit"
  | "forward"
  | "return"
  | "reject"
  | "approve"
  | "start_processing"
  | "complete"
  | "fail"
  | "cancel"
  | "edit"
  | "note";

export type WorkflowPolicy = {
  requireIndependentReview: boolean;
  requireIndependentApproval: boolean;
};

export type WorkflowActor = { id: string; permissions: Set<Permission> | Permission[] };
export type WorkflowCase = { status: CaseStatus; requestedBy: string; reviewedBy: string | null };

type Def = {
  label: string;
  from: CaseStatus[];
  to: CaseStatus | null; // null = no status change
  /** The actor needs any one of these. */
  anyOf: Permission[];
  noteRequired?: boolean;
  tone: "default" | "outline" | "destructive" | "secondary";
  description: string;
};

export const ACTIONS: Record<WorkflowAction, Def> = {
  submit: {
    label: "Submit for review",
    from: ["draft"],
    to: "pending_review",
    anyOf: ["chargebacks.create"],
    tone: "default",
    description: "Send this request to a reviewer. You can no longer edit it unless it is returned.",
  },
  forward: {
    label: "Review & forward for approval",
    from: ["pending_review"],
    to: "pending_approval",
    anyOf: ["chargebacks.review"],
    tone: "default",
    description: "Confirm the original transaction, amount, reason code and legal entities are correct.",
  },
  return: {
    label: "Return for correction",
    from: ["pending_review", "pending_approval"],
    to: "draft",
    anyOf: ["chargebacks.review", "chargebacks.approve"],
    noteRequired: true,
    tone: "outline",
    description: "Send back to the requester as a draft with a note explaining what to fix.",
  },
  reject: {
    label: "Reject",
    from: ["pending_review", "pending_approval"],
    to: "rejected",
    anyOf: ["chargebacks.review", "chargebacks.approve"],
    noteRequired: true,
    tone: "destructive",
    description: "Close the request without any financial effect. This cannot be undone.",
  },
  approve: {
    label: "Approve",
    from: ["pending_approval"],
    to: "approved",
    anyOf: ["chargebacks.approve"],
    tone: "default",
    description: "Authorise the chargeback. No money moves until processing is completed.",
  },
  start_processing: {
    label: "Start processing",
    from: ["approved"],
    to: "processing",
    anyOf: ["chargebacks.process"],
    tone: "default",
    description: "Mark the case as submitted to the processor / being settled.",
  },
  complete: {
    label: "Record completion",
    from: ["processing"],
    to: "completed",
    anyOf: ["chargebacks.process"],
    tone: "default",
    description: "Record the processor outcome. A ledger entry is booked against the original legal entity.",
  },
  fail: {
    label: "Record failure",
    from: ["processing"],
    to: "failed",
    anyOf: ["chargebacks.process"],
    noteRequired: true,
    tone: "destructive",
    description: "The processor rejected or the settlement failed. No ledger entry is booked.",
  },
  cancel: {
    label: "Cancel request",
    from: ["draft", "pending_review", "pending_approval"],
    to: "cancelled",
    anyOf: ["chargebacks.create", "chargebacks.review"],
    noteRequired: true,
    tone: "outline",
    description: "Withdraw the request (e.g. the customer withdrew the dispute). No financial effect.",
  },
  edit: {
    label: "Edit draft",
    from: ["draft"],
    to: null,
    anyOf: ["chargebacks.create"],
    tone: "outline",
    description: "Change amount, reason, notes or references while the request is a draft.",
  },
  note: {
    label: "Add note",
    from: ["draft", "pending_review", "pending_approval", "approved", "processing", "completed", "rejected", "failed", "cancelled"],
    to: null,
    anyOf: ["chargebacks.create", "chargebacks.review", "chargebacks.approve", "chargebacks.process"],
    tone: "secondary",
    description: "Add an internal note to the case history.",
  },
};

export type ActionAvailability = { action: WorkflowAction; allowed: boolean; reason?: string } & Def;

const has = (actor: WorkflowActor, p: Permission) =>
  actor.permissions instanceof Set ? actor.permissions.has(p) : actor.permissions.includes(p);

/** Evaluates one action. `allowed: false` comes with a human-readable reason. */
export function evaluate(action: WorkflowAction, actor: WorkflowActor, c: WorkflowCase, policy: WorkflowPolicy): ActionAvailability {
  const def = ACTIONS[action];
  const out = (allowed: boolean, reason?: string) => ({ action, allowed, reason, ...def });
  if (!def.from.includes(c.status)) return out(false, `Not possible while the case is ${c.status.replace(/_/g, " ")}.`);
  if (!def.anyOf.some((p) => has(actor, p))) return out(false, "Your role does not include this permission.");

  const isRequester = actor.id === c.requestedBy;
  switch (action) {
    case "submit":
    case "edit":
      if (!isRequester && !has(actor, "chargebacks.review")) return out(false, "Only the requester can change a draft.");
      break;
    case "forward":
      if (policy.requireIndependentReview && isRequester) return out(false, "Separation of duties: you cannot review your own request.");
      break;
    case "approve":
      if (policy.requireIndependentApproval && isRequester) return out(false, "Separation of duties: you cannot approve your own request.");
      break;
    case "return":
    case "reject": {
      const needed: Permission = c.status === "pending_review" ? "chargebacks.review" : "chargebacks.approve";
      if (!has(actor, needed)) return out(false, `Requires ${needed} at this stage.`);
      if (isRequester && (policy.requireIndependentReview || policy.requireIndependentApproval))
        return out(false, "Separation of duties: decide on someone else's request, or cancel your own.");
      break;
    }
    case "cancel":
      if (!isRequester && !has(actor, "chargebacks.review")) return out(false, "Only the requester or a reviewer can cancel.");
      break;
  }
  return out(true);
}

export function availableActions(actor: WorkflowActor, c: WorkflowCase, policy: WorkflowPolicy): ActionAvailability[] {
  return (Object.keys(ACTIONS) as WorkflowAction[]).map((a) => evaluate(a, actor, c, policy));
}

/** The happy path, for the progress stepper. */
export const STAGES: { status: CaseStatus; label: string }[] = [
  { status: "draft", label: "Draft" },
  { status: "pending_review", label: "Review" },
  { status: "pending_approval", label: "Approval" },
  { status: "approved", label: "Approved" },
  { status: "processing", label: "Processing" },
  { status: "completed", label: "Completed" },
];
export const TERMINAL: CaseStatus[] = ["completed", "rejected", "failed", "cancelled"];
