import "server-only";
import { and, eq, ilike, or, sql } from "drizzle-orm";
import { customers, invoices, transactions } from "@/lib/db/schema";
import { scopeTransactions } from "@/lib/auth/scope";
import type { Viewer } from "@/lib/auth/viewer";
import type { ListFilters } from "@/lib/filters";


export function transactionWhere(viewer: Viewer, f: ListFilters) {
  const q = f.q.trim();
  const like = `%${q.replace(/[%_]/g, "")}%`;
  return and(
    scopeTransactions(viewer, f.brand),
    f.type ? eq(transactions.type, f.type as never) : undefined,
    f.status ? eq(transactions.status, f.status as never) : undefined,
    f.entity ? or(eq(transactions.legalEntityId, f.entity), eq(transactions.counterpartyEntityId, f.entity)) : undefined,
    f.customer ? eq(transactions.customerId, f.customer) : undefined,
    q
      ? or(
          ilike(transactions.id, like),
          ilike(transactions.paymentReference, like),
          ilike(invoices.invoiceNumber, like),
          ilike(transactions.invoiceId, like),
          ilike(transactions.chargebackCaseId, like),
          ilike(customers.fullName, like),
        )
      : undefined,
    f.from ? sql`${transactions.occurredAt} >= ${f.from}` : undefined,
    f.to ? sql`${transactions.occurredAt} <= ${f.to}` : undefined,
  );
}
