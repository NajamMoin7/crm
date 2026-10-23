import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowUpRight, Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Compact stat tile. Clicking opens the underlying, identically-filtered records. */
export function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  href,
  definition,
  tone,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  icon?: LucideIcon;
  href?: string;
  definition?: string;
  tone?: "default" | "danger" | "warning";
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
          {Icon && <Icon className="size-3.5" aria-hidden />}
          {label}
        </span>
        {href && (
          <ArrowUpRight className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
        )}
      </div>
      <div
        className={cn(
          "mt-2 font-heading text-2xl font-normal tracking-tight",
          tone === "danger" && "text-red-600 dark:text-red-400",
          tone === "warning" && "text-amber-700 dark:text-amber-400",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </>
  );
  const cls =
    "group relative block rounded-xl border bg-card p-4 shadow-xs transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
  return (
    <div className="relative">
      {href ? (
        <Link href={href} className={cn(cls, "hover:border-foreground/20 hover:bg-accent/30")}>
          {body}
        </Link>
      ) : (
        <div className={cls}>{body}</div>
      )}
      {definition && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="absolute right-9 top-3.5 rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Definition of ${label}`}
            >
              <Info className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{definition}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
