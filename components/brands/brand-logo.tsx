import { cn } from "@/lib/utils";

/** Brand logo mark rendered from the configured colour + logo text (reflects live configuration). */
export function BrandLogo({
  color,
  text,
  name,
  size = "md",
  className,
}: {
  color: string;
  text: string;
  name: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const dims = { sm: "size-6 text-[10px] rounded-md", md: "size-9 text-xs rounded-lg", lg: "size-12 text-sm rounded-xl" }[size];
  return (
    <span
      role="img"
      aria-label={`${name} logo`}
      className={cn("inline-flex shrink-0 items-center justify-center font-semibold tracking-tight text-white shadow-sm ring-1 ring-black/5", dims, className)}
      style={{ background: color }}
    >
      {text || "?"}
    </span>
  );
}
