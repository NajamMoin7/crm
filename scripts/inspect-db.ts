/**
 * Integrity probe of the CRM database (local, or MONGODB_URI when set).
 *   npm run db:inspect
 * Exits non-zero if any business-consistency rule is violated. Read-only, except
 * that it attempts (and expects to be refused) a few forbidden changes.
 */
import { connectMongo } from "../lib/db/client";
import { collectionName, makeCollections, type RowOf, type TableKey } from "../lib/db/collections";
import { toCents } from "../lib/money";

async function main() {
  const conn = await connectMongo();
  const C = makeCollections(conn.db);
  const all = async <K extends TableKey>(k: K) => (await C[k].find().toArray()) as RowOf<K>[];
  const [roles, users, userRoles, access, sales, rels, maps, invoices, txns, cases] = await Promise.all([
    all("roles"), all("users"), all("userRoles"), all("userBrandAccess"), all("sales"), all("customerBrandRelationships"),
    all("brandLegalEntities"), all("invoices"), all("transactions"), all("chargebackCases"),
  ]);
  const roleOf = (u: string) => userRoles.filter((r) => r.userId === u).map((r) => r.roleId);
  const hasBrand = (u: string, b: string) => access.some((a) => a.userId === u && a.brandId === b);
  const sum = (list: { amount: string }[]) => list.reduce((a, t) => a + toCents(t.amount), 0);
  const activeCase = (c: RowOf<"chargebackCases">) => !["rejected", "failed", "cancelled"].includes(c.status);

  const RULES: [string, unknown[]][] = [
    ["only two roles exist", roles.filter((r) => !["super_admin", "sales_agent"].includes(r.id)).map((r) => r.id)],
    ["every user has exactly one role", users.filter((u) => roleOf(u.id).length !== 1).map((u) => u.id)],
    ["at least one active Super Admin", users.some((u) => u.status === "active" && roleOf(u.id).includes("super_admin")) ? [] : ["none"]],
    ["every sales agent has at least one brand", users.filter((u) => roleOf(u.id).includes("sales_agent") && !access.some((a) => a.userId === u.id)).map((u) => u.id)],
    ["sale agent is authorised for the sale's brand", sales.filter((s) => !hasBrand(s.agentId, s.brandId)).map((s) => s.id)],
    ["sale customer is linked to the sale's brand", sales.filter((s) => !rels.some((r) => r.customerId === s.customerId && r.brandId === s.brandId)).map((s) => s.id)],
    [
      "sale legal entity is valid for its brand",
      sales.filter((s) => maps.some((m) => m.brandId === s.brandId) && !maps.some((m) => m.brandId === s.brandId && m.legalEntityId === s.legalEntityId && ["sale", "all"].includes(m.scope))).map((s) => s.id),
    ],
    [
      "invoice matches its sale (brand, customer, entity, agent, total)",
      invoices
        .filter((i) => {
          const s = sales.find((x) => x.id === i.saleId);
          return !s || s.brandId !== i.brandId || s.customerId !== i.customerId || s.legalEntityId !== i.legalEntityId || s.agentId !== i.agentId || toCents(s.total) !== toCents(i.total);
        })
        .map((i) => i.id),
    ],
    [
      "invoice amount paid equals succeeded payments minus refunds",
      invoices
        .filter((i) => {
          const ok = txns.filter((t) => t.invoiceId === i.id && t.status === "succeeded");
          return toCents(i.amountPaid) !== sum(ok.filter((t) => t.type === "payment")) - sum(ok.filter((t) => t.type === "refund"));
        })
        .map((i) => i.id),
    ],
    [
      "payments carry their invoice's brand, entity and customer",
      txns
        .filter((t) => t.type === "payment")
        .filter((t) => {
          const i = invoices.find((x) => x.id === t.invoiceId);
          return !i || t.brandId !== i.brandId || t.legalEntityId !== i.legalEntityId || t.customerId !== i.customerId;
        })
        .map((t) => t.id),
    ],
    [
      "chargeback references a payment of the same brand / customer / invoice / entity",
      cases
        .filter((c) => {
          const t = txns.find((x) => x.id === c.originalTransactionId);
          return !t || t.type !== "payment" || t.brandId !== c.brandId || t.customerId !== c.customerId || t.invoiceId !== c.invoiceId || t.legalEntityId !== c.originalLegalEntityId;
        })
        .map((c) => c.id),
    ],
    [
      "chargebacks never exceed the original payment",
      txns.filter((t) => t.type === "payment" && toCents(t.amount) < sum(cases.filter((c) => c.originalTransactionId === t.id && c.caseType === "chargeback" && activeCase(c)))).map((t) => t.id),
    ],
    [
      "completed cases have a ledger row booked against the original entity",
      cases
        .filter((c) => c.status === "completed")
        .filter((c) => {
          const t = txns.find((x) => x.id === c.ledgerTransactionId);
          return !t || t.legalEntityId !== c.originalLegalEntityId || toCents(t.amount) !== toCents(c.amount);
        })
        .map((c) => c.id),
    ],
    ["requesters never approved their own case", cases.filter((c) => c.decidedBy && c.decidedBy === c.requestedBy).map((c) => c.id)],
  ];

  let failed = 0;
  for (const [label, bad] of RULES) {
    console.log(`${bad.length === 0 ? "✓" : "✗"} ${label}${bad.length ? ` — ${JSON.stringify(bad).slice(0, 200)}` : ""}`);
    if (bad.length) failed++;
  }

  const refused = async (label: string, attempt: () => Promise<unknown>) => {
    try {
      await attempt();
      failed++;
      console.log(`✗ ${label} — was allowed`);
    } catch (e) {
      console.log(`✓ ${label} — blocked: ${(e as Error).message.slice(0, 70)}`);
    }
  };
  const firstLog = await C.activityLogs.findOne({}, { sort: { id: 1 } });
  const firstTxn = txns[0];
  const closed = cases.find((c) => c.status === "completed");
  if (firstLog) await refused("activity log is append-only", () => C.activityLogs.updateOne({ id: firstLog.id }, { $set: { summary: "x" } }));
  if (firstTxn) {
    await refused("ledger rows cannot be deleted", () => C.transactions.deleteOne({ id: firstTxn.id }));
    await refused("ledger amounts are immutable", () => C.transactions.updateOne({ id: firstTxn.id }, { $set: { amount: "1.00" } }));
  }
  if (closed) await refused("closed cases cannot be edited", () => C.chargebackCases.updateOne({ id: closed.id }, { $set: { amount: "1.00" } }));

  for (const k of ["roles", "users", "brands", "legalEntities", "customers", "sales", "invoices", "transactions", "chargebackCases", "activityLogs", "notifications"] as TableKey[]) {
    console.log(`  ${collectionName(k).padEnd(18)} ${await (C[k] as unknown as { countDocuments(): Promise<number> }).countDocuments()}`);
  }
  await conn.close();
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll integrity checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
