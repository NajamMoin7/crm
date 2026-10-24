# Unified CRM — Logic Tech Digital · Xpectra · CoreByte

Internal, employee-only CRM that centralises customers, sales, billing and
**Recharge / Chargeback** operations for three brands, while every sale,
invoice and financial transaction keeps its own **brand** and **agent**.

> **Demo build.** All people, companies, domains and payment
> references are fictional. Payments, processor actions and integrations are
> simulated. No production database is connected or modified. Data lives in
> **MongoDB**: locally a MongoDB the app starts by itself (`.data/mongo`), online
> a MongoDB Atlas database you provide.

## Run it

Requirements: Node.js 20+.

```bash
npm install
npm run dev            # http://localhost:3000 — the first start downloads MongoDB once (~70 MB) and seeds the demo data
```

| Script | Purpose |
| --- | --- |
| `npm run db:setup -- --yes --uri "…"` | One-time load of an empty MongoDB (Atlas via `--uri` / `MONGODB_URI`, or the local one with `--local`): indexes plus a copy of the existing data from the old local database (`.data/pglite`), or `--seed` for fresh demo data. See *Deploying online*. |
| `npm run db:reset` | Delete and re-create the **local** demo database from the deterministic seed. Works while `npm run dev` runs. Refuses when `MONGODB_URI` is set. `CRM_DATA_DIR` + `CRM_MONGO_PORT` select a separate local copy (used by the tests). |
| `npm run db:inspect` | Integrity checks: two roles only, valid relationships, chargeback caps, and that the append-only protections refuse changes. |
| `npm run typecheck` / `npm run lint` | TypeScript / ESLint. |
| `npm run test:unit` | Money math, workflow state machine, role catalogue, filters, masking, paste-details parser. |
| `npm run test:e2e` | Browser suites against a running dev server on port 3100 (`CRM_URL` to override), using your installed Chrome/Edge. Start that server on a separate test copy: `CRM_DATA_DIR=.data/mongo-test CRM_MONGO_PORT=27319 npx next dev --port 3100`. |

## Deploying online (Netlify + MongoDB Atlas)

Netlify can't keep local files, so the online copy uses a **MongoDB Atlas**
database (the free M0 cluster is enough). Locally nothing changes: without
`MONGODB_URI` the app runs its own local MongoDB.

1. In Atlas, create a free cluster, a database user (Database Access) and allow
   network access from anywhere (`0.0.0.0/0`, needed for Netlify). Copy the
   connection string from **Connect → Drivers** and put the user's password in it.
2. Load it once from your machine. This creates the indexes and copies the
   existing data, excluding login sessions. It refuses to run if the target
   already has users:
   ```bash
   npm run db:setup -- --yes --uri "mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/"
   # add --seed for the fresh demo data instead of a copy
   ```
   It prints the target it is loading; without `--uri` (or `MONGODB_URI`) it
   refuses, unless you add `--local` to load the local database.
3. In Netlify, open **Site configuration → Environment variables**, add
   `MONGODB_URI` with the same value, then deploy from Git (Netlify reads
   `netlify.toml`). Dragging the folder onto Netlify Drop can't work, because
   this app needs a server.

Keep the connection string out of Git: never put it in `.env.example` or any
committed file. `.env*` files are ignored; `.env.example` shows the format only.

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

## Architecture

- **Next.js 16.4 App Router** (Cache Components + Partial Prefetching), React 19, TypeScript, Tailwind v4, shadcn/ui (Radix), Lucide, Recharts, Zod, Sonner.
- **MongoDB** (official Node.js driver). One collection per entity; document shapes, types and defaults are declared in `lib/db/schema.ts`, indexes in `lib/db/indexes.ts`. Multi-step saves run in MongoDB transactions (all or nothing); money is stored as exact decimal strings and summed as Decimal128.
- **Security**: DB-backed sessions, bcrypt, lockout, server-side role checks plus brand / ownership scoping in every database query, separation of duties. The audit log, case history and ledger are append-only, and closed chargeback cases are frozen. This is enforced in the data layer (`lib/db/collections.ts`) for every write the app makes. MongoDB has no triggers, so restrict direct database access to the app's own database user (`docs/SECURITY.md`).

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
- The local MongoDB is for development only; online use needs `MONGODB_URI`. Some pages join related records in the app; fine at demo and small-team scale.
