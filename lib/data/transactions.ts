import "server-only";
import type { Filter } from "mongodb";
import { getDb, type RowOf } from "@/lib/db";
import { contains } from "@/lib/db/query";
import { scopeTransactions } from "@/lib/auth/scope";
import type { Viewer } from "@/lib/auth/viewer";
import type { ListFilters } from "@/lib/filters";

type Txn = RowOf<"transactions">;

/** Filter for the ledger list / export (scope always applied). */
export async function transactionWhere(viewer: Viewer, f: ListFilters): Promise<Filter<Txn>> {
  const C = await getDb();
  const q = f.q.trim();
  const conds: Filter<Txn>[] = [scopeTransactions(viewer, f.brand)];
  if (f.type) conds.push({ type: f.type as Txn["type"] });
  if (f.status) conds.push({ status: f.status as Txn["status"] });
  if (f.entity) conds.push({ $or: [{ legalEntityId: f.entity }, { counterpartyEntityId: f.entity }] });
  if (f.customer) conds.push({ customerId: f.customer });
  if (q) {
    const rx = contains(q);
    const [invoiceIds, customerIds] = await Promise.all([
      C.invoices.distinct("id", { invoiceNumber: rx }),
      C.customers.distinct("id", { fullName: rx }),
    ]);
    conds.push({
      $or: [
        { id: rx },
        { paymentReference: rx },
        { invoiceId: rx },
        { chargebackCaseId: rx },
        { invoiceId: { $in: invoiceIds } },
        { customerId: { $in: customerIds } },
      ],
    });
  }
  if (f.from) conds.push({ occurredAt: { $gte: f.from } });
  if (f.to) conds.push({ occurredAt: { $lte: f.to } });
  return { $and: conds };
}
