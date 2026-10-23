import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db";
import {
  brands,
  customers,
  financialAdjustments,
  invoiceItems,
  invoices,
  productsServices,
  saleItems,
  sales,
  transactions,
  userBrandAccess,
  users,
} from "@/lib/db/schema";
import { nextId, nextInvoiceNumber } from "@/lib/db/ids";
import { logActivity, notify } from "@/lib/audit";
import { BusinessRuleError } from "@/lib/actions";
import { scopeInvoices } from "@/lib/auth/scope";
import { can, canAccessEntity, canTransactInBrand, type Viewer } from "@/lib/auth/viewer";
import { fromCents, toCents } from "@/lib/money";
import { getPermittedEntities } from "@/lib/data/entities-lookup";
import { linkCustomerToBrand, touchCustomer } from "@/lib/services/customers";
import {
  billingSchema,
  localIsoDate,
  paymentSchema,
  PROCESSOR_LABEL,
  refundSchema,
  type BillingInput,
  type PaymentInput,
  type RefundInput,
} from "@/components/billing/schema";
import {
  computeTotals,
  MANUAL_TRANSITIONS,
  PAYABLE_STATUSES,
  statusAfterMoney,
  type InvoiceStatus,
} from "@/components/billing/math";

function fail(message: string, field?: string): never {
  throw new BusinessRuleError(message, field ? { [field]: [message] } : undefined);
}

/** A calendar date (YYYY-MM-DD) as a timestamp: "now" for today, local noon otherwise. */
function dateToTimestamp(iso: string, today: string, now: Date) {
  return iso === today ? now : new Date(`${iso}T12:00:00`);
}

async function assertReferenceUnused(tx: DbOrTx, reference: string) {
  const [dup] = await tx.select({ id: transactions.id }).from(transactions).where(eq(transactions.paymentReference, reference)).limit(1);
  if (dup) fail(`Payment reference is already recorded on ${dup.id}. Each processor reference can be booked once.`, "paymentReference");
}

/** Sum of approved adjustments on an invoice (reduce the balance; never change amount_paid). */
export async function approvedAdjustmentsCents(tx: DbOrTx, invoiceId: string) {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${financialAdjustments.amount}), 0)` })
    .from(financialAdjustments)
    .where(and(eq(financialAdjustments.invoiceId, invoiceId), eq(financialAdjustments.status, "approved")));
  return toCents(row?.total ?? "0");
}

/** Adjusted balance due = total − paid − approved adjustments (never negative). */
export function balanceDue(totalCents: number, paidCents: number, adjustedCents: number) {
  return Math.max(0, totalCents - paidCents - adjustedCents);
}

/* ------------------------------------------------------------ create */

export type CreatedBillingRecord = { saleId: string; invoiceId: string; invoiceNumber: string; paymentIds: string[] };

/**
 * Creates sale + items, invoice + item snapshot, and (for Paid / Partially
 * Paid) a simulated payment ledger row — in the caller's transaction.
 * Everything the client sent is re-validated; totals are recomputed from the
 * brand's products and tax configuration.
 */
export async function createBillingRecord(tx: DbOrTx, viewer: Viewer, raw: BillingInput): Promise<CreatedBillingRecord> {
  if (!can(viewer, "billing.create")) throw new BusinessRuleError("You do not have permission to create billing records.");
  const input = billingSchema.parse(raw);
  const now = new Date();
  const today = localIsoDate(now);

  /* Brand */
  if (!canTransactInBrand(viewer, input.brandId)) fail("This brand is inactive or you are not authorised for it.", "brandId");
  const [brand] = await tx.select().from(brands).where(eq(brands.id, input.brandId));
  if (!brand || brand.status !== "active") fail("This brand is not active.", "brandId");
  if (!brand.allowedCurrencies.includes(input.currency)) fail(`${brand.name} does not bill in ${input.currency}.`, "currency");
  if (!brand.allowedPaymentMethods.includes(input.paymentMethod)) fail(`${brand.name} does not accept this payment method.`, "paymentMethod");

  /* Dates */
  if (input.saleDate > today) fail("Sale date cannot be in the future.", "saleDate");
  if (input.saleDate < "2000-01-01") fail("Sale date is not valid.", "saleDate");
  const saleAt = dateToTimestamp(input.saleDate, today, now);
  const billingAt = dateToTimestamp(input.billingDate, today, now);
  const dueAt = new Date(`${input.dueDate}T12:00:00`);

  /* Customer — must exist, be active and belong to one of the viewer's brands. */
  const [customer] = await tx.select().from(customers).where(eq(customers.id, input.customerId));
  if (!customer || customer.archivedAt) fail("Customer not found.", "customerId");
  if (customer.mergedIntoId) fail(`This customer record was merged into ${customer.mergedIntoId}. Use that ID instead.`, "customerId");
  if (customer.status === "blocked") fail("This customer is blocked and cannot be billed.", "customerId");
  // Customers in one of the viewer's brands, or new customers not yet linked to any brand.
  // The customer is identified by the agent (email match or new record), so any brand association is allowed.

  /* Agent */
  const agentId = input.agentId ?? viewer.id;
  if (agentId !== viewer.id) {
    if (!can(viewer, "agents.manage") && !can(viewer, "billing.manage")) fail("You can only record sales under your own name.", "agentId");
    const [agent] = await tx
      .select({ id: users.id, status: users.status })
      .from(users)
      .innerJoin(userBrandAccess, and(eq(userBrandAccess.userId, users.id), eq(userBrandAccess.brandId, brand.id)))
      .where(eq(users.id, agentId));
    if (!agent) fail("The selected agent is not authorised for this brand.", "agentId");
    if (agent.status !== "active") fail("The selected agent is not active.", "agentId");
  }

  /* Lines — prices are the agent's entered prices; tax comes from brand config. */
  const productIds = [...new Set(input.lines.map((l) => l.productId).filter((x): x is string => !!x))];
  const productRows = productIds.length
    ? await tx
        .select()
        .from(productsServices)
        .where(and(inArray(productsServices.id, productIds), eq(productsServices.brandId, brand.id), eq(productsServices.active, true)))
    : [];
  const productMap = new Map(productRows.map((p) => [p.id, p]));
  const lineInputs = input.lines.map((l, i) => {
    const product = l.productId ? productMap.get(l.productId) : undefined;
    if (l.productId && !product) fail(`Line ${i + 1}: product is not available for ${brand.name}.`, `lines.${i}.productId`);
    const description = (l.description ?? product?.name ?? "").trim();
    if (!description) fail(`Line ${i + 1}: describe what was sold.`, `lines.${i}.description`);
    const unitPrice = toCents(l.unitPrice);
    const discount = toCents(l.discount);
    if (unitPrice <= 0) fail(`Line ${i + 1}: unit price must be greater than zero.`, `lines.${i}.unitPrice`);
    if (discount > unitPrice * l.quantity) fail(`Line ${i + 1}: discount cannot exceed the line amount.`, `lines.${i}.discount`);
    // Free-text lines use the brand's default tax rate (0% unless configured).
    return { productId: product?.id ?? null, description, quantity: l.quantity, unitPrice, discount, taxRate: brand.defaultTaxRate, taxable: product?.taxable ?? false };
  });
  const totals = computeTotals(lineInputs);
  if (totals.total <= 0) fail("The billing total must be greater than zero.", "lines");

  /* Payment */
  let received = 0;
  if (input.paymentStatus === "paid") received = totals.total;
  if (input.paymentStatus === "partially_paid") {
    received = toCents(input.amountReceived!);
    if (received <= 0) fail("Amount received must be greater than zero.", "amountReceived");
    if (received >= totals.total) fail("For a partial payment the amount received must be less than the total. Use Paid instead.", "amountReceived");
  }
  if (received > 0) await assertReferenceUnused(tx, input.paymentReference!);

  /* Legal entity — must be permitted for the brand on the sale date. */
  const permitted = await getPermittedEntities(brand.id, "sale", saleAt, tx);
  if (!permitted.length) fail(`${brand.name} has no legal entity mapped for sales on ${input.saleDate}. Ask a Super Admin to configure the brand-to-LLC mapping.`, "legalEntityId");
  const def = permitted.find((e) => e.isDefault) ?? permitted[0];
  const entity = permitted.find((e) => e.id === input.legalEntityId);
  if (!entity) fail("The selected legal entity is not permitted for this brand on the sale date.", "legalEntityId");
  if (entity!.id !== def.id && !can(viewer, "billing.assign_entity")) fail("Only finance can assign a non-default legal entity.", "legalEntityId");
  if (!canAccessEntity(viewer, entity!.id)) fail("You do not have access to the selected legal entity.", "legalEntityId");

  /* Persist */
  const saleId = await nextId(tx, "sale");
  const invoiceId = await nextId(tx, "invoice");
  const invoiceNumber = await nextInvoiceNumber(tx, brand.invoicePrefix, billingAt);
  const invoiceStatus: InvoiceStatus = input.paymentStatus;

  await tx.insert(sales).values({
    id: saleId,
    brandId: brand.id,
    customerId: customer.id,
    agentId,
    legalEntityId: entity!.id,
    saleDate: saleAt,
    currency: input.currency,
    subtotal: fromCents(totals.subtotal),
    discount: fromCents(totals.discount),
    tax: fromCents(totals.tax),
    total: fromCents(totals.total),
    status: input.paymentStatus === "draft" ? "open" : "completed",
    notes: input.saleNotes ?? null,
    createdBy: viewer.id,
    createdAt: now,
  });
  await tx.insert(invoices).values({
    id: invoiceId,
    invoiceNumber,
    saleId,
    brandId: brand.id,
    customerId: customer.id,
    legalEntityId: entity!.id,
    agentId,
    billingDate: billingAt,
    dueDate: dueAt,
    billingAddress: input.billingAddress ?? customer.billingAddress ?? null,
    currency: input.currency,
    subtotal: fromCents(totals.subtotal),
    discount: fromCents(totals.discount),
    tax: fromCents(totals.tax),
    total: fromCents(totals.total),
    amountPaid: fromCents(received),
    status: invoiceStatus,
    paymentMethod: input.paymentMethod,
    notes: input.billingNotes ?? null,
    sourceRecordId: input.externalInvoiceNumber ?? null,
    createdBy: viewer.id,
    createdAt: now,
    updatedAt: now,
  });

  for (const [i, l] of lineInputs.entries()) {
    const r = totals.lines[i];
    const saleItemId = await nextId(tx, "saleItem");
    await tx.insert(saleItems).values({
      id: saleItemId,
      saleId,
      productId: l.productId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: fromCents(l.unitPrice),
      discount: fromCents(r.discount),
      taxRate: l.taxable ? brand.defaultTaxRate : "0",
      lineTotal: fromCents(r.total),
    });
    await tx.insert(invoiceItems).values({
      id: await nextId(tx, "invoiceItem"),
      invoiceId,
      saleItemId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: fromCents(l.unitPrice),
      lineTotal: fromCents(r.total),
    });
  }
  const paymentIds: string[] = [];
  if (received > 0) {
    const txnId = await nextId(tx, "transaction");
    paymentIds.push(txnId);
    await tx.insert(transactions).values({
      id: txnId,
      type: "payment",
      status: "succeeded",
      brandId: brand.id,
      legalEntityId: entity!.id,
      customerId: customer.id,
      invoiceId,
      amount: fromCents(received),
      currency: input.currency,
      paymentMethod: input.paymentMethod,
      processor: PROCESSOR_LABEL[input.paymentMethod],
      paymentReference: input.paymentReference!,
      occurredAt: billingAt > now ? now : billingAt,
      notes: "Simulated payment — recorded from billing wizard; no live processor contacted.",
      createdBy: viewer.id,
      createdAt: now,
    });
  }

  await linkCustomerToBrand(tx, viewer, customer.id, brand.id);
  await touchCustomer(tx, [customer.id]);

  const base = { actorId: viewer.id, brandId: brand.id, legalEntityId: entity!.id };
  const money = `${fromCents(totals.total)} ${input.currency}`;
  await logActivity(tx, {
    ...base,
    action: "sale.created",
    entityType: "sale",
    entityId: saleId,
    summary: `Sale ${saleId} recorded for ${customer.fullName} (${money})`,
    metadata: { customerId: customer.id, invoiceId, agentId, lines: lineInputs.length },
  });
  await logActivity(tx, {
    ...base,
    action: "invoice.created",
    entityType: "invoice",
    entityId: invoiceId,
    summary: `Invoice ${invoiceNumber} created (${money}, ${invoiceStatus.replace("_", " ")})`,
    metadata: {
      customerId: customer.id,
      invoiceId,
      saleId,
      invoiceNumber,
      status: invoiceStatus,
      totals: { subtotal: fromCents(totals.subtotal), discount: fromCents(totals.discount), tax: fromCents(totals.tax), total: fromCents(totals.total) },
      legalEntityId: entity!.id,
      ...(entity!.id !== def.id ? { entityOverride: { defaultEntityId: def.id, chosenEntityId: entity!.id } } : {}),
    },
  });
  for (const id of paymentIds) {
    await logActivity(tx, {
      ...base,
      action: "payment.recorded",
      entityType: "transaction",
      entityId: id,
      summary: `Simulated payment ${fromCents(received)} ${input.currency} recorded on ${invoiceNumber}`,
      metadata: { customerId: customer.id, invoiceId, amount: fromCents(received), method: input.paymentMethod, simulated: true },
    });
  }
  if (agentId !== viewer.id) {
    await notify(tx, [agentId], {
      kind: "assignment",
      title: `Billing record ${invoiceNumber} assigned to you`,
      body: `${viewer.name} recorded a ${money} sale for ${customer.fullName} under your name.`,
      href: `/billing/${invoiceId}`,
    });
  }
  return { saleId, invoiceId, invoiceNumber, paymentIds };
}

/* ------------------------------------------------- finance operations */

async function loadInvoiceForFinance(tx: DbOrTx, viewer: Viewer, invoiceId: string) {
  if (!can(viewer, "billing.manage")) throw new BusinessRuleError("You do not have permission to manage billing records.");
  const [inv] = await tx.select().from(invoices).where(and(eq(invoices.id, invoiceId), scopeInvoices(viewer)));
  if (!inv) throw new BusinessRuleError("Invoice not found or not accessible.");
  if (!canAccessEntity(viewer, inv.legalEntityId)) throw new BusinessRuleError("This invoice belongs to a legal entity you cannot manage.");
  return inv;
}

/** Records a (simulated) payment against an invoice. */
export async function recordPayment(tx: DbOrTx, viewer: Viewer, invoiceId: string, raw: PaymentInput) {
  const inv = await loadInvoiceForFinance(tx, viewer, invoiceId);
  const input = paymentSchema.parse(raw);
  const now = new Date();
  const today = localIsoDate(now);
  if (!PAYABLE_STATUSES.includes(inv.status)) fail(`Payments cannot be recorded on a ${inv.status.replace("_", " ")} invoice.`);
  const [brand] = await tx.select().from(brands).where(eq(brands.id, inv.brandId));
  if (!brand.allowedPaymentMethods.includes(input.method)) fail(`${brand.name} does not accept this payment method.`, "method");
  if (input.date > today) fail("Payment date cannot be in the future.", "date");
  if (input.date < localIsoDate(inv.billingDate)) fail("Payment date cannot be before the billing date.", "date");
  const amount = toCents(input.amount);
  const total = toCents(inv.total);
  const paid = toCents(inv.amountPaid);
  const balance = balanceDue(total, paid, await approvedAdjustmentsCents(tx, inv.id));
  if (amount <= 0) fail("Amount must be greater than zero.", "amount");
  if (amount > balance) fail(`Amount exceeds the balance due (${fromCents(balance)} ${inv.currency}).`, "amount");
  await assertReferenceUnused(tx, input.reference);

  const txnId = await nextId(tx, "transaction");
  await tx.insert(transactions).values({
    id: txnId,
    type: "payment",
    status: "succeeded",
    brandId: inv.brandId,
    legalEntityId: inv.legalEntityId,
    customerId: inv.customerId,
    invoiceId: inv.id,
    amount: fromCents(amount),
    currency: inv.currency,
    paymentMethod: input.method,
    processor: PROCESSOR_LABEL[input.method],
    paymentReference: input.reference,
    occurredAt: dateToTimestamp(input.date, today, now),
    notes: input.note ?? "Simulated payment recorded by finance; no live processor contacted.",
    createdBy: viewer.id,
    createdAt: now,
  });
  const newPaid = paid + amount;
  const nextStatus = statusAfterMoney(inv.status, total, newPaid, 0);
  await tx.update(invoices).set({ amountPaid: fromCents(newPaid), status: nextStatus, updatedAt: now }).where(eq(invoices.id, inv.id));
  await touchCustomer(tx, [inv.customerId]);
  await logActivity(tx, {
    actorId: viewer.id,
    action: "payment.recorded",
    entityType: "transaction",
    entityId: txnId,
    brandId: inv.brandId,
    legalEntityId: inv.legalEntityId,
    summary: `Simulated payment ${fromCents(amount)} ${inv.currency} recorded on ${inv.invoiceNumber}`,
    metadata: { customerId: inv.customerId, invoiceId: inv.id, amount: fromCents(amount), method: input.method, simulated: true },
  });
  if (nextStatus !== inv.status) {
    await logActivity(tx, {
      actorId: viewer.id,
      action: "invoice.status_changed",
      entityType: "invoice",
      entityId: inv.id,
      brandId: inv.brandId,
      legalEntityId: inv.legalEntityId,
      summary: `Status ${inv.status} → ${nextStatus} after payment`,
      metadata: { customerId: inv.customerId, invoiceId: inv.id, from: inv.status, to: nextStatus },
    });
  }
  return { transactionId: txnId, status: nextStatus };
}

/** Refundable amount left on one payment: amount − succeeded refunds − succeeded chargebacks against it. */
export async function refundableOnPayment(tx: DbOrTx, paymentId: string, paymentAmountCents: number) {
  const [row] = await tx
    .select({ used: sql<string>`coalesce(sum(${transactions.amount}), 0)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.relatedTransactionId, paymentId),
        inArray(transactions.type, ["refund", "chargeback"]),
        eq(transactions.status, "succeeded"),
      ),
    );
  return Math.max(0, paymentAmountCents - toCents(row?.used ?? "0"));
}

/** Issues a (simulated) refund against one payment of the invoice. */
export async function issueRefund(tx: DbOrTx, viewer: Viewer, invoiceId: string, raw: RefundInput) {
  const inv = await loadInvoiceForFinance(tx, viewer, invoiceId);
  const input = refundSchema.parse(raw);
  const now = new Date();
  const paid = toCents(inv.amountPaid);
  if (paid <= 0) fail("Nothing has been paid on this invoice, so there is nothing to refund.");
  const [payment] = await tx
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, input.paymentId), eq(transactions.invoiceId, inv.id), eq(transactions.type, "payment"), eq(transactions.status, "succeeded")));
  if (!payment) fail("Select a succeeded payment on this invoice.", "paymentId");
  const amount = toCents(input.amount);
  const refundable = Math.min(paid, await refundableOnPayment(tx, payment!.id, toCents(payment!.amount)));
  if (amount <= 0) fail("Amount must be greater than zero.", "amount");
  if (amount > refundable) fail(`Amount exceeds what can be refunded on ${payment!.id} (${fromCents(refundable)} ${inv.currency}).`, "amount");

  const txnId = await nextId(tx, "transaction");
  await tx.insert(transactions).values({
    id: txnId,
    type: "refund",
    status: "succeeded",
    brandId: inv.brandId,
    legalEntityId: inv.legalEntityId,
    customerId: inv.customerId,
    invoiceId: inv.id,
    relatedTransactionId: payment!.id,
    amount: fromCents(amount),
    currency: inv.currency,
    paymentMethod: payment!.paymentMethod,
    processor: payment!.processor,
    paymentReference: `re_sim_${txnId.replace(/[^A-Za-z0-9]/g, "").toLowerCase()}`,
    occurredAt: now,
    notes: `Refund: ${input.reason} (simulated — no live processor contacted)`,
    createdBy: viewer.id,
    createdAt: now,
  });
  const [{ refunded }] = await tx
    .select({ refunded: sql<string>`coalesce(sum(${transactions.amount}), 0)` })
    .from(transactions)
    .where(and(eq(transactions.invoiceId, inv.id), eq(transactions.type, "refund"), eq(transactions.status, "succeeded")));
  const newPaid = paid - amount;
  const nextStatus = statusAfterMoney(inv.status, toCents(inv.total), newPaid, toCents(refunded));
  await tx.update(invoices).set({ amountPaid: fromCents(newPaid), status: nextStatus, updatedAt: now }).where(eq(invoices.id, inv.id));
  await logActivity(tx, {
    actorId: viewer.id,
    action: "payment.refunded",
    entityType: "transaction",
    entityId: txnId,
    brandId: inv.brandId,
    legalEntityId: inv.legalEntityId,
    summary: `Refund ${fromCents(amount)} ${inv.currency} issued on ${inv.invoiceNumber} against ${payment!.id}`,
    metadata: { customerId: inv.customerId, invoiceId: inv.id, paymentId: payment!.id, amount: fromCents(amount), reason: input.reason, from: inv.status, to: nextStatus },
  });
  if (inv.agentId !== viewer.id) {
    await notify(tx, [inv.agentId], {
      kind: "case_update",
      title: `Refund issued on ${inv.invoiceNumber}`,
      body: `${fromCents(amount)} ${inv.currency} refunded by ${viewer.name}.`,
      href: `/billing/${inv.id}`,
    });
  }
  return { transactionId: txnId, status: nextStatus };
}

export type ManualTransition = keyof typeof MANUAL_TRANSITIONS;

/** Explicit status changes (issue / mark overdue / cancel). Invalid transitions are rejected. */
export async function transitionInvoice(tx: DbOrTx, viewer: Viewer, invoiceId: string, action: ManualTransition, note: string) {
  const inv = await loadInvoiceForFinance(tx, viewer, invoiceId);
  const rule = MANUAL_TRANSITIONS[action];
  if (!rule) fail("Unknown action.");
  if (!rule.from.includes(inv.status)) fail(`Cannot ${rule.label.toLowerCase()} — the invoice is ${inv.status.replace("_", " ")}.`);
  const now = new Date();
  if (action === "mark_overdue" && inv.dueDate.getTime() > now.getTime()) fail("This invoice is not past its due date yet.");
  if (action === "cancel") {
    if (note.trim().length < 3) fail("Give a reason for cancelling.");
    const [payment] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.invoiceId, inv.id), eq(transactions.type, "payment")))
      .limit(1);
    if (payment || toCents(inv.amountPaid) > 0) fail("Invoices with recorded payments cannot be cancelled. Issue a refund or an adjustment instead.");
  }
  // Optimistic guard: only update if the status is still what we validated against.
  const updated = await tx
    .update(invoices)
    .set({ status: rule.to, updatedAt: now })
    .where(and(eq(invoices.id, inv.id), eq(invoices.status, inv.status)))
    .returning({ id: invoices.id });
  if (!updated.length) fail("The invoice changed in the meantime. Reload and try again.");
  if (action === "cancel") await tx.update(sales).set({ status: "cancelled" }).where(eq(sales.id, inv.saleId));
  if (action === "issue") await tx.update(sales).set({ status: "completed" }).where(and(eq(sales.id, inv.saleId), eq(sales.status, "open")));
  await logActivity(tx, {
    actorId: viewer.id,
    action: `invoice.${action === "issue" ? "issued" : action === "cancel" ? "cancelled" : "marked_overdue"}`,
    entityType: "invoice",
    entityId: inv.id,
    brandId: inv.brandId,
    legalEntityId: inv.legalEntityId,
    summary: `Status ${inv.status} → ${rule.to}${note.trim() ? `: ${note.trim()}` : ""}`,
    metadata: { customerId: inv.customerId, invoiceId: inv.id, from: inv.status, to: rule.to, note: note.trim() || undefined },
  });
  if (action === "cancel" && inv.agentId !== viewer.id) {
    await notify(tx, [inv.agentId], {
      kind: "case_update",
      title: `Invoice ${inv.invoiceNumber} cancelled`,
      body: `${viewer.name}: ${note.trim()}`,
      href: `/billing/${inv.id}`,
    });
  }
  return { status: rule.to };
}
