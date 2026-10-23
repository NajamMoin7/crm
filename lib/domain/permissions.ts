/**
 * Two fixed roles: Super Admin and Sales Agent.
 *
 * Permissions are the fine-grained capabilities that every page, Server Action
 * and Route Handler checks on the server. Roles are fixed bundles of them —
 * they are seeded into roles / role_permissions and cannot be edited in the UI.
 */

export const PERMISSIONS = {
  // Customers
  "customers.view": { module: "Customers", description: "View customers linked to authorised brands" },
  "customers.view_all": { module: "Customers", description: "View all customers, not only own ones" },
  "customers.create": { module: "Customers", description: "Create customers" },
  "customers.edit": { module: "Customers", description: "Edit customer details and internal notes" },
  "customers.merge": { module: "Customers", description: "Review duplicates and merge customer records", sensitive: true },
  // Sales & billing
  "sales.view": { module: "Sales", description: "View own sales" },
  "sales.view_all": { module: "Sales", description: "View all sales and company-wide figures" },
  "billing.view": { module: "Billing", description: "View billing records (own unless view_all)" },
  "billing.view_all": { module: "Billing", description: "View all billing records" },
  "billing.create": { module: "Billing", description: "Create sales & billing records" },
  "billing.manage": { module: "Billing", description: "Record payments and refunds, change invoice status", sensitive: true },
  "billing.assign_entity": { module: "Billing", description: "Choose / override the responsible legal entity", sensitive: true },
  "agents.view": { module: "Sales", description: "View sales agents and their performance" },
  "agents.manage": { module: "Sales", description: "Assign records to other agents" },
  // Recharge / chargeback
  "chargebacks.view": { module: "Recharge / Chargeback", description: "View own recharge / chargeback requests" },
  "chargebacks.view_all": { module: "Recharge / Chargeback", description: "View all recharge / chargeback cases" },
  "chargebacks.create": { module: "Recharge / Chargeback", description: "Submit recharge / chargeback requests" },
  "chargebacks.review": { module: "Recharge / Chargeback", description: "Review requests and forward / return / reject", sensitive: true },
  "chargebacks.approve": { module: "Recharge / Chargeback", description: "Approve or reject requests", sensitive: true },
  "chargebacks.process": { module: "Recharge / Chargeback", description: "Record the processing outcome", sensitive: true },
  "transactions.view": { module: "Finance", description: "See full payment references and the ledger", sensitive: true },
  // Brands, LLCs, integrations
  "brands.view": { module: "Administration", description: "View brands and configuration" },
  "brands.manage": { module: "Administration", description: "Edit brand configuration and products", sensitive: true },
  "entities.view": { module: "Administration", description: "View legal entities and brand-to-LLC mapping" },
  "entities.manage": { module: "Administration", description: "Create / edit legal entities and mappings", sensitive: true },
  "entities.all_access": { module: "Administration", description: "Records of every legal entity are in scope" },
  "integrations.view": { module: "Administration", description: "View integration status" },
  "integrations.manage": { module: "Administration", description: "Run simulated tests / dry runs, edit sync settings", sensitive: true },
  // Administration
  "users.manage": { module: "Administration", description: "Create, edit, suspend users; assign roles and brands", sensitive: true },
  "audit.view": { module: "Administration", description: "View activity logs" },
  "reports.view": { module: "Administration", description: "View company-wide reports" },
  "reports.financial": { module: "Administration", description: "View financial reports", sensitive: true },
  "reports.export": { module: "Administration", description: "Export records to CSV (audited)", sensitive: true },
  "settings.manage": { module: "Administration", description: "Change system settings & policies", sensitive: true },
} as const satisfies Record<string, { module: string; description: string; sensitive?: boolean }>;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export type RoleId = "super_admin" | "sales_agent";
export const ROLE_IDS: RoleId[] = ["super_admin", "sales_agent"];

export const ROLES: Record<RoleId, { name: string; description: string; permissions: Permission[] }> = {
  super_admin: {
    name: "Super Admin",
    description: "Full access to all three brands: customers, sales, billing, recharge approvals, brands, LLCs, users, reports, logs and settings.",
    permissions: ALL_PERMISSIONS,
  },
  sales_agent: {
    name: "Sales Agent",
    description: "Works only within assigned brands: own customers, sales, billing records and recharge / chargeback requests.",
    permissions: [
      "customers.view",
      "customers.create",
      "customers.edit",
      "sales.view",
      "billing.view",
      "billing.create",
      "chargebacks.view",
      "chargebacks.create",
      // Agents' own records may be booked to any LLC; ownership scoping still applies.
      "entities.all_access",
    ],
  },
};
