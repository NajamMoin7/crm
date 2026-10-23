import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BrandBadge, type BrandLite } from "@/components/crm/brand-badge";
import { VocabBadge } from "@/components/crm/status-badge";
import { EmptyState } from "@/components/crm/empty-state";
import { CASE_STATUS } from "@/lib/domain/vocab";
import { formatMoney } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import type { listCases } from "@/lib/data/chargebacks";

type Row = Awaited<ReturnType<typeof listCases>>["rows"][number];

export function CaseTable({ rows, brandMap, emptyTitle, emptyAction }: { rows: Row[]; brandMap: Map<string, BrandLite>; emptyTitle?: string; emptyAction?: React.ReactNode }) {
  if (rows.length === 0)
    return <EmptyState icon={RotateCcw} title={emptyTitle ?? "No recharge / chargeback cases"} description="Nothing matches this queue and these filters." action={emptyAction} />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Case</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead>Brand</TableHead>
          <TableHead className="hidden lg:table-cell">Original txn / invoice</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead className="hidden md:table-cell">Reason</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="hidden pr-4 lg:table-cell">Requested</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="pl-4">
              <Link href={`/recharge/${r.id}`} className="font-mono text-sm font-medium hover:underline focus-visible:underline focus-visible:outline-none">
                {r.id}
              </Link>
              <div className="text-xs text-muted-foreground">
                Chargeback
                {r.origin === "processor" ? " · processor" : ""}
              </div>
            </TableCell>
            <TableCell className="max-w-44">
              <Link href={`/customers/${r.customerId}`} className="block truncate text-sm hover:underline">
                {r.customerName}
              </Link>
              <div className="font-mono text-xs text-muted-foreground">{r.customerId}</div>
            </TableCell>
            <TableCell>
              <BrandBadge brand={brandMap.get(r.brandId)} />
            </TableCell>
            <TableCell className="hidden lg:table-cell">
              <div className="font-mono text-xs">{r.originalTransactionId}</div>
              <div className="text-xs text-muted-foreground">{r.invoiceNumber}</div>
            </TableCell>
            <TableCell className="text-sm whitespace-nowrap">
              <span className="inline-flex h-5 items-center rounded-full border border-primary/40 px-2 text-[10px] font-semibold tracking-wider text-primary uppercase">
                {r.agentName ?? "—"}
              </span>
            </TableCell>
            <TableCell className="hidden font-mono text-xs md:table-cell">{r.reasonCode}</TableCell>
            <TableCell className="text-right tabular">{formatMoney(r.amount, r.currency)}</TableCell>
            <TableCell>
              <VocabBadge map={CASE_STATUS} value={r.status} />
            </TableCell>
            <TableCell className="hidden pr-4 text-xs text-muted-foreground lg:table-cell">
              {fmtDate(r.requestDate)}
              <div>by {r.requesterName}</div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
