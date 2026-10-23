# Database schema

**MongoDB**, one collection per entity below (collection name = the name
shown). Document fields, types and defaults are declared in
`lib/db/schema.ts` (Drizzle column builders, used only as a typed schema);
indexes live in `lib/db/indexes.ts`; the typed access layer and the
append-only protections are in `lib/db/collections.ts`. Locally the app runs
its own MongoDB (`.data/mongo`, a one-node replica set so transactions work);
online it uses MongoDB Atlas via `MONGODB_URI`.

## Conventions

| Concern | Rule |
| --- | --- |
| Identifiers | Stable, human-readable string `id`s (unique index) minted from `id_counters`: `CUS-100001`, `SAL-200001`, `INV-300001`, `TXN-500001`, `RCB-2026-0001`, `LEAD-00001`, `ADJ-0001`, … Never reused or changed. |
| Customer-facing invoice numbers | `<BRAND PREFIX>-<YEAR>-<######>` (unique index), per brand and year. |
| Money | Decimal strings (`"1234.50"`) plus an explicit ISO-4217 `currency` field. App code converts to integer cents (`lib/money.ts`); aggregations sum them exactly as Decimal128. |
| Time | Dates (UTC) everywhere. Mapping validity uses `YYYY-MM-DD` strings. |
| Deletion | No hard deletes of business records. Customers are merged (`merged_into_id`) or archived (`archived_at`); mappings are ended (`effective_to`); users are suspended. |
| Append-only history | The data layer (`lib/db/collections.ts`) blocks updates/deletes on `activity_logs`, `chargeback_events`, `customer_merge_history`; block DELETE on `transactions` and any change to a ledger row's money, currency, type, brand, entity, customer, invoice or date; block changes to closed chargeback cases. |
| Checks | Enforced by the services before writing: `0 ≤ amount_paid ≤ total`, positive ledger and case amounts, duplicate pairs reference two different customers. `npm run db:inspect` re-checks them. |

## Entity overview

```
users ─< user_roles >─ roles ─< role_permissions >─ permissions
users ─< user_brand_access >─ brands ─< brand_legal_entities >─ legal_entities
users ─< user_legal_entity_access >─ legal_entities
users ─ sales_agents (1:1 profile: code, team, monthly target)

brands ─< products_services
customers ─< customer_brand_relationships >─ brands      (one identity, many brands)
customers ─< duplicate_candidates, customer_merge_history
leads → brand, customer?, agent

sales (brand, customer, agent, legal_entity) ─< sale_items → products_services
invoices (1 per sale: brand, customer, legal_entity, agent) ─< invoice_items
transactions  = single financial ledger (payment | refund | chargeback |
                chargeback_reversal | adjustment | intercompany_recharge)
                → brand, legal_entity, counterparty_entity?, customer?, invoice?,
                  related_transaction?, chargeback_case?, adjustment?
chargeback_cases (case_type chargeback | intercompany_recharge)
                → brand, customer, invoice, original_transaction,
                  original_legal_entity, responsible_legal_entity,
                  ledger_transaction (when completed)
chargeback_events  append-only workflow history per case
financial_adjustments → invoice, brand, legal_entity, ledger_transaction
reconciliation_records → brand, legal_entity, transaction?

integration_sources (1 per brand) ─< integration_runs
external_record_mappings (source, entity_type, external_id) → internal_id
notes, tasks, notifications, activity_logs, system_settings, id_counters
```

## Tables

> The simplified demo has no UI for leads, financial adjustments or reconciliation. Their tables (`leads`, `tasks`, `financial_adjustments`, `reconciliation_records`) are kept in the schema for future modules, are empty in the demo seed, and dropping them would be a destructive migration.


| Table | Purpose / key columns |
| --- | --- |
| `roles`, `permissions`, `role_permissions`, `user_roles` | Exactly two fixed roles — `super_admin` and `sales_agent` — each a bundle of fine-grained permissions (`lib/domain/permissions.ts`) checked on the server. Every user has exactly one role. |
| `users` | One account per employee across all brands. bcrypt `password_hash`, `status`, `failed_login_count`, `locked_until`, `mfa_enabled` (placeholder). Unique `lower(email)`. |
| `sessions` | Server-side sessions. Only the SHA-256 of the cookie token is stored. |
| `brands` | LTD / XPC / CBT: code, domain, colour, status, default + allowed currencies, invoice prefix (unique), payment terms, default tax rate, allowed payment methods. |
| `legal_entities` | LLCs: registered name, internal code (unique), jurisdiction, status, base currency, permitted transaction types. |
| `brand_legal_entities` | Configurable brand→LLC mapping with `scope` (`sale` / `chargeback` / `all`), `is_default`, `effective_from/to`. Supports one or many LLCs per brand, different LLCs per transaction type and historic assignments. |
| `user_brand_access`, `user_legal_entity_access` | Brand-level and LLC-level data restrictions. |
| `products_services` | Per-brand catalogue (unique `brand_id, sku`). |
| `sales_agents` | Agent profile for users with the Sales Agent role. Commission deliberately **not** modelled (no business rules provided). |
| `customers` | Global customer identity (`CUS-…`). `phone_normalized` for matching, `first_brand_id`, `assigned_agent_id`, `tags[]`, `merged_into_id`, `archived_at`, `last_activity_at`. Email/phone are indexed but **not unique** — duplicates are reviewed, never auto-merged. |
| `customer_brand_relationships` | Which brands a customer is associated with, first-seen date, legacy `source_system_id`. |
| `duplicate_candidates` | Possible duplicates (reasons, score, status open/dismissed/merged, reviewer). |
| `customer_merge_history` | Append-only: survivor, merged record snapshot (JSON), ids of moved records, reason, performer. |
| `leads` | Pipeline (stage enum), estimated value, brand, agent. |
| `sales`, `sale_items` | Sale with brand, customer, attributed agent, legal entity, subtotal/discount/tax/total, status, source system ids. |
| `invoices`, `invoice_items` | Billing record per sale. Keeps brand, legal entity, customer, agent, status, payment method and a line-item snapshot. `amount_paid` is maintained in the same DB transaction as ledger rows. |
| `transactions` | The ledger. Every money movement is one row; positive `amount`, `type` gives direction. Tokenised `payment_reference` (unique) — never PAN/CVV. |
| `chargeback_cases` | Recharge / chargeback (and intercompany recharge) cases with original and responsible legal entity, reason code, origin (CRM / processor), external reference, evidence, reviewer/decider/processor, ledger link. |
| `chargeback_events` | Append-only workflow log (action, from → to status, actor, note, changes). |
| `financial_adjustments` | Credit notes, write-offs, corrections; approval workflow; ledger link when approved. |
| `reconciliation_records` | Expected vs actual settlement per brand/entity/period; exceptions and resolution. |
| `notes`, `tasks`, `notifications` | Collaboration. Notes have `visibility` (`internal` / `finance`). |
| `activity_logs` | Append-only audit trail (actor, action, entity, brand, legal entity, summary, JSON metadata, IP). |
| `integration_sources`, `integration_runs`, `external_record_mappings` | Future sync with the three brand systems: per-brand source config (no secrets — only an env reference), run history with errors, and source-id → CRM-id mappings. |
| `system_settings` | Policies (separation of duties, partial/multiple chargebacks, max dispute age, session length, lockout). |
| `id_counters` | Monotonic counters for identifiers. |

## Financial semantics (used by every dashboard & report)

| Metric | Definition |
| --- | --- |
| Gross sales | Σ `sales.total` where status ≠ cancelled, by `sale_date`. |
| Payments collected | Σ `transactions.amount` where type = payment and status = succeeded, by `occurred_at`. |
| Refunds | Σ ledger `refund` rows. |
| Chargebacks | Σ ledger `chargeback` rows = **completed** cases only. Pending cases are never counted. Booked against the **original** legal entity. |
| Adjustments | Σ approved adjustment ledger rows. |
| Intercompany recharges | Separate ledger type between two of our entities. Never revenue, never sales. |
| Outstanding | Σ (invoice total − amount_paid − approved adjustments) for pending / partially paid / overdue invoices. |

## Scoping

The application enforces brand / LLC / ownership scope in every query
(`lib/auth/scope.ts` builds the MongoDB filters). In production, give the app
its own Atlas database user with access to this database only, so nothing can
bypass the scoping and the append-only rules.
