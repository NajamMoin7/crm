import type { Metadata } from "next";
import { PageHeader } from "@/components/crm/page-header";
import { AccessDenied } from "@/components/crm/access-denied";
import { OrderForm, type OrderBrand, type OrderPrefill } from "@/components/billing/order-form";
import { can, requireViewer } from "@/lib/auth/viewer";
import { getActiveBrand } from "@/lib/auth/scope";
import { getAgents, getAllBrands } from "@/lib/data/reference";
import { getCustomerForViewer } from "@/lib/data/customers";

export const metadata: Metadata = { title: "New order" };

export default async function NewOrderPage(props: PageProps<"/billing/new">) {
  const viewer = await requireViewer();
  if (!can(viewer, "billing.create")) return <AccessDenied message="Your role cannot record sales." />;
  const sp = await props.searchParams;

  const brandRows = (await getAllBrands()).filter((b) => viewer.activeBrandIds.includes(b.id));
  const brandIds = brandRows.map((b) => b.id);
  const [agentRows, activeBrand] = await Promise.all([getAgents(), getActiveBrand(viewer)]);
  const brands: OrderBrand[] = brandRows.map((b) => ({
    id: b.id,
    code: b.code,
    name: b.name,
    color: b.color,
    logoUrl: b.logoUrl,
    allowedPaymentMethods: b.allowedPaymentMethods,
    defaultCurrency: b.defaultCurrency,
  }));
  const canChooseAgent = can(viewer, "agents.manage");
  const agents = canChooseAgent
    ? agentRows.filter((a) => a.status === "active" && a.brandIds.some((b) => brandIds.includes(b))).map((a) => ({ id: a.id, name: a.name, brandIds: a.brandIds }))
    : [];

  // "New order" from a customer's profile pre-fills their details.
  let prefill: OrderPrefill | undefined;
  const requested = typeof sp.customer === "string" ? sp.customer.trim().toUpperCase() : "";
  if (/^CUS-\d+$/.test(requested)) {
    const c = await getCustomerForViewer(viewer, requested);
    if (c && !c.mergedIntoId) {
      const parts = c.fullName.trim().split(/\s+/);
      prefill = {
        firstName: parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0],
        lastName: parts.length > 1 ? parts[parts.length - 1] : "",
        email: c.email ?? "",
        phone: c.phone ?? "",
        company: c.companyName ?? "",
        city: c.city ?? "",
        country: c.country ?? "United States",
        address1: c.billingAddress ?? "",
      };
    }
  }
  const requestedBrand = typeof sp.brand === "string" ? sp.brand : activeBrand;
  const initialBrandId = brandIds.includes(requestedBrand) ? requestedBrand : brandIds.length === 1 ? brandIds[0] : null;

  return (
    <>
      <PageHeader
        eyebrow="New order"
        title="Take an order"
        description="Enter the amount and the customer's details — or paste them. The invoice is created when you save and the order is recorded against your account."
        breadcrumbs={[{ label: "Billing", href: "/billing" }, { label: "New order" }]}
      />
      <OrderForm brands={brands} agents={agents} viewer={{ id: viewer.id, name: viewer.name }} canChooseAgent={canChooseAgent} initialBrandId={initialBrandId} prefill={prefill} />
    </>
  );
}
