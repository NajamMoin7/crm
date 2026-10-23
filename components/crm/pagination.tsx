import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PAGE_SIZE, toQueryString, type RawSearchParams } from "@/lib/filters";
import { fmtNumber } from "@/lib/format";

export function Pagination({
  basePath,
  searchParams,
  page,
  total,
  pageSize = PAGE_SIZE,
}: {
  basePath: string;
  searchParams: RawSearchParams;
  page: number;
  total: number;
  pageSize?: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pages);
  const start = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const end = Math.min(total, current * pageSize);
  const href = (p: number) => `${basePath}${toQueryString(searchParams, { page: p === 1 ? null : String(p) })}`;

  return (
    <div className="flex items-center justify-between gap-3 border-t px-4 py-3 text-sm">
      <p className="text-muted-foreground tabular">
        {total === 0 ? "No results" : `Showing ${fmtNumber(start)}–${fmtNumber(end)} of ${fmtNumber(total)}`}
      </p>
      <div className="flex items-center gap-1">
        {current > 1 ? (
          <Button asChild variant="outline" size="sm">
            <Link href={href(current - 1)} scroll={false} aria-label="Previous page">
              <ChevronLeft /> Prev
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled aria-label="Previous page">
            <ChevronLeft /> Prev
          </Button>
        )}
        <span className="px-2 text-xs text-muted-foreground tabular">
          {current} / {pages}
        </span>
        {current < pages ? (
          <Button asChild variant="outline" size="sm">
            <Link href={href(current + 1)} scroll={false} aria-label="Next page">
              Next <ChevronRight />
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled aria-label="Next page">
            Next <ChevronRight />
          </Button>
        )}
      </div>
    </div>
  );
}
