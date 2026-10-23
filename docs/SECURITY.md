# Security model

## Authentication
- Email + password; bcrypt (cost 10) hashes; generic error messages; dummy
  hash comparison for unknown emails (timing).
- 5 failed attempts → 15-minute account lock (audited). Per-IP throttle on the
  login action (in-memory in the demo; use Redis in production).
- Sessions: 32-byte random token in an `httpOnly`, `SameSite=Lax`, `Secure`
  (production) cookie; only its SHA-256 is stored in `sessions`. 12-hour expiry,
  revoked on logout, suspension and password reset.
- Suspended users cannot sign in and existing sessions stop working
  immediately (status is checked on every request).
- MFA: `users.mfa_enabled` flag exists; TOTP enrolment is a production
  follow-up (see Known limitations in README).

## Authorisation (server-side)
- Every page calls `requireViewer()` + `can()`; every Server Action / Route
  Handler calls `authorize()`. Hiding navigation is cosmetic only.
- Row-level scope is applied in SQL for every list and detail query:
  brand access, legal-entity access and ownership (agents see their own
  sales/invoices/cases). Changing ids in URLs or action payloads returns
  "Access restricted" / an error.
- Sensitive operations need specific permissions (entity assignment,
  payments/refunds, approvals, merges, exports, configuration).
- Separation of duties: requesters cannot review, approve, reject or return
  their own recharge / chargeback requests (configurable policy).
- Two roles only (Super Admin, Sales Agent). Users cannot change their own role or
  suspend themselves, and the last active Super Admin cannot be demoted or suspended.
- `proxy.ts` only does an optimistic cookie-presence redirect and sets
  security headers (`X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`,
  `Permissions-Policy`).

## Input & output handling
- All inputs validated with Zod on the server; money parsed as decimal strings
  and computed in integer cents; totals always recomputed server-side.
- Drizzle parameterises every query (no string-built SQL with user input).
- React escapes output (XSS); no `dangerouslySetInnerHTML`.
- Server Actions are POST-only with Next.js origin checks (CSRF); the session
  cookie is `SameSite=Lax`.
- CSV exports neutralise formula injection (`= + - @` prefixed) and are
  audit-logged with dataset, filters and row count.
- Payment data: only tokenised processor references. Inputs that look like
  card numbers (13–19 digits) are rejected; references are masked for users
  without ledger access. Logs never contain passwords, PAN or CVV.

## Audit
- `activity_logs`, `chargeback_events`, `customer_merge_history` are
  append-only at the database level; ledger rows are immutable.
- Logged: sign-in/out/failures/lockouts, record creation and changes (with
  before/after diff), brand and entity assignments, approvals/rejections,
  merges, payments/refunds, exports, integration runs, settings and
  permission changes.

## Production checklist
HTTPS only (HSTS), managed PostgreSQL with RLS policies, secrets in the
platform secret store, shared rate-limit store, MFA enrolment, backup/PITR,
log shipping & alerting, dependency scanning, and a penetration test before
go-live.
