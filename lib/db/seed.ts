/**
 * Minimal, deterministic demo dataset.
 *
 * Every person, company, domain, legal entity and payment reference below is
 * fictional. Brand → LLC mappings are DEMO ASSUMPTIONS to be replaced with the
 * confirmed business relationships before go-live.
 *
 * Nothing here is random: ids, names and amounts are fixed, and dates are fixed
 * offsets from the moment of seeding (so the demo always looks current).
 *
 *   3 brands · 3 legal entities · 1 Super Admin · 2 Sales Agents
 *   6 customers · 6 sales · 6 invoices · 4 payments · 2 recharge / chargeback cases
 */
import bcrypt from "bcryptjs";
import type { DB } from "./client";
import * as s from "./schema";
import { ALL_PERMISSIONS, PERMISSIONS, ROLES } from "../domain/permissions";
import { fromCents, percentOf, toCents } from "../money";

/** Local demo only — must be changed (and never reused) in production. */
export const DEMO_PASSWORD = "Demo@2026!";

const DAY = 86_400_000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/* ------------------------------------------------------------- reference */

const BRANDS = [
  {
    id: "BRD-LTD", code: "LTD", name: "Logic Tech Digital", domain: "logictechdigital.demo", color: "#2a78d6", logoText: "LT",
    invoicePrefix: "LTD", paymentTermsDays: 14, defaultTaxRate: "0.00", allowedPaymentMethods: ["card", "bank_transfer", "wire", "stripe_link"],
  },
  {
    id: "BRD-XPC", code: "XPC", name: "Xpectra", domain: "xpectra.demo", color: "#eb6834", logoText: "XP",
    invoicePrefix: "XPC", paymentTermsDays: 7, defaultTaxRate: "8.25", allowedPaymentMethods: ["card", "paypal", "stripe_link", "ach"],
  },
  {
    id: "BRD-CBT", code: "CBT", name: "CoreByte", domain: "corebyte.demo", color: "#0f9a70", logoText: "CB",
    invoicePrefix: "CBT", paymentTermsDays: 30, defaultTaxRate: "5.00", allowedPaymentMethods: ["card", "bank_transfer", "ach", "wire"],
  },
] as const;

const ALL_TYPES = ["payment", "refund", "chargeback", "chargeback_reversal", "adjustment", "intercompany_recharge"];
const ENTITIES = [
  { id: "LLC-001", registeredName: "Northbridge Digital LLC", internalCode: "NBD", jurisdiction: "Delaware, US", types: ALL_TYPES, notes: "Demo entity — fictional." },
  { id: "LLC-002", registeredName: "Meridian Commerce Group LLC", internalCode: "MCG", jurisdiction: "Wyoming, US", types: ALL_TYPES, notes: "Demo entity — fictional." },
  { id: "LLC-003", registeredName: "Summit Ridge Payments LLC", internalCode: "SRP", jurisdiction: "Texas, US", types: ["chargeback", "chargeback_reversal", "intercompany_recharge"], notes: "Demo: dedicated dispute-handling entity." },
];

/** Brand → LLC mapping (configurable in Legal Entities / LLCs). */
const MAPPINGS = [
  { id: "MAP-001", brandId: "BRD-LTD", legalEntityId: "LLC-001", scope: "sale", isDefault: true },
  { id: "MAP-002", brandId: "BRD-XPC", legalEntityId: "LLC-002", scope: "sale", isDefault: true },
  { id: "MAP-003", brandId: "BRD-CBT", legalEntityId: "LLC-001", scope: "sale", isDefault: true },
  { id: "MAP-004", brandId: "BRD-CBT", legalEntityId: "LLC-002", scope: "sale", isDefault: false, notes: "Demo: CoreByte may also bill through MCG (finance-only override)." },
  { id: "MAP-005", brandId: "BRD-LTD", legalEntityId: "LLC-003", scope: "chargeback", isDefault: false },
  { id: "MAP-006", brandId: "BRD-XPC", legalEntityId: "LLC-003", scope: "chargeback", isDefault: false },
  { id: "MAP-007", brandId: "BRD-CBT", legalEntityId: "LLC-003", scope: "chargeback", isDefault: false },
];

const PRODUCTS = [
  { id: "PRD-0001", brandId: "BRD-LTD", sku: "LTD-WEB-STD", name: "Website Design Package", category: "Web Design", price: "2499.00", taxable: true },
  { id: "PRD-0002", brandId: "BRD-LTD", sku: "LTD-SEO-MO", name: "SEO Monthly Retainer", category: "Marketing", price: "899.00", taxable: true },
  { id: "PRD-0003", brandId: "BRD-LTD", sku: "LTD-ECOM", name: "E-commerce Development", category: "Development", price: "5999.00", taxable: true },
  { id: "PRD-0004", brandId: "BRD-XPC", sku: "XPC-VIDEO", name: "Video Production", category: "Media", price: "3499.00", taxable: true },
  { id: "PRD-0005", brandId: "BRD-XPC", sku: "XPC-SMM", name: "Social Media Management", category: "Marketing", price: "1199.00", taxable: true },
  { id: "PRD-0006", brandId: "BRD-XPC", sku: "XPC-BRAND", name: "Brand Identity Kit", category: "Branding", price: "1499.00", taxable: true },
  { id: "PRD-0007", brandId: "BRD-CBT", sku: "CBT-CLOUD", name: "Cloud Migration", category: "Cloud", price: "7500.00", taxable: true },
  { id: "PRD-0008", brandId: "BRD-CBT", sku: "CBT-MSP", name: "Managed IT Support (monthly)", category: "Support", price: "1299.00", taxable: true },
  { id: "PRD-0009", brandId: "BRD-CBT", sku: "CBT-SEC", name: "Cybersecurity Audit", category: "Security", price: "3999.00", taxable: true },
];

const ADMIN = "USR-0001";
const AGENT1 = "USR-0002";
const AGENT2 = "USR-0003";
const USERS = [
  { id: ADMIN, email: "admin@crm.demo", name: "Ayesha Raza", role: "super_admin" as const, brands: ["BRD-LTD", "BRD-XPC", "BRD-CBT"] },
  { id: AGENT1, email: "agent@crm.demo", name: "Bilal Ahmed", role: "sales_agent" as const, brands: ["BRD-LTD", "BRD-XPC"], agentCode: "AG-001" },
  { id: AGENT2, email: "agent2@crm.demo", name: "Emily Carter", role: "sales_agent" as const, brands: ["BRD-XPC", "BRD-CBT"], agentCode: "AG-002" },
];

const CUSTOMERS = [
  { id: "CUS-100001", fullName: "Olivia Bennett", email: "olivia@brightlinestudio.example", phone: "15125550142", company: "Brightline Studio", city: "Austin", country: "United States", type: "business", source: "Website form", brand: "BRD-LTD", agent: AGENT1, extraBrands: [], daysAgo: 70, tags: ["SMB"] },
  { id: "CUS-100002", fullName: "Hassan Iqbal", email: "hassan@apexretail.example", phone: "13125550178", company: "Apex Retail Co", city: "Chicago", country: "United States", type: "business", source: "Referral", brand: "BRD-LTD", agent: AGENT1, extraBrands: ["BRD-XPC"], daysAgo: 62, tags: ["Repeat"] },
  { id: "CUS-100003", fullName: "Sofia Reyes", email: "sofia.reyes@mail.example", phone: "13055550119", company: null, city: "Miami", country: "United States", type: "individual", source: "Social", brand: "BRD-XPC", agent: AGENT1, extraBrands: [], daysAgo: 48, tags: [] },
  { id: "CUS-100004", fullName: "Liam Walsh", email: "liam@keystoneauto.example", phone: "14165550163", company: "Keystone Auto", city: "Toronto", country: "Canada", type: "business", source: "Paid search", brand: "BRD-XPC", agent: AGENT2, extraBrands: [], daysAgo: 30, tags: [] },
  { id: "CUS-100005", fullName: "Mei Chen", email: "mei.chen@quartzfintech.example", phone: "442075550190", company: "Quartz Fintech", city: "London", country: "United Kingdom", type: "business", source: "Partner", brand: "BRD-CBT", agent: AGENT2, extraBrands: [], daysAgo: 58, tags: ["Enterprise"] },
  { id: "CUS-100006", fullName: "Noah Fletcher", email: "noah@evergreendental.example", phone: "12065550121", company: "Evergreen Dental", city: "Seattle", country: "United States", type: "business", source: "Outbound", brand: "BRD-CBT", agent: AGENT2, extraBrands: [], daysAgo: 66, tags: [] },
] as const;

type InvoiceStatus = (typeof s.invoiceStatus.enumValues)[number];
/** One sale (and one invoice) per customer. */
const SALES: {
  n: number; customer: string; brand: string; agent: string; entity: string; product: string; qty: number; discountPct: number;
  daysAgo: number; status: InvoiceStatus; method: string; paidCents?: number; ref?: string;
}[] = [
  { n: 1, customer: "CUS-100001", brand: "BRD-LTD", agent: AGENT1, entity: "LLC-001", product: "PRD-0001", qty: 1, discountPct: 0, daysAgo: 55, status: "paid", method: "card", ref: "pi_demo_LTD0001paid" },
  { n: 2, customer: "CUS-100002", brand: "BRD-LTD", agent: AGENT1, entity: "LLC-001", product: "PRD-0002", qty: 2, discountPct: 0, daysAgo: 40, status: "partially_paid", method: "bank_transfer", paidCents: 90000, ref: "BNK-DEMO-LTD0002" },
  { n: 3, customer: "CUS-100003", brand: "BRD-XPC", agent: AGENT1, entity: "LLC-002", product: "PRD-0004", qty: 1, discountPct: 0, daysAgo: 25, status: "paid", method: "card", ref: "pi_demo_XPC0003paid" },
  { n: 4, customer: "CUS-100004", brand: "BRD-XPC", agent: AGENT2, entity: "LLC-002", product: "PRD-0005", qty: 1, discountPct: 0, daysAgo: 3, status: "pending", method: "paypal" },
  { n: 5, customer: "CUS-100005", brand: "BRD-CBT", agent: AGENT2, entity: "LLC-001", product: "PRD-0007", qty: 1, discountPct: 10, daysAgo: 30, status: "paid", method: "card", ref: "pi_demo_CBT0005paid" },
  { n: 6, customer: "CUS-100006", brand: "BRD-CBT", agent: AGENT2, entity: "LLC-002", product: "PRD-0008", qty: 1, discountPct: 0, daysAgo: 45, status: "overdue", method: "bank_transfer" },
];

/* ------------------------------------------------------------------ seed */

export async function seedDatabase(db: DB) {
  const now = new Date();
  const at = (daysAgo: number, hour = 10) => {
    const d = new Date(now.getTime() - daysAgo * DAY);
    d.setUTCHours(hour, 0, 0, 0);
    return d.getTime() > now.getTime() ? new Date(now.getTime() - 3600_000) : d;
  };
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  /* RBAC — exactly two roles */
  await db.insert(s.permissions).values(
    ALL_PERMISSIONS.map((key) => {
      const p = PERMISSIONS[key] as { module: string; description: string; sensitive?: boolean };
      return { key, module: p.module, description: p.description, sensitive: !!p.sensitive };
    }),
  );
  for (const [id, role] of Object.entries(ROLES)) {
    await db.insert(s.roles).values({ id, name: role.name, description: role.description });
    await db.insert(s.rolePermissions).values(role.permissions.map((permissionKey) => ({ roleId: id, permissionKey })));
  }

  /* Brands, legal entities, mapping, products */
  await db.insert(s.brands).values(BRANDS.map((b) => ({ ...b, allowedPaymentMethods: [...b.allowedPaymentMethods], allowedCurrencies: ["USD"], defaultCurrency: "USD" })));
  await db.insert(s.legalEntities).values(
    ENTITIES.map((e) => ({ id: e.id, registeredName: e.registeredName, internalCode: e.internalCode, jurisdiction: e.jurisdiction, permittedTransactionTypes: e.types, notes: e.notes })),
  );
  const effectiveFrom = `${now.getUTCFullYear() - 1}-01-01`;
  await db.insert(s.brandLegalEntities).values(
    MAPPINGS.map((m) => ({ ...m, effectiveFrom, notes: ("notes" in m ? m.notes : undefined) ?? "Demo assumption — confirm with finance.", createdBy: null })),
  );
  await db.insert(s.productsServices).values(PRODUCTS.map((p) => ({ id: p.id, brandId: p.brandId, sku: p.sku, name: p.name, category: p.category, unitPrice: p.price, currency: "USD", taxable: p.taxable })));

  /* Users: 1 Super Admin + 2 Sales Agents */
  await db.insert(s.users).values(
    USERS.map((u, i) => ({ id: u.id, email: u.email, name: u.name, passwordHash, status: "active" as const, createdAt: at(90 - i), updatedAt: at(90 - i) })),
  );
  await db.insert(s.userRoles).values(USERS.map((u) => ({ userId: u.id, roleId: u.role })));
  await db.insert(s.userBrandAccess).values(USERS.flatMap((u) => u.brands.map((brandId) => ({ userId: u.id, brandId, grantedBy: ADMIN }))));
  await db.insert(s.salesAgents).values(
    USERS.filter((u) => u.role === "sales_agent").map((u) => ({
      userId: u.id, agentCode: u.agentCode!, team: "Sales", monthlyTarget: "25000.00", hireDate: isoDate(at(400)), managerId: ADMIN,
    })),
  );

  /* Customers (each linked to its first brand; one is also linked to a second brand) */
  await db.insert(s.customers).values(
    CUSTOMERS.map((c) => ({
      id: c.id, fullName: c.fullName, email: c.email,
      phone: c.phone.startsWith("44") ? `+44 ${c.phone.slice(2, 4)} ${c.phone.slice(4, 8)} ${c.phone.slice(8)}` : `+1 (${c.phone.slice(1, 4)}) ${c.phone.slice(4, 7)}-${c.phone.slice(7)}`,
      phoneNormalized: c.phone, companyName: c.company, country: c.country, city: c.city,
      billingAddress: `${100 + Number(c.id.slice(-1)) * 11} Market Street, ${c.city}`,
      customerType: c.type, status: "active" as const, acquisitionSource: c.source, firstBrandId: c.brand, assignedAgentId: c.agent,
      tags: [...c.tags], createdBy: c.agent, createdAt: at(c.daysAgo), updatedAt: at(c.daysAgo), lastActivityAt: at(c.daysAgo),
    })),
  );
  await db.insert(s.customerBrandRelationships).values(
    CUSTOMERS.flatMap((c) => [c.brand, ...c.extraBrands].map((brandId, i) => ({ customerId: c.id, brandId, firstSeenAt: at(c.daysAgo - i * 5) }))),
  );

  /* Sales → invoices → payments */
  const activity: (typeof s.activityLogs.$inferInsert)[] = [];
  const payments = new Map<number, string>();
  const brandSeq = new Map<string, number>();
  let txnN = 0;
  for (const sale of SALES) {
    const brand = BRANDS.find((b) => b.id === sale.brand)!;
    const product = PRODUCTS.find((p) => p.id === sale.product)!;
    const customer = CUSTOMERS.find((c) => c.id === sale.customer)!;
    const saleId = `SAL-${200000 + sale.n}`;
    const invoiceId = `INV-${300000 + sale.n}`;
    const saleDate = at(sale.daysAgo);
    const seq = (brandSeq.get(brand.id) ?? 0) + 1;
    brandSeq.set(brand.id, seq);
    const gross = toCents(product.price) * sale.qty;
    const discount = percentOf(gross, sale.discountPct);
    const tax = product.taxable ? percentOf(gross - discount, brand.defaultTaxRate) : 0;
    const total = gross - discount + tax;
    const paid = sale.status === "paid" ? total : (sale.paidCents ?? 0);

    await db.insert(s.sales).values({
      id: saleId, brandId: brand.id, customerId: customer.id, agentId: sale.agent, legalEntityId: sale.entity, saleDate, currency: "USD",
      subtotal: fromCents(gross), discount: fromCents(discount), tax: fromCents(tax), total: fromCents(total),
      status: "completed", createdBy: sale.agent, createdAt: saleDate,
    });
    await db.insert(s.saleItems).values({
      id: `SIT-${String(sale.n).padStart(6, "0")}`, saleId, productId: product.id, description: product.name, quantity: sale.qty,
      unitPrice: product.price, discount: fromCents(discount), taxRate: product.taxable ? brand.defaultTaxRate : "0", lineTotal: fromCents(total),
    });
    await db.insert(s.invoices).values({
      id: invoiceId, invoiceNumber: `${brand.invoicePrefix}-${saleDate.getUTCFullYear()}-${String(seq).padStart(6, "0")}`, saleId,
      brandId: brand.id, customerId: customer.id, legalEntityId: sale.entity, agentId: sale.agent, billingDate: saleDate,
      dueDate: new Date(saleDate.getTime() + brand.paymentTermsDays * DAY), billingAddress: `${100 + Number(customer.id.slice(-1)) * 11} Market Street, ${customer.city}`,
      currency: "USD", subtotal: fromCents(gross), discount: fromCents(discount), tax: fromCents(tax), total: fromCents(total), amountPaid: fromCents(paid),
      status: sale.status, paymentMethod: sale.method as never, createdBy: sale.agent, createdAt: saleDate, updatedAt: saleDate,
    });
    await db.insert(s.invoiceItems).values({
      id: `IIT-${String(sale.n).padStart(6, "0")}`, invoiceId, saleItemId: `SIT-${String(sale.n).padStart(6, "0")}`, description: product.name,
      quantity: sale.qty, unitPrice: product.price, lineTotal: fromCents(total),
    });
    activity.push({
      actorId: sale.agent, action: "invoice.created", entityType: "invoice", entityId: invoiceId, brandId: brand.id, legalEntityId: sale.entity,
      summary: `Billing record created for ${customer.fullName} (${fromCents(total)} USD)`, metadata: { customerId: customer.id, saleId }, createdAt: saleDate,
    });
    if (paid > 0) {
      const txnId = `TXN-${500000 + ++txnN}`;
      payments.set(sale.n, txnId);
      const paidAt = new Date(saleDate.getTime() + 2 * 3600_000);
      await db.insert(s.transactions).values({
        id: txnId, type: "payment", status: "succeeded", brandId: brand.id, legalEntityId: sale.entity, customerId: customer.id, invoiceId,
        amount: fromCents(paid), currency: "USD", paymentMethod: sale.method as never,
        processor: sale.method === "card" ? "Stripe (demo)" : "Bank (demo)", paymentReference: sale.ref!, occurredAt: paidAt,
        notes: "Simulated payment (demo).", createdBy: sale.agent, createdAt: paidAt,
      });
      activity.push({
        actorId: sale.agent, action: "payment.recorded", entityType: "invoice", entityId: invoiceId, brandId: brand.id, legalEntityId: sale.entity,
        summary: `Payment ${txnId} of ${fromCents(paid)} USD recorded`, metadata: { customerId: customer.id }, createdAt: paidAt,
      });
    }
  }

  /* Recharge / chargeback cases */
  const year = now.getUTCFullYear();
  // 1) Completed: partial dispute on the Xpectra video sale, handled by the dispute LLC,
  //    booked against the original entity. Requested by agent 1, approved by the Super Admin.
  const case1 = `RCB-${year}-0001`;
  const c1Req = at(12), c1Rev = at(11), c1Appr = at(10), c1Proc = at(10, 14), c1Done = at(5);
  const c1Ledger = `TXN-${500000 + ++txnN}`;
  await db.insert(s.transactions).values({
    id: c1Ledger, type: "chargeback", status: "succeeded", brandId: "BRD-XPC", legalEntityId: "LLC-002", customerId: "CUS-100003", invoiceId: "INV-300003",
    relatedTransactionId: payments.get(3)!, chargebackCaseId: case1, amount: "1000.00", currency: "USD", processor: "Stripe (demo)",
    paymentReference: "dp_demo_XPC0001", occurredAt: c1Done, notes: "Handled by LLC-003; booked against original entity LLC-002.", createdBy: ADMIN, createdAt: c1Done,
  });
  await db.insert(s.chargebackCases).values({
    id: case1, caseType: "chargeback", origin: "processor", brandId: "BRD-XPC", customerId: "CUS-100003", invoiceId: "INV-300003",
    originalTransactionId: payments.get(3)!, originalLegalEntityId: "LLC-002", responsibleLegalEntityId: "LLC-003", amount: "1000.00", currency: "USD",
    reasonCode: "13.3", notes: "Customer disputes the final edit as not matching the agreed storyboard.", requestDate: c1Req, requestedBy: AGENT1,
    status: "completed", externalProcessorReference: "dp_demo_XPC0001", evidenceSummary: "Storyboard sign-off email and delivery receipt.",
    reviewedBy: ADMIN, reviewedAt: c1Rev, decidedBy: ADMIN, decidedAt: c1Appr, processedBy: ADMIN, completedAt: c1Done,
    outcomeNote: "Processor debited the disputed amount.", ledgerTransactionId: c1Ledger, createdAt: c1Req, updatedAt: c1Done,
  });
  // 2) Pending review: CoreByte cloud migration, requested by agent 2 — awaiting the Super Admin.
  const case2 = `RCB-${year}-0002`;
  const c2Req = at(2), c2Sub = at(2, 11);
  await db.insert(s.chargebackCases).values({
    id: case2, caseType: "chargeback", origin: "crm", brandId: "BRD-CBT", customerId: "CUS-100005", invoiceId: "INV-300005",
    originalTransactionId: payments.get(5)!, originalLegalEntityId: "LLC-001", responsibleLegalEntityId: "LLC-001", amount: "2500.00", currency: "USD",
    reasonCode: "13.1", notes: "Customer reports the second migration phase was not delivered.", requestDate: c2Req, requestedBy: AGENT2,
    status: "pending_review", createdAt: c2Req, updatedAt: c2Sub,
  });
  await db.insert(s.chargebackEvents).values([
    { caseId: case1, action: "created", toStatus: "draft", actorId: AGENT1, note: "Recorded from processor case dp_demo_XPC0001", createdAt: c1Req },
    { caseId: case1, action: "submitted", fromStatus: "draft", toStatus: "pending_review", actorId: AGENT1, createdAt: c1Req },
    { caseId: case1, action: "reviewed", fromStatus: "pending_review", toStatus: "pending_approval", actorId: ADMIN, note: "Evidence verified.", createdAt: c1Rev },
    { caseId: case1, action: "approved", fromStatus: "pending_approval", toStatus: "approved", actorId: ADMIN, createdAt: c1Appr },
    { caseId: case1, action: "processing_started", fromStatus: "approved", toStatus: "processing", actorId: ADMIN, createdAt: c1Proc },
    { caseId: case1, action: "completed", fromStatus: "processing", toStatus: "completed", actorId: ADMIN, note: "Processor debit confirmed (demo).", changes: { ledgerTransactionId: c1Ledger }, createdAt: c1Done },
    { caseId: case2, action: "created", toStatus: "draft", actorId: AGENT2, createdAt: c2Req },
    { caseId: case2, action: "submitted", fromStatus: "draft", toStatus: "pending_review", actorId: AGENT2, createdAt: c2Sub },
  ]);
  activity.push(
    { actorId: AGENT1, action: "chargeback.created", entityType: "chargeback", entityId: case1, brandId: "BRD-XPC", legalEntityId: "LLC-003", summary: `Recharge / chargeback ${case1} opened for 1000.00 USD`, metadata: { customerId: "CUS-100003" }, createdAt: c1Req },
    { actorId: ADMIN, action: "chargeback.approved", entityType: "chargeback", entityId: case1, brandId: "BRD-XPC", legalEntityId: "LLC-003", summary: `${case1}: pending approval → approved`, metadata: { customerId: "CUS-100003" }, createdAt: c1Appr },
    { actorId: ADMIN, action: "chargeback.completed", entityType: "chargeback", entityId: case1, brandId: "BRD-XPC", legalEntityId: "LLC-002", summary: `${case1}: processing → completed; ledger ${c1Ledger} booked against LLC-002`, metadata: { customerId: "CUS-100003" }, createdAt: c1Done },
    { actorId: AGENT2, action: "chargeback.created", entityType: "chargeback", entityId: case2, brandId: "BRD-CBT", legalEntityId: "LLC-001", summary: `Recharge / chargeback ${case2} opened for 2500.00 USD`, metadata: { customerId: "CUS-100005" }, createdAt: c2Req },
  );

  /* A single useful note, two useful notifications */
  await db.insert(s.notes).values({ id: "NOTE-00001", entityType: "customer", entityId: "CUS-100002", body: "Interested in an Xpectra social media package next quarter.", authorId: AGENT1, createdAt: at(20) });
  await db.insert(s.notifications).values([
    { id: "NTF-000001", userId: ADMIN, kind: "approval_needed", title: `Review requested: ${case2}`, body: "2,500.00 USD recharge / chargeback awaiting review.", href: `/recharge/${case2}`, createdAt: c2Sub },
    { id: "NTF-000002", userId: AGENT1, kind: "case_update", title: `${case1} completed`, body: "Your request was completed.", href: `/recharge/${case1}`, createdAt: c1Done },
  ]);

  /* Integration placeholders for the three brand systems (simulated; no runs yet) */
  await db.insert(s.integrationSources).values(
    BRANDS.map((b) => ({
      id: `INT-${b.code}`, brandId: b.id, domain: b.domain, systemName: `${b.name} billing database`, status: "demo_not_connected" as const,
      config: { mode: "pull", schedule: "manual", entities: ["customers", "invoices", "payments", "chargebacks"], dryRunFirst: true, batchSize: 500, credentialsRef: `env:${b.code}_SOURCE_DATABASE_URL` },
    })),
  );

  /* Activity log */
  activity.unshift(
    { actorId: ADMIN, action: "user.created", entityType: "user", entityId: AGENT1, summary: "User Bilal Ahmed <agent@crm.demo> created as Sales Agent", createdAt: at(89) },
    { actorId: ADMIN, action: "user.created", entityType: "user", entityId: AGENT2, summary: "User Emily Carter <agent2@crm.demo> created as Sales Agent", createdAt: at(88) },
  );
  activity.sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
  await db.insert(s.activityLogs).values(activity);

  await db.insert(s.systemSettings).values([
    { key: "chargeback.require_independent_approval", value: true, description: "Requesters cannot approve their own recharge / chargeback requests." },
    { key: "chargeback.require_independent_review", value: true, description: "Requesters cannot review their own requests." },
    { key: "chargeback.allow_partial", value: true, description: "Allow chargebacks for less than the original amount." },
    { key: "chargeback.allow_multiple", value: true, description: "Allow several chargebacks against one transaction (cumulative cap enforced)." },
    { key: "chargeback.max_days_after_payment", value: 540, description: "Maximum age (days) of the original payment when opening a case." },
    { key: "reporting.currency", value: "USD", description: "Reporting currency for dashboards. Demo data is single-currency." },
    { key: "security.session_hours", value: 12, description: "Session lifetime in hours." },
    { key: "security.max_login_attempts", value: 5, description: "Failed logins before a 15-minute lockout." },
  ]);

  /* Identifier counters continue after the seeded ids. */
  const invoiceCounters = BRANDS.map((b) => ({
    name: `invnum:${b.invoicePrefix}:${year}`,
    value: SALES.filter((x) => x.brand === b.id && at(x.daysAgo).getUTCFullYear() === year).length,
  })).filter((c) => c.value > 0);
  await db.insert(s.idCounters).values([
    { name: "user", value: USERS.length },
    { name: "customer", value: CUSTOMERS.length },
    { name: "sale", value: SALES.length },
    { name: "saleItem", value: SALES.length },
    { name: "invoice", value: SALES.length },
    { name: "invoiceItem", value: SALES.length },
    { name: "transaction", value: txnN },
    { name: "entity", value: ENTITIES.length },
    { name: "mapping", value: MAPPINGS.length },
    { name: "product", value: PRODUCTS.length },
    { name: "note", value: 1 },
    { name: "notification", value: 2 },
    { name: `case:${year}`, value: 2 },
    ...invoiceCounters,
  ]);
}
