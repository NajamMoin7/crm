import { cn } from "@/lib/utils";

/** Bordered panel used for tables, charts and detail sections. */
export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  footer,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  footer?: React.ReactNode;
}) {
  return (
    <section className={cn("overflow-hidden rounded-xl border bg-card shadow-xs", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-base font-normal tracking-tight">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn(bodyClassName)}>{children}</div>
      {footer}
    </section>
  );
}

/** Label / value grid for detail pages. */
export function DetailList({ items, columns = 2 }: { items: { label: string; value: React.ReactNode }[]; columns?: 1 | 2 | 3 }) {
  return (
    <dl
      className={cn(
        "grid gap-x-6 gap-y-4 p-4 text-sm",
        columns === 2 && "sm:grid-cols-2",
        columns === 3 && "sm:grid-cols-2 lg:grid-cols-3",
      )}
    >
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{it.label}</dt>
          <dd className="mt-0.5 break-words">{it.value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
