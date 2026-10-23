# Unified CRM — Logic Tech Digital · Xpectra · CoreByte

Internal, employee-only CRM that centralises customers, sales, billing and
**Recharge / Chargeback** operations for three brands, while every sale,
invoice and financial transaction keeps its own **brand** and **agent**.

> **Demo build.** All people, companies, domains and payment
> references are fictional. Payments, processor actions and integrations are
> simulated. No production database is connected or modified — the app runs on
> an embedded PostgreSQL (PGlite) stored in `.data/`.

## Run it

Requirements: Node.js 20+.

```bash
npm install
npm run dev            # http://localhost:3000 — the first start seeds the demo DB (~20 s)
```

| Script | Purpose |
| --- | --- |
| `npm run db:setup -- --yes` | One-time load of a hosted Postgres demo database (`DATABASE_URL`): migrations plus a copy of the local data. See *Deploying online*. |
| `npm run db:reset` | Delete and re-create the local demo database from the deterministic seed. Stop the dev server first (PGlite locks `.data/pglite`). Set `CRM_DATA_DIR` to use a separate copy, e.g. for tests while another server runs. |
| `npm run db:inspect` | Integrity checks: two roles only, valid relationships, chargeback caps, append-only guards. |
| `npx tsx scripts/migrate-roles.ts` | For an **existing non-demo** database only: dry-run of the two-role migration (`--apply` to run). See below. |
| `npm run typecheck` / `npm run lint` | TypeScript / ESLint. |
| `npm run test:unit` | Money math, workflow state machine, role catalogue, filters, masking, paste-details parser. |
| `npm run test:e2e` | Browser suites against a running dev server on port 3100 (`CRM_URL` to override), using your installed Chrome/Edge. |

## Deploying online (Netlify + hosted Postgres)

Netlify can't keep the local `.data/pglite` files, so the online copy uses a
hosted PostgreSQL **demo** database (Neon or Supabase, free tier is enough).
Locally nothing changes: without `DATABASE_URL` the app keeps using PGlite.

1. Create a new, empty Postgres database and copy its connection string
   (with Neon, use the *pooled* string; it ends in `?sslmode=require`).
2. Stop the local server, then load the database once from your machine.
   This applies the migrations and copies the local demo data, excluding
   login sessions. It refuses to run if the target already has users:
   ```powershell
   $env:DATABASE_URL = "postgres://…"
   npm run db:setup -- --yes          # or --seed for the fresh demo data
   Remove-Item Env:DATABASE_URL
   ```
3. In Netlify, open **Site configuration → Environment variables**, add
   `DATABASE_URL` with the same value, then deploy from Git. Netlify reads
   `netlify.toml`. Dragging the folder onto Netlify Drop can't work, because
   this app needs a server.

Keep the connection string out of Git: `.env*` files are ignored, and
`.env.example` shows the format.

## Roles

Exactly two roles exist. Each user has exactly one.

| | Super Admin | Sales Agent |
| --- | --- | --- |
| Brands | All three, always | Only assigned brands |
| Dashboard | All brands, all agents | Own records only |
| Customers / Sales / Billing | Everything | Own customers & orders; take orders |
| Recharge / Chargeback | Review, approve / reject, process — never their own request | Submit requests; view own |
| Brands, Agents, Reports, Activity Logs, Settings | Yes | No (denied on the server, not just hidden) |

Separation of duties: nobody can review or approve their own recharge request
(configurable in Settings). A user can't change their own role or suspend
themselves, and the last active Super Admin can't be demoted or suspended.

## Demo accounts (local demo only)

Password for all three: **`Demo@2026!`** — a local-demo credential that must be
changed before any production use (stored only as a bcrypt hash).

| Email | Role | Brands |
| --- | --- | --- |
| admin@crm.demo | Super Admin | All three |
| agent@crm.demo | Sales Agent (Bilal Ahmed) | Logic Tech Digital, Xpectra |
| agent2@crm.demo | Sales Agent (Emily Carter) | Xpectra, CoreByte |

The Super Admin creates further accounts under **Administration → Agents** (`/admin/agents`; the old `/admin/users` redirects there).

## Demo dataset

Deterministic (same ids and amounts on every reset; dates are offsets from the
moment of seeding so the demo always looks current):

- 3 brands
- 1 Super Admin, 2 Sales Agents
- 6 customers (one linked to two brands), 6 sales, 6 invoices (paid, partially paid, pending, overdue), 4 payments
- 2 recharge / chargeback cases: one **completed** and one **pending review** awaiting the Super Admin
- a few activity-log entries and two notifications

## Navigation

| Group | Pages |
| --- | --- |
| Overview | Dashboard |
| Operations | Customers (list, profile, edit; duplicate review), Sales (agent totals + order history with a Chargeback button on each paid order), Billing (one-page order form), Recharge / Chargeback (request form, work queues, register with the agent on every case) |
| Administration (Super Admin) | Brands, Agents, Reports, Activity Logs, Settings |

### What each form asks for

- **Take an order** (`/billing/new`): brand, amount, optional invoice number and description, then the customer's details — first / last name, company, email, phone, country and address — then payment status, method and processor reference. There is no separate "add customer" step: saving the order reuses the customer with the same email (filling any blank details) or creates a new one. A different email with a matching phone is flagged for duplicate review, never merged automatically.
- **Paste details:** one click reads the clipboard (or opens a paste box if the browser blocks it) and fills name, company, email, phone, address, amount, description and invoice number from labelled or free-form text. Card numbers, CVV and expiry lines are always discarded and the agent is warned.
- **Brands:** create, rename, change or remove the logo (PNG/JPEG/WebP up to 150 KB), delete. Brand ID, code, invoice prefix and billing defaults are automatic. A brand that has customers, sales, invoices or chargebacks can't be deleted. Super Admins get every new brand; agents are assigned brands on the Agents page.

API: `GET /api/search?q=` (scoped global search) · `GET /api/export/[dataset]` (Super Admin, audited CSV).

## Moving an existing database to the two-role model

Migrations are non-destructive: `0002` only relaxes the customer address/brand columns, makes catalogue products optional on sale lines and adds a brand logo column. Roles are data. For the demo, `npm run db:reset`
is all that's needed. For a database that holds real records:

1. Back it up.
2. `npx tsx scripts/migrate-roles.ts` — dry run: lists obsolete roles, which users would become Sales Agents (least privilege) and the remaining Super Admins. It aborts if no active Super Admin would remain.
3. `npx tsx scripts/migrate-roles.ts --apply` — one transaction; no users, customers, sales, invoices or ledger rows are deleted. Promote anyone who needs full access afterwards in Agents.

## Architecture

- **Next.js 16.4 App Router** (Cache Components + Partial Prefetching), React 19, TypeScript, Tailwind v4, shadcn/ui (Radix), Lucide, Recharts, Zod, Sonner.
- **PostgreSQL schema via Drizzle ORM** (`lib/db/schema.ts`, migrations in `drizzle/`), running on PGlite for the demo; the same migrations run on a real PostgreSQL server (see `docs/INTEGRATION_AND_MIGRATION.md`).
- **Security**: DB-backed sessions, bcrypt, lockout, server-side role checks plus brand / ownership scoping in SQL, separation of duties, append-only audit and ledger enforced by DB triggers (`docs/SECURITY.md`).

Further documentation: `docs/DATABASE.md`, `docs/INTEGRATION_AND_MIGRATION.md`,
`docs/SECURITY.md`, `docs/CONVENTIONS.md`.

## Assumptions requiring confirmation

- **Legal entities / LLCs are not part of the UI.** The database schema still has legal-entity columns (financial rows keep one, assigned automatically) so no history is lost; nothing about them is shown or editable.
- **Recharge = payment chargeback.** Each case is tied to the order it was raised on and shows that order's agent.
- With a single Super Admin and independent approval switched on, the admin's *own* recharge requests need a second Super Admin to approve them (or the policy can be relaxed in Settings).
- Demo data is single-currency (USD). Commission is not modelled.

## Known limitations

- MFA is not implemented. Rate limiting (login, search) is in-memory per server instance.
- Payments, processor submissions and integration tests are simulated.
- PGlite is single-connection: fine for a demo, not for production load.
