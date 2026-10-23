"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useServerAction } from "@/components/admin/form-kit";
import { updateSettingsAction } from "@/app/(crm)/admin/actions";

export type SettingRow = {
  key: string;
  value: unknown;
  description: string;
  updatedAt: string;
  updatedByName: string | null;
  meta: { label: string; group: string; kind: "boolean" | "number" | "string"; min?: number; max?: number; unit?: string };
};

const fmt = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

export function SettingsForm({ rows }: { rows: SettingRow[] }) {
  const initial = Object.fromEntries(rows.map((r) => [r.key, r.meta.kind === "number" ? String(r.value) : r.value])) as Record<string, unknown>;
  const [v, setV] = useState(initial);
  const { run, pending, errors } = useServerAction(updateSettingsAction);
  const changed = rows.filter((r) => fmt(v[r.key]) !== fmt(initial[r.key]));
  const groups = [...new Set(rows.map((r) => r.meta.group))];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload: Record<string, unknown> = {};
    for (const r of changed) {
      const raw = v[r.key];
      payload[r.key] = r.meta.kind === "number" ? (String(raw).trim() === "" ? null : Number(raw)) : r.meta.kind === "string" ? String(raw).trim() : raw;
    }
    run(payload);
  };

  return (
    <form onSubmit={submit} noValidate className="overflow-hidden rounded-xl border bg-card shadow-xs">
      {groups.map((g) => (
        <fieldset key={g} className="border-b last:border-b-0" disabled={pending}>
          <legend className="sr-only">{g}</legend>
          <div className="bg-muted/40 px-4 py-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase" aria-hidden>
            {g}
          </div>
          <div className="divide-y">
            {rows
              .filter((r) => r.meta.group === g)
              .map((r) => {
                const id = `set-${r.key.replace(/\W/g, "-")}`;
                const err = errors[r.key]?.[0];
                const dirty = fmt(v[r.key]) !== fmt(initial[r.key]);
                return (
                  <div key={r.key} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center" data-setting={r.key}>
                    <div className="min-w-0">
                      <label htmlFor={id} className="text-sm font-medium">
                        {r.meta.label}
                        {dirty && <span className="ml-2 text-[10px] font-normal text-amber-700 dark:text-amber-400">modified</span>}
                      </label>
                      <p className="text-xs text-muted-foreground">{r.description}</p>
                      <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                        {r.key}
                        {r.updatedByName ? ` · last changed by ${r.updatedByName}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-col items-start gap-1 sm:items-end">
                      {r.meta.kind === "boolean" ? (
                        <Switch id={id} checked={v[r.key] === true} onCheckedChange={(c) => setV((p) => ({ ...p, [r.key]: c }))} />
                      ) : (
                        <div className="relative w-full sm:w-44">
                          <Input
                            id={id}
                            type={r.meta.kind === "number" ? "number" : "text"}
                            inputMode={r.meta.kind === "number" ? "numeric" : undefined}
                            min={r.meta.min}
                            max={r.meta.max}
                            value={String(v[r.key] ?? "")}
                            aria-invalid={err ? true : undefined}
                            aria-describedby={err ? `${id}-error` : undefined}
                            onChange={(e) => setV((p) => ({ ...p, [r.key]: e.target.value }))}
                            className={r.meta.unit ? "pr-16 tabular" : "tabular"}
                          />
                          {r.meta.unit && (
                            <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">{r.meta.unit}</span>
                          )}
                        </div>
                      )}
                      {err ? (
                        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
                          {err}
                        </p>
                      ) : r.meta.min !== undefined ? (
                        <p className="text-[11px] text-muted-foreground">
                          {r.meta.min}–{r.meta.max}
                        </p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
          </div>
        </fieldset>
      ))}
      <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t bg-card/95 px-4 py-2.5 backdrop-blur">
        <span className="mr-auto text-xs text-muted-foreground">{changed.length ? `${changed.length} unsaved change${changed.length > 1 ? "s" : ""}` : "All changes saved"}</span>
        <Button type="button" variant="ghost" size="sm" disabled={!changed.length || pending} onClick={() => setV(initial)}>
          Discard
        </Button>
        <Button type="submit" size="sm" disabled={!changed.length || pending}>
          {pending && <Loader2 className="animate-spin" />} Save settings
        </Button>
      </div>
    </form>
  );
}
