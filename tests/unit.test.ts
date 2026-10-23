/**
 * Pure-logic unit tests (no server, no DB).   npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCents, formatMoney, fromCents, percentOf, toCents } from "../lib/money";
import { availableActions, evaluate, type WorkflowPolicy } from "../lib/domain/chargeback-workflow";
import { ALL_PERMISSIONS, ROLES } from "../lib/domain/permissions";
import { parseFilters, resolveRange, toQueryString } from "../lib/filters";
import { maskEmail, maskPhone, maskReference } from "../lib/mask";
import { parsePastedOrder } from "../components/billing/paste-parse";

test("money: string <-> cents round-trips without float error", () => {
  assert.equal(toCents("0.1"), 10);
  assert.equal(toCents("0.10"), 10);
  assert.equal(toCents("1234.5"), 123450);
  assert.equal(toCents("-12.34"), -1234);
  assert.equal(toCents(""), 0);
  assert.equal(fromCents(10 + 20), "0.30"); // 0.1 + 0.2 === 0.30 exactly
  assert.equal(fromCents(-5), "-0.05");
  assert.equal(fromCents(123450), "1234.50");
  const items = ["0.10", "0.20", "19.99", "2499.00"].map(toCents);
  assert.equal(fromCents(items.reduce((a, b) => a + b, 0)), "2519.29");
});

test("money: percentage rounding is half-up to the cent", () => {
  assert.equal(percentOf(249900, 10), 24990);
  assert.equal(percentOf(119900, "8.25"), 9892); // 9891.75 → 9892
  assert.equal(percentOf(29900, "5.00"), 1495);
  assert.equal(percentOf(1, 50), 1); // 0.5 cent → 1
});

test("money: formatting", () => {
  assert.equal(formatMoney("1234.5", "USD"), "$1,234.50");
  assert.equal(formatCents(123456789, "USD", { compact: true }), "$1.2M");
});

test("billing math: line totals = gross − discount + tax on discounted base", () => {
  const unit = toCents("1199.00");
  const qty = 3;
  const gross = unit * qty; // 3597.00
  const discount = percentOf(gross, 10); // 359.70
  const tax = percentOf(gross - discount, "8.25"); // 8.25% of 3237.30 = 267.077… → 267.08
  assert.equal(tax, 26708);
  assert.equal(fromCents(gross - discount + tax), "3504.38");
});

const policy: WorkflowPolicy = { requireIndependentReview: true, requireIndependentApproval: true };
const perms = (role: keyof typeof ROLES) => new Set(ROLES[role].permissions);

test("workflow: agent can submit own draft, cannot review or approve", () => {
  const agent = { id: "U-A", permissions: perms("sales_agent") };
  const c = { status: "draft" as const, requestedBy: "U-A", reviewedBy: null };
  assert.equal(evaluate("submit", agent, c, policy).allowed, true);
  const pr = { ...c, status: "pending_review" as const };
  assert.equal(evaluate("forward", agent, pr, policy).allowed, false);
  assert.equal(evaluate("approve", agent, { ...c, status: "pending_approval" }, policy).allowed, false);
});

test("workflow: Super Admin cannot review or approve their own request (separation of duties)", () => {
  const admin = { id: "U-ADMIN", permissions: perms("super_admin") };
  const own = { status: "pending_review" as const, requestedBy: "U-ADMIN", reviewedBy: null };
  const r = evaluate("forward", admin, own, policy);
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /Separation of duties/);
  const a = evaluate("approve", admin, { ...own, status: "pending_approval" }, policy);
  assert.equal(a.allowed, false);
  assert.match(a.reason!, /cannot approve your own/);
  // …allowed only when the policy is switched off in Settings
  assert.equal(evaluate("approve", admin, { ...own, status: "pending_approval" }, { requireIndependentApproval: false, requireIndependentReview: false }).allowed, true);
});

test("workflow: Super Admin reviews, approves, rejects and processes an agent's request", () => {
  const admin = { id: "U-ADMIN", permissions: perms("super_admin") };
  const req = (status: "pending_review" | "pending_approval" | "approved" | "processing") => ({ status, requestedBy: "U-AGENT", reviewedBy: null });
  assert.equal(evaluate("forward", admin, req("pending_review"), policy).allowed, true);
  assert.equal(evaluate("reject", admin, req("pending_review"), policy).allowed, true);
  assert.equal(evaluate("approve", admin, req("pending_approval"), policy).allowed, true);
  assert.equal(evaluate("reject", admin, req("pending_approval"), policy).allowed, true);
  assert.equal(evaluate("start_processing", admin, req("approved"), policy).allowed, true);
  assert.equal(evaluate("complete", admin, req("processing"), policy).allowed, true);
});

test("workflow: invalid transitions are rejected", () => {
  const admin = { id: "U-ADMIN", permissions: perms("super_admin") };
  const c = { status: "draft" as const, requestedBy: "U-X", reviewedBy: null };
  assert.equal(evaluate("approve", admin, c, policy).allowed, false); // draft → approved skips review
  assert.equal(evaluate("complete", admin, { ...c, status: "approved" }, policy).allowed, false); // must start processing first
  assert.equal(evaluate("cancel", admin, { ...c, status: "completed" }, policy).allowed, false); // closed
});

test("workflow: a Sales Agent can never review, approve, reject or process — even someone else's request", () => {
  const agent = { id: "U-A", permissions: perms("sales_agent") };
  for (const status of ["pending_review", "pending_approval", "approved", "processing"] as const) {
    const allowed = availableActions(agent, { status, requestedBy: "U-OTHER", reviewedBy: null }, policy)
      .filter((a) => a.allowed)
      .map((a) => a.action);
    assert.deepEqual(allowed.filter((a) => a !== "note"), [], status);
  }
});

test("rbac: exactly two roles; Super Admin has every permission; Sales Agent has no admin capabilities", () => {
  assert.deepEqual(Object.keys(ROLES).sort(), ["sales_agent", "super_admin"]);
  for (const [id, role] of Object.entries(ROLES)) for (const p of role.permissions) assert.ok(ALL_PERMISSIONS.includes(p), `${id}:${p}`);
  assert.equal(ROLES.super_admin.permissions.length, ALL_PERMISSIONS.length);
  const agent: string[] = ROLES.sales_agent.permissions;
  for (const forbidden of ["users.manage", "settings.manage", "brands.manage", "entities.manage", "chargebacks.approve", "chargebacks.review", "reports.view", "audit.view", "sales.view_all", "billing.assign_entity"]) {
    assert.ok(!agent.includes(forbidden), `agent must not have ${forbidden}`);
  }
  for (const needed of ["customers.view", "customers.create", "customers.edit", "sales.view", "billing.create", "chargebacks.create"]) {
    assert.ok(agent.includes(needed), `agent needs ${needed}`);
  }
});

test("filters: ranges, pagination clamp and query strings", () => {
  const now = new Date("2026-10-20T15:00:00");
  const r = resolveRange("30d", now);
  assert.equal(r.from!.getDate(), new Date("2026-09-21T00:00:00").getDate());
  const f = parseFilters({ page: "-4", range: "bogus", q: "  ab  " }, now);
  assert.equal(f.page, 1);
  assert.equal(f.range, "all");
  assert.equal(f.q, "ab");
  assert.equal(toQueryString({ a: "1", page: "3" }, { page: null, b: "x y" }), "?a=1&b=x+y");
});

test("masking hides contact details and references", () => {
  assert.equal(maskEmail("jane.doe@example.com"), "j••••••@example.com");
  assert.equal(maskPhone("+1 (555) 123-4567"), "•••• 4567");
  assert.equal(maskReference("pi_demo_ABCDEFGHJK"), "pi_d…GHJK");
});

/* ------------------------------------------------------------ paste details */

test("paste: labelled lines fill the order form", () => {
  const r = parsePastedOrder(`Name: Jane Smith
Company: Acme Studio
Email: Jane@Example.com
Phone: +1 (555) 010-2030
Address: 12 Main St
City: Austin
State: TX
Zip: 78701
Amount: $1,250.50
Description: Logo package`);
  assert.equal(r.fields.firstName, "Jane");
  assert.equal(r.fields.lastName, "Smith");
  assert.equal(r.fields.company, "Acme Studio");
  assert.equal(r.fields.email?.toLowerCase(), "jane@example.com");
  assert.match(r.fields.phone ?? "", /555/);
  assert.equal(r.fields.city, "Austin");
  assert.equal(r.fields.state, "TX");
  assert.equal(r.fields.zip, "78701");
  assert.equal(r.fields.amount, "1250.50");
  assert.equal(r.fields.description, "Logo package");
  assert.equal(r.removedCardData, false);
});

test("paste: card numbers, CVV and expiry are dropped, never filled", () => {
  const r = parsePastedOrder(`John Doe
john.doe@example.com
555-201-3344
Card: 4111 1111 1111 1111
CVV: 123
Exp: 12/28`);
  assert.equal(r.removedCardData, true);
  const all = JSON.stringify(r.fields);
  assert.doesNotMatch(all, /4111/);
  assert.doesNotMatch(all, /\b123\b/);
  assert.equal(r.fields.firstName, "John");
  assert.equal(r.fields.lastName, "Doe");
  assert.equal(r.fields.email, "john.doe@example.com");
});

test("paste: a lone word yields no contact details", () => {
  const r = parsePastedOrder("hello");
  assert.equal(r.fields.email, undefined);
  assert.equal(r.fields.phone, undefined);
  assert.equal(r.fields.amount, undefined);
});
