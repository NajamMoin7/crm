"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RANGE_PRESETS } from "@/lib/filters";

type Option = { value: string; label: string };
export type ReportFilterField =
  | { kind: "range"; defaultValue: string }
  | { kind: "select"; param: string; label: string; options: Option[]; allLabel: string; defaultValue?: string }
  | { kind: "customer" };

const ALL = "__all__";
/** Params that identify the report itself and survive "Reset". */
const KEEP = ["report"];

/** URL-driven filter row for the report runner (like FilterBar, but Reset keeps the selected report). */
export function ReportFilters({ fields }: { fields: ReportFilterField[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [customer, setCustomer] = useState(params.get("customer") ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const go = (next: URLSearchParams) => {
    next.delete("page");
    const qs = next.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };
  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    go(next);
  };
  const active = [...params.keys()].some((k) => !KEEP.includes(k) && k !== "page");

  return (
    <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Report filters">
      {fields.map((f, i) => {
        if (f.kind === "range") {
          const range = params.get("range") ?? f.defaultValue;
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
                  <Input type="date" aria-label="From date" className="h-8 w-36" defaultValue={params.get("from") ?? ""} onChange={(e) => update({ range: "custom", from: e.target.value || null })} />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input type="date" aria-label="To date" className="h-8 w-36" defaultValue={params.get("to") ?? ""} onChange={(e) => update({ range: "custom", to: e.target.value || null })} />
                </>
              )}
            </div>
          );
        }
        if (f.kind === "customer")
          return (
            <div key={i} className="relative w-full sm:w-48">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={customer}
                onChange={(e) => {
                  const v = e.target.value;
                  setCustomer(v);
                  if (timer.current) clearTimeout(timer.current);
                  timer.current = setTimeout(() => update({ customer: v.trim().toUpperCase() || null }), 400);
                }}
                placeholder="Customer ID (CUS-…)"
                aria-label="Customer ID"
                className="h-8 pl-8"
              />
            </div>
          );
        return (
          <Select key={i} value={params.get(f.param) === "all" ? ALL : (params.get(f.param) ?? f.defaultValue ?? ALL)} onValueChange={(v) => update({ [f.param]: v === ALL ? (f.defaultValue ? "all" : null) : v })}>
            <SelectTrigger size="sm" className="h-8 min-w-36" aria-label={f.label}>
              <SelectValue placeholder={f.label} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{f.allLabel}</SelectItem>
              {f.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      })}
      {active && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setCustomer("");
            const next = new URLSearchParams();
            for (const k of KEEP) if (params.get(k)) next.set(k, params.get(k)!);
            go(next);
          }}
        >
          <X /> Reset
        </Button>
      )}
      {pending && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Updating report" />}
    </div>
  );
}
