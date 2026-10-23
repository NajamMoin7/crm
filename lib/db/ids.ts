import { registeredCollections } from "./collections";

/** Identifier formats. Numbers come from the id_counters collection, so ids are never reused. */
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

/** Atomic counter (joins the current transaction, so a rolled-back save doesn't burn a number). */
export async function nextSequence(name: string): Promise<number> {
  const C = registeredCollections();
  const row = await C.idCounters.findOneAndUpdate({ name }, { $inc: { value: 1 } }, { upsert: true });
  return Number(row!.value);
}

export async function nextId(kind: IdKind): Promise<string> {
  return ID_FORMATS[kind](await nextSequence(kind));
}

/** Chargeback / recharge case ids restart numbering each year: RCB-2026-0042. */
export async function nextCaseId(at = new Date()): Promise<string> {
  const year = at.getUTCFullYear();
  return `RCB-${year}-${String(await nextSequence(`case:${year}`)).padStart(4, "0")}`;
}

/** Customer-facing invoice number, unique per brand prefix and year: LTD-2026-000123. */
export async function nextInvoiceNumber(prefix: string, at = new Date()): Promise<string> {
  const year = at.getUTCFullYear();
  return `${prefix}-${year}-${String(await nextSequence(`invnum:${prefix}:${year}`)).padStart(6, "0")}`;
}
