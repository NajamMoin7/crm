/**
 * Unified CRM — document schema.
 *
 * Stored in MongoDB, one collection per table below (collection name = table
 * name). The Drizzle column builders are used only to describe each document's
 * fields, types and defaults: the app's TypeScript types come from here, and
 * lib/db/collections.ts applies the defaults on insert. No SQL is involved.
 *
 * Conventions
 * - Stable, human-readable string ids (CUS-100001, INV numbers, …) that never
 *   change once issued; composite keys get a unique index (lib/db/indexes.ts).
 * - Money is a decimal string ("1234.50") plus an explicit ISO-4217 currency.
 *   Application code converts to integer cents before doing arithmetic
 *   (lib/money.ts); aggregations sum exact Decimal128 values.
 * - All timestamps are Dates (UTC).
 * - Financial history is append-only: transactions, chargeback_events,
 *   customer_merge_history and activity_logs are protected in lib/db/collections.ts.
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();

/* ------------------------------------------------------------------ enums */

export const recordStatus = pgEnum("record_status", ["active", "inactive", "suspended"]);
export const userStatus = pgEnum("user_status", ["active", "invited", "suspended"]);
export const integrationStatus = pgEnum("integration_status", [
  "demo_not_connected",
  "connected",
  "error",
  "disabled",
]);
export const customerStatus = pgEnum("customer_status", ["active", "prospect", "inactive", "blocked"]);
export const customerType = pgEnum("customer_type", ["individual", "business"]);
export const leadStage = pgEnum("lead_stage", [
  "new",
  "contacted",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
]);
export const saleStatus = pgEnum("sale_status", ["open", "completed", "cancelled"]);
export const invoiceStatus = pgEnum("invoice_status", [
  "draft",
  "pending",
  "paid",
  "partially_paid",
  "overdue",
  "cancelled",
  "refunded",
]);
export const paymentMethod = pgEnum("payment_method", [
  "card",
  "bank_transfer",
  "ach",
  "wire",
  "paypal",
  "stripe_link",
  "other",
]);
/** Ledger event types. Internal recharges are NOT revenue and never counted as sales. */
export const transactionType = pgEnum("transaction_type", [
  "payment",
  "refund",
  "chargeback",
  "chargeback_reversal",
  "adjustment",
  "intercompany_recharge",
]);
export const transactionStatus = pgEnum("transaction_status", ["pending", "succeeded", "failed", "reversed"]);
/** "Recharge" in business terminology = payment chargeback. Intercompany recharge is a separate type. */
export const caseType = pgEnum("case_type", ["chargeback", "intercompany_recharge"]);
export const caseStatus = pgEnum("case_status", [
  "draft",
  "pending_review",
  "pending_approval",
  "approved",
  "processing",
  "completed",
  "rejected",
  "failed",
  "cancelled",
]);
export const caseOrigin = pgEnum("case_origin", ["crm", "processor"]);
export const adjustmentType = pgEnum("adjustment_type", ["credit_note", "write_off", "correction", "refund"]);
export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected"]);
export const duplicateStatus = pgEnum("duplicate_status", ["open", "dismissed", "merged"]);
export const taskStatus = pgEnum("task_status", ["open", "done"]);
export const runStatus = pgEnum("run_status", ["success", "partial", "failed"]);
export const reconStatus = pgEnum("recon_status", ["matched", "exception", "resolved"]);

/* ------------------------------------------------------- identity & RBAC */

export const roles = pgTable("roles", {
  id: text("id").primaryKey(), // super_admin, executive, …
  name: text("name").notNull(),
  description: text("description").notNull(),
  isSystem: boolean("is_system").notNull().default(true),
  createdAt: createdAt(),
});

export const permissions = pgTable("permissions", {
  key: text("key").primaryKey(), // e.g. chargebacks.approve
  module: text("module").notNull(),
  description: text("description").notNull(),
  sensitive: boolean("sensitive").notNull().default(false),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key").notNull().references(() => permissions.key, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(), // USR-0001
    email: text("email").notNull(),
    name: text("name").notNull(),
    title: text("title"),
    passwordHash: text("password_hash").notNull(),
    status: userStatus("status").notNull().default("active"),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    lastLoginAt: ts("last_login_at"),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: ts("locked_until"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)],
);

export const userRoles = pgTable(
  "user_roles",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    roleId: text("role_id").notNull().references(() => roles.id),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the opaque cookie token — the raw token is never stored. */
    idHash: text("id_hash").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/* --------------------------------------------------- brands & LLCs */

export const brands = pgTable(
  "brands",
  {
    id: text("id").primaryKey(), // BRD-LTD
    code: text("code").notNull(), // LTD
    name: text("name").notNull(),
    domain: text("domain").notNull(),
    color: text("color").notNull(),
    logoText: text("logo_text").notNull(),
    /** Optional uploaded logo as a data: URL (PNG / JPEG / WebP, ≤ 200 KB). */
    logoUrl: text("logo_url"),
    status: recordStatus("status").notNull().default("active"),
    defaultCurrency: text("default_currency").notNull().default("USD"),
    allowedCurrencies: text("allowed_currencies").array().notNull().default(sql`ARRAY['USD']::text[]`),
    invoicePrefix: text("invoice_prefix").notNull(),
    paymentTermsDays: integer("payment_terms_days").notNull().default(14),
    defaultTaxRate: numeric("default_tax_rate", { precision: 5, scale: 2 }).notNull().default("0"),
    allowedPaymentMethods: text("allowed_payment_methods").array().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("brands_code_uq").on(t.code), uniqueIndex("brands_invoice_prefix_uq").on(t.invoicePrefix)],
);

export const legalEntities = pgTable(
  "legal_entities",
  {
    id: text("id").primaryKey(), // LLC-001
    registeredName: text("registered_name").notNull(),
    internalCode: text("internal_code").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    status: recordStatus("status").notNull().default("active"),
    baseCurrency: text("base_currency").notNull().default("USD"),
    /** Subset of transaction_type values this entity may book. */
    permittedTransactionTypes: text("permitted_transaction_types").array().notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("legal_entities_code_uq").on(t.internalCode)],
);

/**
 * Configurable brand → LLC mapping. A brand can map to several entities, and
 * the mapping can differ per transaction scope (sale / chargeback / all).
 * Historic rows are retained via effective_to; completed records keep the
 * entity id they were booked with regardless of later mapping changes.
 */
export const brandLegalEntities = pgTable(
  "brand_legal_entities",
  {
    id: text("id").primaryKey(), // MAP-001
    brandId: text("brand_id").notNull().references(() => brands.id),
    legalEntityId: text("legal_entity_id").notNull().references(() => legalEntities.id),
    scope: text("scope").notNull(), // 'sale' | 'chargeback' | 'all'
    isDefault: boolean("is_default").notNull().default(false),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("ble_brand_idx").on(t.brandId), index("ble_entity_idx").on(t.legalEntityId)],
);

export const userBrandAccess = pgTable(
  "user_brand_access",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    brandId: text("brand_id").notNull().references(() => brands.id),
    grantedBy: text("granted_by").references(() => users.id),
    grantedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.brandId] })],
);

export const userLegalEntityAccess = pgTable(
  "user_legal_entity_access",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    legalEntityId: text("legal_entity_id").notNull().references(() => legalEntities.id),
    grantedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.legalEntityId] })],
);

export const productsServices = pgTable(
  "products_services",
  {
    id: text("id").primaryKey(), // PRD-LTD-001
    brandId: text("brand_id").notNull().references(() => brands.id),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    unitPrice: money("unit_price").notNull(),
    currency: text("currency").notNull(),
    taxable: boolean("taxable").notNull().default(true),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("products_brand_sku_uq").on(t.brandId, t.sku)],
);

/* ----------------------------------------------------------- sales team */

export const salesAgents = pgTable("sales_agents", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  agentCode: text("agent_code").notNull().unique(),
  team: text("team").notNull(),
  monthlyTarget: money("monthly_target").notNull(),
  hireDate: date("hire_date").notNull(),
  managerId: text("manager_id").references(() => users.id),
});

/* ------------------------------------------------------------- customers */

export const customers = pgTable(
  "customers",
  {
    id: text("id").primaryKey(), // CUS-100001 — global, immutable
    fullName: text("full_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    /** Digits-only phone for matching; never used as identity on its own. */
    phoneNormalized: text("phone_normalized"),
    companyName: text("company_name"),
    /** Optional: collected only when a billing operation needs it. */
    country: text("country"),
    city: text("city"),
    billingAddress: text("billing_address"),
    customerType: customerType("customer_type").notNull().default("individual"),
    status: customerStatus("status").notNull().default("active"),
    acquisitionSource: text("acquisition_source"),
    /** Set when the customer is first billed under a brand; a customer may work with several brands. */
    firstBrandId: text("first_brand_id").references(() => brands.id),
    assignedAgentId: text("assigned_agent_id").references(() => users.id),
    tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
    mergedIntoId: text("merged_into_id"),
    archivedAt: ts("archived_at"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastActivityAt: ts("last_activity_at"),
  },
  (t) => [
    index("customers_email_idx").on(sql`lower(${t.email})`),
    index("customers_phone_idx").on(t.phoneNormalized),
    index("customers_agent_idx").on(t.assignedAgentId),
    index("customers_name_idx").on(sql`lower(${t.fullName})`),
  ],
);

export const customerBrandRelationships = pgTable(
  "customer_brand_relationships",
  {
    customerId: text("customer_id").notNull().references(() => customers.id),
    brandId: text("brand_id").notNull().references(() => brands.id),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    /** Original id in the brand's legacy system, when imported. */
    sourceSystemId: text("source_system_id"),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.brandId] }), index("cbr_brand_idx").on(t.brandId)],
);

export const duplicateCandidates = pgTable(
  "duplicate_candidates",
  {
    id: text("id").primaryKey(), // DUP-0001
    customerAId: text("customer_a_id").notNull().references(() => customers.id),
    customerBId: text("customer_b_id").notNull().references(() => customers.id),
    matchReasons: text("match_reasons").array().notNull(),
    score: integer("score").notNull(),
    status: duplicateStatus("status").notNull().default("open"),
    detectedBy: text("detected_by").notNull(), // 'system' | 'agent' | 'import'
    reviewedBy: text("reviewed_by").references(() => users.id),
    reviewedAt: ts("reviewed_at"),
    resolutionNote: text("resolution_note"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("dup_pair_uq").on(t.customerAId, t.customerBId)],
);

export const customerMergeHistory = pgTable("customer_merge_history", {
  id: text("id").primaryKey(), // MRG-0001
  survivorId: text("survivor_id").notNull().references(() => customers.id),
  mergedId: text("merged_id").notNull().references(() => customers.id),
  duplicateCandidateId: text("duplicate_candidate_id").references(() => duplicateCandidates.id),
  performedBy: text("performed_by").notNull().references(() => users.id),
  reason: text("reason").notNull(),
  /** Snapshot of the merged record before the merge, for audit/undo analysis. */
  snapshot: jsonb("snapshot").notNull(),
  movedRecords: jsonb("moved_records").notNull(),
  createdAt: createdAt(),
});

/* --------------------------------------------------------------- leads */

export const leads = pgTable(
  "leads",
  {
    id: text("id").primaryKey(), // LEAD-0001
    brandId: text("brand_id").notNull().references(() => brands.id),
    customerId: text("customer_id").references(() => customers.id),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    companyName: text("company_name"),
    stage: leadStage("stage").notNull().default("new"),
    estimatedValue: money("estimated_value").notNull(),
    currency: text("currency").notNull(),
    source: text("source").notNull(),
    assignedAgentId: text("assigned_agent_id").references(() => users.id),
    productInterest: text("product_interest"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("leads_brand_stage_idx").on(t.brandId, t.stage), index("leads_agent_idx").on(t.assignedAgentId)],
);

/* --------------------------------------------------------------- sales */

export const sales = pgTable(
  "sales",
  {
    id: text("id").primaryKey(), // SAL-200001
    brandId: text("brand_id").notNull().references(() => brands.id),
    customerId: text("customer_id").notNull().references(() => customers.id),
    agentId: text("agent_id").notNull().references(() => users.id),
    legalEntityId: text("legal_entity_id").notNull().references(() => legalEntities.id),
    leadId: text("lead_id").references(() => leads.id),
    saleDate: ts("sale_date").notNull(),
    currency: text("currency").notNull(),
    subtotal: money("subtotal").notNull(),
    discount: money("discount").notNull().default("0"),
    tax: money("tax").notNull().default("0"),
    total: money("total").notNull(),
    status: saleStatus("status").notNull().default("completed"),
    notes: text("notes"),
    sourceSystem: text("source_system").notNull().default("crm"),
    sourceRecordId: text("source_record_id"),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("sales_brand_date_idx").on(t.brandId, t.saleDate),
    index("sales_agent_idx").on(t.agentId),
    index("sales_customer_idx").on(t.customerId),
    index("sales_entity_idx").on(t.legalEntityId),
  ],
);

export const saleItems = pgTable("sale_items", {
  id: text("id").primaryKey(),
  saleId: text("sale_id").notNull().references(() => sales.id),
  /** Optional catalogue link; free-text line items have no product. */
  productId: text("product_id").references(() => productsServices.id),
  description: text("description").notNull(),
  quantity: integer("quantity").notNull(),
  unitPrice: money("unit_price").notNull(),
  discount: money("discount").notNull().default("0"),
  taxRate: numeric("tax_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  lineTotal: money("line_total").notNull(),
});

/* -------------------------------------------------------------- billing */

export const invoices = pgTable(
  "invoices",
  {
    id: text("id").primaryKey(), // INV-300001 (internal id)
    invoiceNumber: text("invoice_number").notNull(), // LTD-2026-000123 (customer-facing)
    saleId: text("sale_id").notNull().references(() => sales.id),
    brandId: text("brand_id").notNull().references(() => brands.id),
    customerId: text("customer_id").notNull().references(() => customers.id),
    legalEntityId: text("legal_entity_id").notNull().references(() => legalEntities.id),
    agentId: text("agent_id").notNull().references(() => users.id),
    billingDate: ts("billing_date").notNull(),
    dueDate: ts("due_date").notNull(),
    billingAddress: text("billing_address"),
    currency: text("currency").notNull(),
    subtotal: money("subtotal").notNull(),
    discount: money("discount").notNull().default("0"),
    tax: money("tax").notNull().default("0"),
    total: money("total").notNull(),
    /** Maintained transactionally from succeeded payment/refund ledger rows. */
    amountPaid: money("amount_paid").notNull().default("0"),
    status: invoiceStatus("status").notNull(),
    paymentMethod: paymentMethod("payment_method").notNull(),
    notes: text("notes"),
    sourceSystem: text("source_system").notNull().default("crm"),
    sourceRecordId: text("source_record_id"),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("invoices_number_uq").on(t.invoiceNumber),
    index("invoices_brand_date_idx").on(t.brandId, t.billingDate),
    index("invoices_customer_idx").on(t.customerId),
    index("invoices_status_idx").on(t.status),
    index("invoices_entity_idx").on(t.legalEntityId),
  ],
);

/** Legal snapshot of what was billed (may differ from the sale after corrections). */
export const invoiceItems = pgTable("invoice_items", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id),
  saleItemId: text("sale_item_id").references(() => saleItems.id),
  description: text("description").notNull(),
  quantity: integer("quantity").notNull(),
  unitPrice: money("unit_price").notNull(),
  lineTotal: money("line_total").notNull(),
});

/**
 * Single financial ledger. Every money movement (payment, refund, chargeback,
 * adjustment, intercompany recharge) is one row here; operational tables
 * (invoices, chargeback_cases, financial_adjustments) point at it.
 * Amounts are always positive; `type` determines the economic direction.
 * Rows are never deleted and core money fields are immutable (DB trigger).
 */
export const transactions = pgTable(
  "transactions",
  {
    id: text("id").primaryKey(), // TXN-500001
    type: transactionType("type").notNull(),
    status: transactionStatus("status").notNull(),
    brandId: text("brand_id").notNull().references(() => brands.id),
    legalEntityId: text("legal_entity_id").notNull().references(() => legalEntities.id),
    /** Counter-party entity for intercompany recharges. */
    counterpartyEntityId: text("counterparty_entity_id").references(() => legalEntities.id),
    customerId: text("customer_id").references(() => customers.id),
    invoiceId: text("invoice_id").references(() => invoices.id),
    relatedTransactionId: text("related_transaction_id"),
    chargebackCaseId: text("chargeback_case_id"),
    adjustmentId: text("adjustment_id"),
    amount: money("amount").notNull(),
    currency: text("currency").notNull(),
    paymentMethod: paymentMethod("payment_method"),
    processor: text("processor"),
    /** Tokenised processor reference — never a PAN/CVV. */
    paymentReference: text("payment_reference"),
    occurredAt: ts("occurred_at").notNull(),
    notes: text("notes"),
    sourceSystem: text("source_system").notNull().default("crm"),
    sourceRecordId: text("source_record_id"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("transactions_payment_ref_uq").on(t.paymentReference),
    index("transactions_type_date_idx").on(t.type, t.occurredAt),
    index("transactions_brand_idx").on(t.brandId),
    index("transactions_entity_idx").on(t.legalEntityId),
    index("transactions_invoice_idx").on(t.invoiceId),
    index("transactions_customer_idx").on(t.customerId),
  ],
);

/* ------------------------------------------- recharge / chargeback cases */

export const chargebackCases = pgTable(
  "chargeback_cases",
  {
    id: text("id").primaryKey(), // RCB-2026-0001
    caseType: caseType("case_type").notNull().default("chargeback"),
    origin: caseOrigin("origin").notNull().default("crm"),
    brandId: text("brand_id").notNull().references(() => brands.id),
    customerId: text("customer_id").notNull().references(() => customers.id),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id),
    originalTransactionId: text("original_transaction_id").notNull().references(() => transactions.id),
    originalLegalEntityId: text("original_legal_entity_id").notNull().references(() => legalEntities.id),
    responsibleLegalEntityId: text("responsible_legal_entity_id").notNull().references(() => legalEntities.id),
    amount: money("amount").notNull(),
    currency: text("currency").notNull(),
    reasonCode: text("reason_code").notNull(),
    notes: text("notes"),
    requestDate: ts("request_date").notNull(),
    requestedBy: text("requested_by").notNull().references(() => users.id),
    status: caseStatus("status").notNull().default("draft"),
    externalProcessorReference: text("external_processor_reference"),
    evidenceSummary: text("evidence_summary"),
    reviewedBy: text("reviewed_by").references(() => users.id),
    reviewedAt: ts("reviewed_at"),
    decidedBy: text("decided_by").references(() => users.id),
    decidedAt: ts("decided_at"),
    processedBy: text("processed_by").references(() => users.id),
    completedAt: ts("completed_at"),
    outcomeNote: text("outcome_note"),
    /** Ledger row booked when the case completes. */
    ledgerTransactionId: text("ledger_transaction_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("cb_status_idx").on(t.status),
    index("cb_brand_idx").on(t.brandId),
    index("cb_original_txn_idx").on(t.originalTransactionId),
    index("cb_requested_by_idx").on(t.requestedBy),
    index("cb_resp_entity_idx").on(t.responsibleLegalEntityId),
  ],
);

/** Append-only workflow history for each case. */
export const chargebackEvents = pgTable(
  "chargeback_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    caseId: text("case_id").notNull().references(() => chargebackCases.id),
    action: text("action").notNull(),
    fromStatus: caseStatus("from_status"),
    toStatus: caseStatus("to_status").notNull(),
    actorId: text("actor_id").notNull().references(() => users.id),
    note: text("note"),
    changes: jsonb("changes"),
    createdAt: createdAt(),
  },
  (t) => [index("cbe_case_idx").on(t.caseId)],
);

export const financialAdjustments = pgTable(
  "financial_adjustments",
  {
    id: text("id").primaryKey(), // ADJ-0001
    type: adjustmentType("type").notNull(),
    brandId: text("brand_id").notNull().references(() => brands.id),
    legalEntityId: text("legal_entity_id").notNull().references(() => legalEntities.id),
    invoiceId: text("invoice_id").references(() => invoices.id),
    customerId: text("customer_id").references(() => customers.id),
    amount: money("amount").notNull(),
    currency: text("currency").notNull(),
    reason: text("reason").notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    requestedBy: text("requested_by").notNull().references(() => users.id),
    decidedBy: text("decided_by").references(() => users.id),
    decidedAt: ts("decided_at"),
    ledgerTransactionId: text("ledger_transaction_id"),
    createdAt: createdAt(),
  },
  (t) => [index("adj_status_idx").on(t.status)],
);

export const reconciliationRecords = pgTable(
  "reconciliation_records",
  {
    id: text("id").primaryKey(), // REC-0001
    legalEntityId: text("legal_entity_id").notNull().references(() => legalEntities.id),
    brandId: text("brand_id").notNull().references(() => brands.id),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    category: text("category").notNull(), // processor_settlement | bank_deposit | chargeback_debit
    expectedAmount: money("expected_amount").notNull(),
    actualAmount: money("actual_amount").notNull(),
    currency: text("currency").notNull(),
    status: reconStatus("status").notNull(),
    transactionId: text("transaction_id").references(() => transactions.id),
    note: text("note"),
    resolvedBy: text("resolved_by").references(() => users.id),
    resolvedAt: ts("resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [index("recon_status_idx").on(t.status)],
);

/* ------------------------------------------------ collaboration & audit */

export const notes = pgTable(
  "notes",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(), // customer | sale | invoice | chargeback
    entityId: text("entity_id").notNull(),
    body: text("body").notNull(),
    /** 'internal' visible to anyone who can see the record; 'finance' restricted. */
    visibility: text("visibility").notNull().default("internal"),
    authorId: text("author_id").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("notes_entity_idx").on(t.entityType, t.entityId)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    status: taskStatus("status").notNull().default("open"),
    priority: text("priority").notNull().default("normal"),
    dueDate: ts("due_date"),
    assigneeId: text("assignee_id").notNull().references(() => users.id),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    brandId: text("brand_id").references(() => brands.id),
    createdAt: createdAt(),
  },
  (t) => [index("tasks_assignee_idx").on(t.assigneeId, t.status)],
);

/** Append-only audit trail. Never contains passwords, card data or CVV. */
export const activityLogs = pgTable(
  "activity_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorId: text("actor_id").references(() => users.id),
    action: text("action").notNull(), // customer.created, chargeback.approved, export.csv …
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    brandId: text("brand_id"),
    legalEntityId: text("legal_entity_id"),
    summary: text("summary").notNull(),
    metadata: jsonb("metadata"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [
    index("activity_entity_idx").on(t.entityType, t.entityId),
    index("activity_created_idx").on(t.createdAt),
    index("activity_actor_idx").on(t.actorId),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // approval_needed | case_update | assignment | integration | system
    title: text("title").notNull(),
    body: text("body").notNull(),
    href: text("href"),
    readAt: ts("read_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.readAt)],
);

/* ---------------------------------------------------------- integrations */

export const integrationSources = pgTable("integration_sources", {
  id: text("id").primaryKey(), // INT-LTD
  brandId: text("brand_id").notNull().references(() => brands.id).unique(),
  domain: text("domain").notNull(),
  systemName: text("system_name").notNull(),
  status: integrationStatus("status").notNull().default("demo_not_connected"),
  /** Non-secret sync configuration. Credentials live in server env vars only. */
  config: jsonb("config").notNull(),
  lastSyncAt: ts("last_sync_at"),
  importedCount: integer("imported_count").notNull().default(0),
  reviewCount: integer("review_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  updatedAt: updatedAt(),
});

export const integrationRuns = pgTable(
  "integration_runs",
  {
    id: text("id").primaryKey(), // RUN-0001
    sourceId: text("source_id").notNull().references(() => integrationSources.id),
    kind: text("kind").notNull(), // test_connection | dry_run | import
    status: runStatus("status").notNull(),
    startedAt: ts("started_at").notNull(),
    finishedAt: ts("finished_at"),
    recordsRead: integer("records_read").notNull().default(0),
    recordsImported: integer("records_imported").notNull().default(0),
    recordsFlagged: integer("records_flagged").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    errors: jsonb("errors").notNull().default(sql`'[]'::jsonb`),
    message: text("message"),
    triggeredBy: text("triggered_by").references(() => users.id),
  },
  (t) => [index("runs_source_idx").on(t.sourceId, t.startedAt)],
);

export const externalRecordMappings = pgTable(
  "external_record_mappings",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull().references(() => integrationSources.id),
    entityType: text("entity_type").notNull(),
    externalId: text("external_id").notNull(),
    internalId: text("internal_id").notNull(),
    importedAt: createdAt(),
  },
  (t) => [uniqueIndex("erm_uq").on(t.sourceId, t.entityType, t.externalId)],
);

/* ------------------------------------------------------------- settings */

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  description: text("description").notNull(),
  updatedBy: text("updated_by").references(() => users.id),
  updatedAt: updatedAt(),
});

/** Monotonic counters used to mint human-readable identifiers. */
export const idCounters = pgTable("id_counters", {
  name: text("name").primaryKey(),
  value: integer("value").notNull(),
});
