import type { Metadata } from "next";
import { format } from "date-fns";
import { PageHeader } from "@/components/crm/page-header";
import { AccessDenied } from "@/components/crm/access-denied";
import { CaseWizard } from "@/components/recharge/case-wizard";
import { can, requireViewer } from "@/lib/auth/viewer";
import { getCaseDetail } from "@/lib/data/chargebacks";
import { getViewerBrands } from "@/lib/data/reference";
import { evaluate } from "@/lib/domain/chargeback-workflow";
import { readPolicy } from "@/lib/services/chargebacks";
import { maskReference } from "@/lib/mask";
import { toCents } from "@/lib/money";

export const metadata: Metadata = { title: "Edit draft" };

export default async function EditCasePage(props: PageProps<"/recharge/[id]/edit">) {
  const viewer = await requireViewer();
  if (!can(viewer, "chargebacks.create")) return <AccessDenied />;
  const { id } = await props.params;
  const detail = await getCaseDetail(viewer, id);
  if (!detail) return <AccessDenied />;
  const { case: c, original, invoice, customer, balance } = detail;
  const policy = await readPolicy();
  const check = evaluate("edit", viewer, c, policy);
  if (!check.allowed || !original) return <AccessDenied message={check.reason ?? "This case cannot be edited."} />;
  const brands = await getViewerBrands(viewer, { activeOnly: true });

  return (
    <>
      <PageHeader
        title={`Edit draft ${c.id}`}
        description="Brand, case type and original transaction are fixed. Change the amount, reason, notes, references or (with permission) the responsible entity."
        breadcrumbs={[{ label: "Recharge / Chargeback", href: "/recharge" }, { label: c.id, href: `/recharge/${c.id}` }, { label: "Edit" }]}
      />
      <CaseWizard
        brands={brands}
        viewerName={viewer.name}
        today={format(new Date(), "yyyy-MM-dd")}
        initial={{
          caseId: c.id,
          brandId: c.brandId,
          caseType: c.caseType,
          responsibleLegalEntityId: c.responsibleLegalEntityId,
          amount: c.amount,
          reasonCode: c.reasonCode,
          notes: c.notes ?? "",
          requestDate: format(c.requestDate, "yyyy-MM-dd"),
          origin: c.origin,
          externalProcessorReference: c.externalProcessorReference ?? "",
          evidenceSummary: c.evidenceSummary ?? "",
          original: {
            id: original.id,
            brandId: original.brandId,
            legalEntityId: original.legalEntityId,
            customerId: customer?.id ?? c.customerId,
            customerName: customer?.fullName ?? null,
            invoiceId: invoice?.id ?? c.invoiceId,
            invoiceNumber: invoice?.invoiceNumber ?? "",
            invoiceStatus: invoice?.status ?? "paid",
            amount: original.amount,
            currency: original.currency,
            paymentMethod: original.paymentMethod,
            processor: original.processor,
            paymentReference: can(viewer, "transactions.view") ? (original.paymentReference ?? "—") : maskReference(original.paymentReference),
            occurredAt: original.occurredAt.toISOString(),
            originalCents: balance.original,
            refundedCents: balance.refunded,
            committedCents: balance.committed,
            remainingCents: balance.remaining - toCents(c.amount),
            activeCases: balance.activeCases,
          },
        }}
      />
    </>
  );
}
