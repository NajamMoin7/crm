# Engineering conventions — Unified CRM

Read this before adding a module. The reference implementation of every
pattern below is the **Customers** module:
`app/(crm)/customers/page.tsx`, `app/(crm)/customers/actions.ts`,
`lib/data/customers.ts`, `lib/services/customers.ts`.

## Stack facts (Next.js 16.4 — differs from older Next.js)

- App Router, `cacheComponents: true`, `partialPrefetching: true`. Docs are in
  `node_modules/next/dist/docs/`. `middleware` is now **`proxy.ts`**.
- `params` / `searchParams` are Promises. Use the global helpers
  `PageProps<"/route/[id]">` and `LayoutProps<"/route">` for typing.
- Every authenticated page lives in `app/(crm)/…`. The group has a
  `loading.tsx` which provides the Suspense boundary for page content, so a
  page component may simply `await requireViewer()` first.
- **Always call `requireViewer()` (or `authorize()`) before `new Date()`,
  `Math.random()` or DB access in a page/component.** Session reads call
  `connection()`, which is what makes later time-dependent code legal. A
  component that renders `new Date()` before a request-time read crashes with
  "encountered the unstable value new Date() while prerendering".
- Client components that call `useSearchParams()` are fine inside page content.
- After a mutation in a Server Action, call `refresh()` from `next/cache`
  (re-renders the current route) or `redirect()` to a detail page.
- **Next 16 keeps up to 3 visited routes mounted but hidden (React
  `<Activity>`)** — see `node_modules/next/dist/docs/01-app/02-guides/preserving-ui-state.md`.
  Consequences: (1) "create" forms/wizards must reset their state after a
  successful save (e.g. remount via a `key` — see `CaseWizard` in
  `components/recharge/case-wizard.tsx`), otherwise revisiting `/x/new`
  shows the previous filled-in form; transient dialogs/popovers should close
  on hide. (2) Browser tests must use visibility-aware selectors
  (`getByRole`, or `locator("main h1:visible")`) because hidden previous pages
  are still in the DOM.
- Do **not** use `export const dynamic`, `revalidate`, `unstable_noStore`, or
  `"use cache"` in this app — everything is per-request, per-user data.

## Data access & security (non-negotiable)

- DB: `const C = await getDb()` from `@/lib/db` (MongoDB). Collections are
  `C.customers`, `C.invoices`, …; document shapes come from `lib/db/schema.ts`.
  Multi-step writes go in `withTransaction(() => …)`; inside it, run database
  calls one after another (no `Promise.all`). Search text goes through
  `contains()` / `equalsCi()` from `lib/db/query.ts` (regex-escaped).
- Authorisation is server-side only:
  - Pages: `const viewer = await requireViewer(); if (!can(viewer, "perm")) return <AccessDenied />;`
  - Server Actions / Route Handlers: `const viewer = await authorize("perm")`
    inside `runAction(async () => { … })` (from `lib/actions.ts`), which turns
    `AuthorizationError`, `BusinessRuleError` and `ZodError` into a typed
    `ActionResult` (`lib/action-result.ts`).
  - Row-level scope: compose `scopeSales / scopeInvoices / scopeTransactions /
    scopeCases / scopeLeads / scopeCustomers` from `lib/auth/scope.ts` into
    every list **and** detail query. For a detail page, load the row *with*
    the scope condition; if nothing comes back, render `<AccessDenied />` or
    `notFound()` — never trust an id from the URL.
  - Brand filter: `f.brand = await resolveBrand(viewer, f.brand)` (URL param
    wins over the top-bar brand selector; both validated).
  - Legal-entity visibility: `viewer.entityIds` is `"all"` or a list; use
    `canAccessEntity()`.
- Validate all input with Zod (`lib/validation.ts` for shared schemas). Money
  inputs are strings matched by `moneyString`; convert with `toCents()` and
  do arithmetic in integer cents (`lib/money.ts`); store with `fromCents()`.
- Every mutation runs in `db.transaction(async (tx) => …)` and writes an
  audit entry with `logActivity(tx, {...})` (`lib/audit.ts`). Never log
  passwords, card numbers, CVV or secrets. Use `notify(userIds, {...})`
  for user notifications (always include an `href`).
- New ids: `await nextId("kind")` (`lib/db/ids.ts`), invoice numbers via
  `nextInvoiceNumber`, case ids via `nextCaseId`.
- Ledger (`transactions`) rows, `activity_logs`, `chargeback_events` and
  `customer_merge_history` are append-only (enforced in `lib/db/collections.ts`). Corrections are new
  rows (refund, reversal, adjustment) — never UPDATE money fields.
- Gross sales ≠ collected payments ≠ outstanding ≠ refunds ≠ chargebacks ≠
  internal transfers. `intercompany_recharge` ledger rows are never revenue.
  Only `completed` chargeback cases count as chargeback amounts.
- Sensitive-field masking helpers live in `lib/mask.ts`.

## UI

- shadcn/ui (Radix) components in `components/ui/*`; CRM building blocks in
  `components/crm/*`: `PageHeader`, `SectionCard`, `DetailList`, `FilterBar`
  (URL-driven filters), `Pagination`, `KpiCard`, `StatusBadge`/`VocabBadge`
  (vocabularies in `lib/domain/vocab.ts`), `BrandBadge`/`BrandMark`,
  `EmptyState`, `Timeline`, `ActionButton` (confirm dialog → server action →
  toast → refresh), `ExportButton`, `AccessDenied`, `PageSkeleton`.
- Icons: `lucide-react`. Toasts: `toast` from `sonner`.
- Reference data: `lib/data/reference.ts` (`getBrandMap`, `getViewerBrands`,
  `getAllEntities`, `getEntityMap`, `getAgentOptions`, `getUserNames`,
  `getProducts`, `brandOptions`).
- List pages: `parseFilters(await props.searchParams, now)` from
  `lib/filters.ts`, `PAGE_SIZE` = 25, render `<Pagination>` in the card.
- Formatting: `formatMoney(value, currency)`, `fmtDate`, `fmtDateTime`,
  `fmtRelative(d, now)`, `fmtNumber`, `titleCase`. Numbers in tables get the
  `tabular` class and are right-aligned.
- Brand colour in CSS: `var(--brand-LTD|XPC|CBT)`. Chart palette tokens:
  `var(--chart-1..8)`, status: `var(--status-good|warning|serious|critical)`.
- Design tone: dense, calm, enterprise (Linear/Stripe-like). Small type
  (text-sm tables, text-xs meta), subtle borders (`rounded-xl border bg-card
  shadow-xs`), no gradients, no oversized cards. Must work at 375px width:
  hide secondary table columns with `hidden md:table-cell` etc.
- Every visible control must work. No decorative buttons.
- Label simulated behaviour clearly ("Demo — simulated, no live system
  contacted").

## Testing

- Test server on its own database copy:
  `CRM_DATA_DIR=.data/mongo-test CRM_MONGO_PORT=27319 npx next dev --port 3100`;
  reset it with the same two variables and `npm run db:reset` (works while it runs).
- Browser tests: `npx tsx scripts/e2e/<file>.ts` using
  `scripts/e2e/harness.ts` (`launch`, `login(browser, email)`, `visit`,
  `check`, `shot`, `summary`). Demo password `Demo@2026!`.
- `npx tsc --noEmit` must pass for the files you touch.
