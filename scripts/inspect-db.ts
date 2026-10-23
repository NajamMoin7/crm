/**
 * Integrity probe of the demo DB (stop `next dev` first — PGlite is single-process).
 *   npm run db:inspect
 * Exits non-zero if any business-consistency rule is violated.
 */
import { PGlite } from "@electric-sql/pglite";
import { DATA_DIR } from "../lib/db/client";

const RULES: [string, string][] = [
  ["only two roles exist", "select id from roles where id not in ('super_admin','sales_agent')"],
  ["every user has exactly one role", "select u.id from users u left join user_roles r on r.user_id = u.id group by u.id having count(r.role_id) <> 1"],
  ["at least one active Super Admin", "select 1 where not exists (select 1 from users u join user_roles r on r.user_id = u.id where r.role_id = 'super_admin' and u.status = 'active')"],
  ["every sales agent has at least one brand", "select u.id from users u join user_roles r on r.user_id = u.id and r.role_id = 'sales_agent' where not exists (select 1 from user_brand_access b where b.user_id = u.id)"],
  ["sale agent is authorised for the sale's brand", "select s.id from sales s where not exists (select 1 from user_brand_access b where b.user_id = s.agent_id and b.brand_id = s.brand_id)"],
  ["sale customer is linked to the sale's brand", "select s.id from sales s where not exists (select 1 from customer_brand_relationships c where c.customer_id = s.customer_id and c.brand_id = s.brand_id)"],
  ["sale legal entity is mapped to its brand", "select s.id from sales s where not exists (select 1 from brand_legal_entities m where m.brand_id = s.brand_id and m.legal_entity_id = s.legal_entity_id and m.scope in ('sale','all'))"],
  ["invoice matches its sale (brand, customer, entity, agent, total)", "select i.id from invoices i join sales s on s.id = i.sale_id where i.brand_id <> s.brand_id or i.customer_id <> s.customer_id or i.legal_entity_id <> s.legal_entity_id or i.agent_id <> s.agent_id or i.total <> s.total"],
  ["invoice amount_paid equals succeeded payments", "select i.id from invoices i where i.amount_paid <> coalesce((select sum(t.amount) from transactions t where t.invoice_id = i.id and t.type = 'payment' and t.status = 'succeeded'), 0) - coalesce((select sum(t.amount) from transactions t where t.invoice_id = i.id and t.type = 'refund' and t.status = 'succeeded'), 0)"],
  ["payments carry their invoice's brand and entity", "select t.id from transactions t join invoices i on i.id = t.invoice_id where t.type = 'payment' and (t.brand_id <> i.brand_id or t.legal_entity_id <> i.legal_entity_id or t.customer_id <> i.customer_id)"],
  ["chargeback references a payment of the same brand/customer/invoice/entity", "select c.id from chargeback_cases c join transactions t on t.id = c.original_transaction_id where t.type <> 'payment' or t.brand_id <> c.brand_id or t.customer_id <> c.customer_id or t.invoice_id <> c.invoice_id or t.legal_entity_id <> c.original_legal_entity_id"],
  ["chargebacks never exceed the original payment", "select t.id from transactions t where t.type = 'payment' and t.amount < (select coalesce(sum(c.amount), 0) from chargeback_cases c where c.original_transaction_id = t.id and c.case_type = 'chargeback' and c.status not in ('rejected','failed','cancelled'))"],
  ["completed cases have a ledger row booked against the original entity", "select c.id from chargeback_cases c left join transactions t on t.id = c.ledger_transaction_id where c.status = 'completed' and (t.id is null or t.legal_entity_id <> c.original_legal_entity_id or t.amount <> c.amount)"],
  ["requesters never approved their own case", "select id from chargeback_cases where decided_by = requested_by"],
];

async function main() {
  const c = await PGlite.create(DATA_DIR);
  let failed = 0;
  for (const [label, q] of RULES) {
    const rows = (await c.query(q)).rows;
    console.log(`${rows.length === 0 ? "✓" : "✗"} ${label}${rows.length ? ` — ${JSON.stringify(rows).slice(0, 200)}` : ""}`);
    if (rows.length) failed++;
  }
  const tryq = async (label: string, q: string) => {
    try {
      await c.query(q);
      failed++;
      console.log(`✗ ${label} — was allowed`);
    } catch (e) {
      console.log(`✓ ${label} — blocked: ${(e as Error).message.slice(0, 70)}`);
    }
  };
  await tryq("activity log is append-only", "update activity_logs set summary = 'x' where id = (select min(id) from activity_logs)");
  await tryq("ledger rows cannot be deleted", "delete from transactions where id = (select min(id) from transactions)");
  await tryq("ledger amounts are immutable", "update transactions set amount = 1 where id = (select min(id) from transactions)");
  await tryq("closed cases cannot be edited", "update chargeback_cases set amount = 1 where id = (select id from chargeback_cases where status = 'completed' limit 1)");
  for (const t of ["roles", "users", "brands", "legal_entities", "customers", "sales", "invoices", "transactions", "chargeback_cases", "activity_logs", "notifications"]) {
    const r = await c.query<{ n: number }>(`select count(*)::int as n from ${t}`);
    console.log(`  ${t.padEnd(18)} ${r.rows[0].n}`);
  }
  await c.close();
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll integrity checks passed");
  process.exit(failed ? 1 : 0);
}
main();
