"use client";

import { useId, useState } from "react";
import { BarChart3, Info, Table2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type TableSpec = {
  columns: { label: string; align?: "left" | "right" }[];
  rows: (string | number)[][];
};

/**
 * Card around a chart with a Chart / Table toggle (the table is the
 * accessible, colour-free twin of the chart) and an empty state.
 */
export function ChartCard({
  title,
  description,
  info,
  table,
  empty,
  emptyText = "No data for the selected filters.",
  className,
  children,
  footnote,
}: {
  title: string;
  description?: string;
  info?: string;
  table?: TableSpec;
  empty?: boolean;
  emptyText?: string;
  className?: string;
  children: React.ReactNode;
  footnote?: React.ReactNode;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn("flex min-w-0 flex-col rounded-xl border bg-card shadow-xs", className)}>
      <header className="flex items-start justify-between gap-2 px-4 pt-3.5 pb-2">
        <div className="min-w-0">
          <h2 id={headingId} className="flex items-center gap-1.5 text-sm font-semibold">
            {title}
            {info && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className="rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" aria-label={`About ${title}`}>
                    <Info className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-72">{info}</TooltipContent>
              </Tooltip>
            )}
          </h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {table && !empty && (
          <div className="flex shrink-0 rounded-md border p-0.5" role="group" aria-label={`${title} view`}>
            <button
              type="button"
              aria-pressed={view === "chart"}
              aria-label="Chart view"
              onClick={() => setView("chart")}
              className={cn("rounded px-1.5 py-1 text-muted-foreground", view === "chart" && "bg-accent text-foreground")}
            >
              <BarChart3 className="size-3.5" />
            </button>
            <button
              type="button"
              aria-pressed={view === "table"}
              aria-label="Table view"
              onClick={() => setView("table")}
              className={cn("rounded px-1.5 py-1 text-muted-foreground", view === "table" && "bg-accent text-foreground")}
            >
              <Table2 className="size-3.5" />
            </button>
          </div>
        )}
      </header>
      <div className="min-w-0 flex-1 px-4 pb-4">
        {empty ? (
          <div className="flex h-full min-h-40 items-center justify-center rounded-lg border border-dashed text-center text-sm text-muted-foreground">
            {emptyText}
          </div>
        ) : view === "table" && table ? (
          <div className="max-h-80 overflow-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                <tr>
                  {table.columns.map((c) => (
                    <th key={c.label} className={cn("px-2.5 py-1.5 font-medium text-muted-foreground", c.align === "right" ? "text-right" : "text-left")}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => (
                  <tr key={i} className="border-t">
                    {r.map((cell, j) => (
                      <td key={j} className={cn("px-2.5 py-1.5", table.columns[j]?.align === "right" && "text-right tabular")}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          children
        )}
        {footnote && !empty && <div className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{footnote}</div>}
      </div>
    </section>
  );
}
