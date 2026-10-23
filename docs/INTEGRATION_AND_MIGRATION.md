# Integration & production migration plan

**Status: demo.** No production database has been connected, read or
modified. The Integration Settings page shows each brand system as
*Demo / Not Connected*; "Test connection" and "Dry run" only write simulated
run records to the demo database.

## What we need from the business before connecting anything

| # | Item | Owner |
| --- | --- | --- |
| 1 | Confirmed list of legal entities (registered names, jurisdictions, base currencies) | Finance |
| 2 | Confirmed brand → LLC rules: which LLC books sales for each brand, per transaction type, with effective dates; which LLC handles chargebacks; whether intercompany recharges are required and their accounting rules | Finance |
| 3 | Chargeback policy: dispute window, partial/multiple chargebacks, who reviews and who approves, evidence requirements | Finance / Ops |
| 4 | Read-only database credentials (or API access) for each brand system, network allow-listing, and a staging copy of each DB for dry runs | IT |
| 5 | Payment processor(s) per brand and how processor/dispute ids appear in each system | Finance / IT |
| 6 | Currencies in use (demo is USD-only) and the reporting currency / FX policy | Finance |
| 7 | Data-protection sign-off for moving customer data into the central CRM (retention, access, DPA) | Legal |
| 8 | Commission rules, if commissions should be calculated in the CRM | Sales leadership |

## Credentials & secrets

- Each `integration_sources.config.credentialsRef` points to a server-side
  environment variable (e.g. `env:LTD_SOURCE_DATABASE_URL`). Secrets are never
  stored in the database, never sent to the browser and never logged.
- Use read-only DB users on replicas for extraction. Writes back to brand
  systems (if ever needed) go through their APIs with separate credentials.
- Production app secrets: `DATABASE_URL` (PostgreSQL), session settings,
  processor API keys (tokenised flows only) — managed in the hosting
  platform's secret store.

## Migration steps

1. **Inspect** all three existing databases (schemas, row counts, data quality).
2. **Map schemas** for customers, sales/orders, billing forms/invoices,
   payments and chargebacks to the CRM model (`docs/DATABASE.md`). Do not assume
   the three systems share a schema.
3. **Identify differences** in formats and business rules (statuses, currencies,
   tax handling, phone/email formats, time zones).
4. **Preserve source ids** on every imported row (`source_system`,
   `source_record_id`, `customer_brand_relationships.source_system_id`).
5. **Create external record mappings** (`external_record_mappings`:
   source + entity type + external id → CRM id, unique) so re-runs are idempotent.
6. **Detect duplicate customers** across brands (exact email, normalised phone,
   name similarity) into `duplicate_candidates` for human review — never
   auto-merge.
7. **Dry run** each source into a staging CRM database.
8. **Reconcile**: record counts per entity and status, and financial totals per
   brand / legal entity / month (gross, collected, refunds, chargebacks) against
   the source systems and processor statements.
9. **Obtain written authorisation** to import, with the reconciliation report.
10. **Import in controlled batches** (e.g. 500 rows), each batch in a DB
    transaction, logged as an `integration_runs` row.
11. **Verify** relationships, counts, amounts and exceptions after each batch;
    stop on threshold breaches.
12. **Synchronise** going forward via approved APIs, webhooks or scheduled
    jobs (pull by `updated_at` watermark), always upserting through
    `external_record_mappings`.
13. **Monitor** errors with alerts; failed records are retried safely
    (idempotent upserts) and surfaced in "Records requiring review".
14. **Back up** before every batch (point-in-time recovery on the CRM DB) and
    keep a tested rollback procedure (batch-scoped deletes by run id on a
    staging copy, or PITR restore in production).

## Switching the CRM from PGlite to PostgreSQL

1. Provision PostgreSQL 15+ and set `DATABASE_URL`.
2. Replace `createPgliteDb` in `lib/db/client.ts` with
   `drizzle(new Pool({ connectionString }))` from `drizzle-orm/node-postgres`
   (types are identical; the `Tx` type alias keeps working).
3. Run `drizzle-kit migrate` (or the runtime migrator) — the SQL in `drizzle/`
   is plain PostgreSQL, including the append-only triggers.
4. Do **not** run the demo seed in production.
5. Add PostgreSQL row-level-security policies mirroring `lib/auth/scope.ts`.
6. Move rate limiting (login, search) to a shared store (Redis/Upstash) so it
   works across instances.

## Backup, reconciliation and rollback

- Daily full backups + WAL/PITR, restore tested monthly.
- Monthly reconciliation per brand × legal entity (`reconciliation_records`):
  processor settlements vs ledger payments; chargeback debits vs completed
  cases; exceptions resolved with notes (audited).
- Ledger corrections are always new rows (refund, reversal, adjustment); the
  DB rejects edits to completed financial history.
