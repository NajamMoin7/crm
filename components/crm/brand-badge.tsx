import { cn } from "@/lib/utils";

export type BrandLite = { id: string; code: string; name: string; color: string; logoUrl?: string | null };

export function BrandMark({
  brand,
  size = "sm",
}: {
  brand: Pick<BrandLite, "code" | "color" | "name" | "logoUrl">;
  size?: "sm" | "md" | "lg";
}) {
  const dims = { sm: "size-5 text-[9px] rounded-md", md: "size-7 text-[11px] rounded-lg", lg: "size-10 text-sm rounded-xl" }[size];
  if (brand.logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- small data: URL logo, no optimisation needed
      <img src={brand.logoUrl} alt="" aria-hidden title={brand.name} className={cn("shrink-0 bg-white object-contain p-0.5 ring-1 ring-border", dims)} />
    );
  }
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center font-semibold text-white shadow-sm", dims)}
      style={{ background: `var(--brand-${brand.code}, ${brand.color})` }}
      title={brand.name}
    >
      {brand.code.slice(0, 2)}
    </span>
  );
}

/** Brand identifier used throughout tables and detail pages. */
export function BrandBadge({ brand, full = false, className }: { brand: BrandLite | undefined | null; full?: boolean; className?: string }) {
  if (!brand) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      title={brand.name}
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-md border bg-background px-1.5 text-xs font-medium whitespace-nowrap",
        className,
      )}
    >
      <span aria-hidden className="size-2 rounded-full" style={{ background: `var(--brand-${brand.code}, ${brand.color})` }} />
      {full ? brand.name : brand.code}
      {!full && <span className="sr-only"> {brand.name}</span>}
    </span>
  );
}
