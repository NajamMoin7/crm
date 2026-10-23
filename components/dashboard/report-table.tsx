import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BrandBadge, type BrandLite } from "@/components/crm/brand-badge";
import type { Cell, ReportColumn, ReportRow, ReportSummary } from "@/lib/data/reports";
import { formatCents } from "@/lib/money";
import { fmtDate, fmtDateTime, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const NUMERIC = new Set(["money", "number", "percent"]);

export function formatCell(col: Pick<ReportColumn, "kind" | "vocab">, v: Cell | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  if (col.vocab) return col.vocab[String(v)]?.label ?? String(v);
  switch (col.kind) {
    case "money":
      return formatCents(Number(v));
    case "number":
      return fmtNumber(Number(v));
    case "percent":
      return `${(Number(v) * 100).toFixed(1)}%`;
    case "date":
      return fmtDate(v as Date | string);
    case "datetime":
      return fmtDateTime(v as Date | string);
    default:
      return String(v);
  }
}

export function ReportSummaryRow({ items }: { items: ReportSummary[] }) {
  if (!items.length) return null;
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border shadow-xs sm:grid-cols-3 lg:grid-cols-5">
      {items.map((s) => (
        <div key={s.label} className="bg-card px-4 py-3">
          <dt className="text-xs text-muted-foreground">{s.label}</dt>
          <dd className="mt-1 text-lg font-semibold tracking-tight">{typeof s.value === "number" ? formatCell({ kind: s.kind ?? "number" }, s.value) : s.value}</dd>
          {s.hint && <dd className="text-[11px] text-muted-foreground">{s.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

export function ReportTable({ columns, rows, brandMap }: { columns: ReportColumn[]; rows: ReportRow[]; brandMap: Map<string, BrandLite> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((c, i) => (
            <TableHead
              key={c.key}
              className={cn(NUMERIC.has(c.kind ?? "") && "text-right", c.secondary && "hidden md:table-cell", i === 0 && "pl-4", i === columns.length - 1 && "pr-4")}
            >
              {c.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, ri) => (
          <TableRow key={ri}>
            {columns.map((c, i) => {
              const v = r[c.key];
              let content: React.ReactNode = formatCell(c, v);
              if (c.kind === "brand" && v) content = <BrandBadge brand={brandMap.get(String(v))} />;
              else if (c.href && v !== null && v !== undefined) {
                const target = r[c.href.key ?? c.key];
                if (target) content = <Link href={`${c.href.prefix}${encodeURIComponent(String(target))}`} className="font-medium hover:underline">{content}</Link>;
              }
              return (
                <TableCell
                  key={c.key}
                  className={cn(
                    "text-sm",
                    NUMERIC.has(c.kind ?? "") && "text-right tabular",
                    c.kind === "id" && "font-mono text-xs",
                    c.secondary && "hidden md:table-cell",
                    i === 0 && "pl-4",
                    i === columns.length - 1 && "pr-4",
                  )}
                >
                  {content}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
