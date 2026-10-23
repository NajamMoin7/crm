"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RANGE_PRESETS } from "@/lib/filters";
import { cn } from "@/lib/utils";

export type FilterField =
  | { kind: "search"; placeholder?: string }
  | { kind: "select"; param: string; label: string; options: { value: string; label: string }[]; allLabel?: string }
  | { kind: "range"; defaultValue?: string };

const ALL = "__all__";

/**
 * URL-driven filter row. Every change rewrites the query string (resetting
 * pagination), so filters are shareable, survive reloads and are re-validated
 * on the server.
 */
export function FilterBar({ fields, className }: { fields: FilterField[]; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(params.get("q") ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "" || v === ALL) next.delete(k);
      else next.set(k, v);
    }
    next.delete("page");
    const qs = next.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onSearch = (value: string) => {
    setQ(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => update({ q: value.trim() || null }), 300);
  };

  const rangeField = fields.find((f) => f.kind === "range") as Extract<FilterField, { kind: "range" }> | undefined;
  const range = params.get("range") ?? rangeField?.defaultValue ?? "all";
  const active = [...params.keys()].filter((k) => k !== "page").length > 0;

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)} role="search">
      {fields.map((f, i) => {
        if (f.kind === "search")
          return (
            <div key={i} className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={q}
                onChange={(e) => onSearch(e.target.value)}
                placeholder={f.placeholder ?? "Search…"}
                aria-label={f.placeholder ?? "Search"}
                className="h-8 pl-8"
              />
            </div>
          );
        if (f.kind === "select")
          return (
            <Select key={i} value={params.get(f.param) ?? ALL} onValueChange={(v) => update({ [f.param]: v })}>
              <SelectTrigger size="sm" className="h-8 min-w-36" aria-label={f.label}>
                <SelectValue placeholder={f.label} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{f.allLabel ?? `All ${f.label.toLowerCase()}`}</SelectItem>
                {f.options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          );
        return (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Select value={range} onValueChange={(v) => update({ range: v, ...(v !== "custom" ? { from: null, to: null } : {}) })}>
              <SelectTrigger size="sm" className="h-8 min-w-36" aria-label="Date range">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGE_PRESETS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {range === "custom" && (
              <>
                <Input
                  type="date"
                  aria-label="From date"
                  className="h-8 w-36"
                  defaultValue={params.get("from") ?? ""}
                  onChange={(e) => update({ range: "custom", from: e.target.value || null })}
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  type="date"
                  aria-label="To date"
                  className="h-8 w-36"
                  defaultValue={params.get("to") ?? ""}
                  onChange={(e) => update({ range: "custom", to: e.target.value || null })}
                />
              </>
            )}
          </div>
        );
      })}
      {active && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setQ("");
            startTransition(() => router.replace(pathname, { scroll: false }));
          }}
        >
          <X /> Reset
        </Button>
      )}
      {pending && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Updating results" />}
    </div>
  );
}
