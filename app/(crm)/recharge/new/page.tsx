import type { Metadata } from "next";
import { format } from "date-fns";
import { PageHeader } from "@/components/crm/page-header";
import { AccessDenied } from "@/components/crm/access-denied";
import { CaseWizard } from "@/components/recharge/case-wizard";
import { can, requireViewer } from "@/lib/auth/viewer";
import { getViewerBrands } from "@/lib/data/reference";

export const metadata: Metadata = { title: "New Recharge / Chargeback" };

export default async function NewRechargePage(props: PageProps<"/recharge/new">) {
  const viewer = await requireViewer();
  if (!can(viewer, "chargebacks.create")) return <AccessDenied />;
  const sp = await props.searchParams;
  const brands = await getViewerBrands(viewer, { activeOnly: true });
  const prefill = typeof sp.txn === "string" ? sp.txn.slice(0, 80) : typeof sp.invoice === "string" ? sp.invoice.slice(0, 80) : undefined;

  return (
    <>
      <PageHeader eyebrow="New request"
        title="New Recharge / Chargeback request"
        description="Record a disputed customer payment against its original transaction. Each request keeps the original brand, customer, invoice and agent."
        breadcrumbs={[{ label: "Recharge / Chargeback", href: "/recharge" }, { label: "New request" }]}
      />
      <CaseWizard
        brands={brands}
        viewerName={viewer.name}
        today={format(new Date(), "yyyy-MM-dd")}
        prefillQuery={prefill}
      />
    </>
  );
}
