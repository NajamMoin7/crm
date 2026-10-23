import Link from "next/link";
import { ChevronRight } from "lucide-react";

/** Page title block: small gold eyebrow, serif title, short description and a thin gold rule. */
export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  breadcrumbs,
  meta,
}: {
  title: React.ReactNode;
  eyebrow?: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
  meta?: React.ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-col gap-3">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {breadcrumbs.map((b, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-3" aria-hidden />}
              {b.href ? (
                <Link href={b.href} className="hover:text-primary">
                  {b.label}
                </Link>
              ) : (
                <span className="text-foreground">{b.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-2">
          {eyebrow && <p className="eyebrow text-primary">{eyebrow}</p>}
          <h1 className="text-3xl font-normal tracking-tight text-balance sm:text-4xl">{title}</h1>
          {description && <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground sm:text-[15px]">{description}</p>}
          {meta && <div className="flex flex-wrap items-center gap-2 pt-1">{meta}</div>}
          <div aria-hidden className="h-px w-16 bg-gradient-to-r from-primary to-transparent pt-px" />
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
