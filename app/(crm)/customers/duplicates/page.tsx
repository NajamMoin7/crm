import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, GitMerge, XCircle } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/crm/page-header";
import { SectionCard } from "@/components/crm/section-card";
import { EmptyState } from "@/components/crm/empty-state";
import { BrandBadge, type BrandLite } from "@/components/crm/brand-badge";
import { StatusBadge } from "@/components/crm/status-badge";
import { ActionButton } from "@/components/crm/action-button";
import { AccessDenied } from "@/components/crm/access-denied";
import { MergeDialog } from "@/components/customers/merge-dialog";
import { can, requireViewer } from "@/lib/auth/viewer";
import { listDuplicateCandidates } from "@/lib/data/customers";
import { getBrandMap, getUserNames } from "@/lib/data/reference";
import { dismissDuplicateAction } from "../actions";
import { fmtDate, fmtDateTime, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Duplicate Review" };

type Pair = Awaited<ReturnType<typeof listDuplicateCandidates>>[number];
type Cust = Pair["a"];

export default async function DuplicatesPage(props: PageProps<"/customers/duplicates">) {
  const viewer = await requireViewer();
  if (!can(viewer, "customers.merge")) return <AccessDenied />;
  const sp = await props.searchParams;
  const view = sp.view === "resolved" ? "resolved" : "open";
  const [open, merged, dismissed, brandMap, names] = await Promise.all([
    listDuplicateCandidates(viewer, "open"),
    listDuplicateCandidates(viewer, "merged"),
    listDuplicateCandidates(viewer, "dismissed"),
    getBrandMap(),
    getUserNames(),
  ]);
  const resolved = [...merged, ...dismissed].sort((x, y) => (y.reviewedAt?.getTime() ?? 0) - (x.reviewedAt?.getTime() ?? 0));

  return (
    <>
      <PageHeader eyebrow="Customers"
        breadcrumbs={[{ label: "All Customers", href: "/customers" }, { label: "Duplicate review" }]}
        title="Duplicate Review"
        description="Possible duplicate customers detected by the system, imports or agents. Records are never merged automatically — a reviewer decides."
      />
      <nav aria-label="Review status" className="mb-4 inline-flex rounded-lg bg-muted p-0.5">
        {[
          { v: "open", label: `Open (${open.length})`, href: "/customers/duplicates" },
          { v: "resolved", label: `Resolved (${resolved.length})`, href: "/customers/duplicates?view=resolved" },
        ].map((t) => (
          <Link
            key={t.v}
            href={t.href}
            aria-current={view === t.v ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              view === t.v && "bg-background text-foreground shadow-sm",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {view === "open" ? (
        open.length === 0 ? (
          <SectionCard>
            <EmptyState icon={CheckCircle2} title="No open duplicate candidates" description="New candidates appear when an import or agent flags a possible match." />
          </SectionCard>
        ) : (
          <div className="space-y-4">
            {open.map((p) => (
              <PairCard key={p.id} pair={p} brandMap={brandMap} />
            ))}
          </div>
        )
      ) : resolved.length === 0 ? (
        <SectionCard>
          <EmptyState icon={GitMerge} title="Nothing resolved yet" />
        </SectionCard>
      ) : (
        <SectionCard title="Resolved candidates" description="Merged and dismissed pairs, newest first">
          <div className="relative overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Pair</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="hidden md:table-cell">Reviewed by</TableHead>
                  <TableHead className="hidden lg:table-cell">Note</TableHead>
                  <TableHead className="hidden pr-4 sm:table-cell">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resolved.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="pl-4">
                      <div className="flex flex-wrap items-center gap-1 text-sm">
                        <Link href={`/customers/${p.a.id}`} className="hover:underline">
                          {p.a.fullName}
                        </Link>
                        <span className="text-muted-foreground">↔</span>
                        <Link href={`/customers/${p.b.id}`} className="hover:underline">
                          {p.b.fullName}
                        </Link>
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {p.id} · {p.a.id} / {p.b.id}
                      </div>
                    </TableCell>
                    <TableCell>
                      {p.status === "merged" ? (
                        <StatusBadge tone="violet" label={`Merged → ${p.a.mergedIntoId ? p.b.id : p.a.id}`} />
                      ) : (
                        <StatusBadge tone="neutral" label="Not a duplicate" />
                      )}
                    </TableCell>
                    <TableCell className="hidden text-sm md:table-cell">{p.reviewedBy ? (names.get(p.reviewedBy) ?? p.reviewedBy) : "—"}</TableCell>
                    <TableCell className="hidden max-w-72 truncate text-sm text-muted-foreground lg:table-cell" title={p.resolutionNote ?? undefined}>
                      {p.resolutionNote ?? "—"}
                    </TableCell>
                    <TableCell className="hidden pr-4 text-sm text-muted-foreground sm:table-cell">{fmtDateTime(p.reviewedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      )}
    </>
  );
}

function PairCard({ pair: p, brandMap }: { pair: Pair; brandMap: Map<string, BrandLite> }) {
  // Suggest the record with more history (sales + invoices), then the older one.
  const weight = (c: Cust) => c.salesCount + c.invoiceCount;
  const suggested = weight(p.a) !== weight(p.b) ? (weight(p.a) > weight(p.b) ? p.a.id : p.b.id) : p.a.createdAt <= p.b.createdAt ? p.a.id : p.b.id;
  const rows: { label: string; get: (c: Cust) => React.ReactNode; cmp?: (c: Cust) => string }[] = [
    { label: "Name", get: (c) => c.fullName, cmp: (c) => c.fullName.toLowerCase() },
    { label: "Email", get: (c) => c.email ?? "—", cmp: (c) => (c.email ?? "").toLowerCase() },
    { label: "Phone", get: (c) => c.phone ?? "—", cmp: (c) => (c.phone ?? "").replace(/\D/g, "").slice(-10) },
    { label: "Company", get: (c) => c.companyName ?? "—", cmp: (c) => (c.companyName ?? "").toLowerCase() },
    { label: "Location", get: (c) => [c.city, c.country].filter(Boolean).join(", ") || "—" },
    {
      label: "Brands",
      get: (c) => (
        <span className="flex flex-wrap gap-1">
          {(c.brandIds ?? []).map((b) => (
            <BrandBadge key={b} brand={brandMap.get(b)} />
          ))}
        </span>
      ),
    },
    { label: "Created", get: (c) => fmtDate(c.createdAt) },
    { label: "Source", get: (c) => c.acquisitionSource },
    { label: "Sales / invoices", get: (c) => `${fmtNumber(c.salesCount)} / ${fmtNumber(c.invoiceCount)}` },
  ];
  const tone = p.score >= 85 ? "danger" : p.score >= 70 ? "warning" : "info";

  return (
    <section aria-labelledby={`dup-${p.id}`} className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 id={`dup-${p.id}`} className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {p.a.fullName} <span className="text-muted-foreground">↔</span> {p.b.fullName}
            <StatusBadge tone={tone} label={`Score ${p.score}`} />
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <span className="font-mono">{p.id}</span> · {p.matchReasons.join(" · ")} · detected by {p.detectedBy} on {fmtDate(p.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton
            action={dismissDuplicateAction.bind(null, p.id)}
            label={
              <>
                <XCircle /> Not a duplicate
              </>
            }
            variant="outline"
            confirmTitle="Mark as different customers?"
            confirmDescription={`${p.a.id} and ${p.b.id} will stay separate and this pair is closed. Your note is kept in the audit log.`}
            confirmLabel="Mark as different"
            withNote
            noteRequired
            noteLabel="Why are these different customers?"
          />
          <MergeDialog
            candidateId={p.id}
            suggested={suggested}
            a={{ id: p.a.id, fullName: p.a.fullName, salesCount: p.a.salesCount, invoiceCount: p.a.invoiceCount, createdAt: fmtDate(p.a.createdAt) }}
            b={{ id: p.b.id, fullName: p.b.fullName, salesCount: p.b.salesCount, invoiceCount: p.b.invoiceCount, createdAt: fmtDate(p.b.createdAt) }}
          />
        </div>
      </header>
      <div className="relative overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground">
              <th scope="col" className="w-32 px-4 py-2 font-medium">
                Field
              </th>
              {[p.a, p.b].map((c) => (
                <th key={c.id} scope="col" className="px-4 py-2 font-medium">
                  <Link href={`/customers/${c.id}`} className="font-mono text-foreground hover:underline">
                    {c.id}
                  </Link>
                  {c.id === suggested && <span className="ml-2 text-[11px] font-normal text-emerald-700 dark:text-emerald-400">suggested survivor</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const same = r.cmp && r.cmp(p.a) && r.cmp(p.a) === r.cmp(p.b);
              return (
                <tr key={r.label} className="border-b last:border-0">
                  <th scope="row" className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">
                    {r.label}
                  </th>
                  {[p.a, p.b].map((c) => (
                    <td key={c.id} className={cn("px-4 py-2 break-words", same && "bg-amber-500/8 font-medium")}>
                      {r.get(c)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
