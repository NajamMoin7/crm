"use server";

import { refresh } from "next/cache";
import { getDb } from "@/lib/db";
import { authorize } from "@/lib/auth/viewer";
import { BusinessRuleError, runAction } from "@/lib/actions";
import type { ActionResult } from "@/lib/action-result";
import { issueRefund, recordPayment, transitionInvoice, type ManualTransition } from "@/lib/services/billing";
import type { OrderInput, PaymentInput, RefundInput } from "@/components/billing/schema";
import { createOrder } from "@/lib/services/orders";

export async function recordPaymentAction(invoiceId: string, input: PaymentInput): Promise<ActionResult> {
  return runAction(async () => {
    const viewer = await authorize("billing.manage");
    const db = await getDb();
    const res = await db.transaction((tx) => recordPayment(tx, viewer, invoiceId, input));
    refresh();
    return { ok: true, message: `Payment ${res.transactionId} recorded (simulated). Status: ${res.status.replace("_", " ")}.` };
  });
}

export async function issueRefundAction(invoiceId: string, input: RefundInput): Promise<ActionResult> {
  return runAction(async () => {
    const viewer = await authorize("billing.manage");
    const db = await getDb();
    const res = await db.transaction((tx) => issueRefund(tx, viewer, invoiceId, input));
    refresh();
    return { ok: true, message: `Refund ${res.transactionId} issued (simulated). Status: ${res.status.replace("_", " ")}.` };
  });
}

export async function transitionInvoiceAction(invoiceId: string, action: ManualTransition, note: string): Promise<ActionResult> {
  return runAction(async () => {
    const viewer = await authorize("billing.manage");
    if (!["issue", "mark_overdue", "cancel"].includes(action)) throw new BusinessRuleError("Unknown action.");
    const db = await getDb();
    const res = await db.transaction((tx) => transitionInvoice(tx, viewer, invoiceId, action, note ?? ""));
    refresh();
    return { ok: true, message: `Invoice is now ${res.status.replace("_", " ")}.` };
  });
}

/** One-page billing form: matches or creates the customer, then records the sale + invoice. */
export async function createOrderAction(input: OrderInput): Promise<ActionResult<{ invoiceId: string; customerId: string; customerMatched: boolean }>> {
  return runAction<{ invoiceId: string; customerId: string; customerMatched: boolean }>(async () => {
    const viewer = await authorize("billing.create");
    const db = await getDb();
    const res = await db.transaction((tx) => createOrder(tx, viewer, input));
    return {
      ok: true,
      data: { invoiceId: res.invoiceId, customerId: res.customerId, customerMatched: res.customerMatched },
      message: `Order ${res.invoiceNumber} saved${res.customerMatched ? ` for existing customer ${res.customerId}` : ` · new customer ${res.customerId}`}.`,
    };
  });
}
