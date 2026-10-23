import { sql } from "drizzle-orm";
import type { DbOrTx } from "./client";

/** Identifier formats. Numbers come from id_counters, so ids are never reused. */
export const ID_FORMATS = {
  user: (n: number) => `USR-${String(n).padStart(4, "0")}`,
  customer: (n: number) => `CUS-${100000 + n}`,
  sale: (n: number) => `SAL-${200000 + n}`,
  saleItem: (n: number) => `SIT-${String(n).padStart(6, "0")}`,
  invoice: (n: number) => `INV-${300000 + n}`,
  invoiceItem: (n: number) => `IIT-${String(n).padStart(6, "0")}`,
  transaction: (n: number) => `TXN-${500000 + n}`,
  lead: (n: number) => `LEAD-${String(n).padStart(5, "0")}`,
  adjustment: (n: number) => `ADJ-${String(n).padStart(4, "0")}`,
  reconciliation: (n: number) => `REC-${String(n).padStart(4, "0")}`,
  duplicate: (n: number) => `DUP-${String(n).padStart(4, "0")}`,
  merge: (n: number) => `MRG-${String(n).padStart(4, "0")}`,
  note: (n: number) => `NOTE-${String(n).padStart(5, "0")}`,
  task: (n: number) => `TSK-${String(n).padStart(5, "0")}`,
  notification: (n: number) => `NTF-${String(n).padStart(6, "0")}`,
  run: (n: number) => `RUN-${String(n).padStart(4, "0")}`,
  mapping: (n: number) => `MAP-${String(n).padStart(3, "0")}`,
  entity: (n: number) => `LLC-${String(n).padStart(3, "0")}`,
  product: (n: number) => `PRD-${String(n).padStart(4, "0")}`,
  extMap: (n: number) => `ERM-${String(n).padStart(6, "0")}`,
} as const;

export type IdKind = keyof typeof ID_FORMATS;

async function bump(db: DbOrTx, name: string): Promise<number> {
  const res = await db.execute<{ value: number }>(
    sql`INSERT INTO id_counters (name, value) VALUES (${name}, 1)
        ON CONFLICT (name) DO UPDATE SET value = id_counters.value + 1
        RETURNING value`,
  );
  return Number(res.rows[0].value);
}

export async function nextId(db: DbOrTx, kind: IdKind): Promise<string> {
  return ID_FORMATS[kind](await bump(db, kind));
}

/** Chargeback / recharge case ids restart numbering each year: RCB-2026-0042. */
export async function nextCaseId(db: DbOrTx, at = new Date()): Promise<string> {
  const year = at.getUTCFullYear();
  return `RCB-${year}-${String(await bump(db, `case:${year}`)).padStart(4, "0")}`;
}

/** Customer-facing invoice number, unique per brand prefix and year: LTD-2026-000123. */
export async function nextInvoiceNumber(db: DbOrTx, prefix: string, at = new Date()): Promise<string> {
  const year = at.getUTCFullYear();
  return `${prefix}-${year}-${String(await bump(db, `invnum:${prefix}:${year}`)).padStart(6, "0")}`;
}
