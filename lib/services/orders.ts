import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { BusinessRuleError } from "@/lib/actions";
import { can, type Viewer } from "@/lib/auth/viewer";
import { logActivity } from "@/lib/audit";
import { orderSchema, localIsoDate, addDaysIso, type OrderInput } from "@/components/billing/schema";
import { getPermittedEntities } from "@/lib/data/entities-lookup";
import { createCustomer } from "./customers";
import { createBillingRecord } from "./billing";
import { brands } from "@/lib/db/schema";

const join = (...parts: (string | undefined | null)[]) => parts.map((p) => p?.trim()).filter(Boolean).join(", ");

/**
 * Records an order from the one-page billing form:
 *  1. Customer — reuse the record with the same email (any agent's), else create
 *     one (a phone match with another record is flagged for duplicate review,
 *     never auto-merged). Missing contact/address fields are filled in; existing
 *     values are not overwritten.
 *  2. Sale + invoice (+ simulated payment) through the regular billing service,
 *     which re-validates amounts, brand access and payment references.
 */
export async function createOrder(tx: DbOrTx, viewer: Viewer, raw: OrderInput) {
  if (!can(viewer, "billing.create")) throw new BusinessRuleError("You do not have permission to record sales.");
  const input = orderSchema.parse(raw);
  const fullName = `${input.firstName} ${input.lastName}`.trim();
  const billingAddress = join(input.address1, input.address2, input.city, join(input.state, input.zip).replace(", ", " "), input.country) || undefined;

  /* 1. Customer */
  const [existing] = await tx
    .select()
    .from(customers)
    .where(and(eq(sql`lower(${customers.email})`, input.email), isNull(customers.mergedIntoId), isNull(customers.archivedAt)))
    .limit(1);
  let customerId: string;
  if (existing) {
    customerId = existing.id;
    await tx
      .update(customers)
      .set({
        phone: existing.phone ?? input.phone,
        phoneNormalized: existing.phoneNormalized ?? input.phone.replace(/\D/g, ""),
        companyName: existing.companyName ?? input.company ?? null,
        billingAddress: existing.billingAddress ?? billingAddress ?? null,
        city: existing.city ?? input.city ?? null,
        country: existing.country ?? input.country ?? null,
        updatedAt: new Date(),
      })
      .where(eq(customers.id, existing.id));
  } else {
    if (!can(viewer, "customers.create")) throw new BusinessRuleError("You do not have permission to add customers.");
    const created = await createCustomer(tx, viewer, {
      fullName,
      email: input.email,
      phone: input.phone,
      companyName: input.company,
      // Phone matches are recorded as duplicate candidates for review instead of blocking the sale.
      confirmNotDuplicate: true,
    });
    customerId = created.id;
    await tx
      .update(customers)
      .set({ billingAddress: billingAddress ?? null, city: input.city ?? null, country: input.country ?? null })
      .where(eq(customers.id, customerId));
  }

  /* 2. Sale + invoice */
  const [brand] = await tx.select().from(brands).where(eq(brands.id, input.brandId));
  if (!brand) throw new BusinessRuleError("Select a brand.", { brandId: ["Select a brand."] });
  const now = new Date();
  const today = localIsoDate(now);
  const [entity] = await getPermittedEntities(brand.id, "sale", now, tx);
  if (!entity) throw new BusinessRuleError("This brand can't take sales yet. Ask a Super Admin.");
  const record = await createBillingRecord(tx, viewer, {
    brandId: brand.id,
    customerId,
    saleDate: today,
    agentId: input.agentId,
    currency: brand.defaultCurrency,
    lines: [{ description: input.description || "Order", quantity: 1, unitPrice: Number(input.amount).toFixed(2), discount: "0" }],
    saleNotes: input.notes,
    billingDate: today,
    dueDate: addDaysIso(today, brand.paymentTermsDays),
    billingAddress,
    paymentMethod: input.paymentMethod,
    paymentStatus: input.paymentStatus,
    amountReceived: input.amountReceived,
    paymentReference: input.paymentReference,
    legalEntityId: entity.id,
    externalInvoiceNumber: input.invoiceNumber,
  });
  await logActivity(tx, {
    actorId: viewer.id,
    action: existing ? "order.customer_matched" : "order.customer_created",
    entityType: "customer",
    entityId: customerId,
    brandId: brand.id,
    summary: existing ? `Order matched existing customer ${customerId} by email` : `Customer ${customerId} created from the billing form`,
    metadata: { invoiceId: record.invoiceId, customerId },
  });
  return { ...record, customerId, customerMatched: !!existing };
}
