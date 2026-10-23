"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/action-result";

export type FieldErrors = Record<string, string[] | undefined>;

/**
 * Runs a Server Action from a client form: tracks pending state, maps
 * field errors for inline display and toasts the outcome. The action itself
 * calls refresh(), so the page re-renders with fresh server data.
 */
export function useServerAction<A extends unknown[], T>(
  action: (...args: A) => Promise<ActionResult<T>>,
  opts: { onSuccess?: (res: Extract<ActionResult<T>, { ok: true }>) => void; successToast?: boolean } = {},
) {
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<FieldErrors>({});
  const run = (...args: A) =>
    new Promise<boolean>((resolve) =>
      start(async () => {
        try {
          const res = await action(...args);
          if (res.ok) {
            setErrors({});
            if (opts.successToast !== false) toast.success(res.message ?? "Saved");
            opts.onSuccess?.(res);
            resolve(true);
          } else {
            setErrors(res.fieldErrors ?? {});
            toast.error(res.error);
            resolve(false);
          }
        } catch {
          toast.error("Could not reach the server. Check your connection and try again.");
          resolve(false);
        }
      }),
    );
  return { run, pending, errors, setErrors };
}

/** Label + control + hint + inline error, wired for screen readers. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
  required,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: string[] | string;
  children: React.ReactNode;
  className?: string;
  required?: boolean;
}) {
  const msg = Array.isArray(error) ? error[0] : error;
  return (
    <div className={cn("grid content-start gap-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-xs font-medium">
        {label}
        {required && (
          <span aria-hidden className="text-destructive">
            *
          </span>
        )}
      </Label>
      {children}
      {msg ? (
        <p id={htmlFor ? `${htmlFor}-error` : undefined} role="alert" className="text-xs text-destructive">
          {msg}
        </p>
      ) : hint ? (
        <p id={htmlFor ? `${htmlFor}-hint` : undefined} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** aria props for an input with a possible error. */
export function invalid(id: string, error?: string[] | string) {
  const has = Array.isArray(error) ? error.length > 0 : !!error;
  return { id, "aria-invalid": has || undefined, "aria-describedby": has ? `${id}-error` : `${id}-hint` };
}

/** Accessible group of checkboxes for multi-select of a small set. */
export function CheckboxGroup({
  legend,
  options,
  value,
  onChange,
  error,
  hint,
  columns = 2,
  disabled,
}: {
  legend: React.ReactNode;
  options: { value: string; label: React.ReactNode; description?: React.ReactNode; disabled?: boolean }[];
  value: string[];
  onChange: (next: string[]) => void;
  error?: string[];
  hint?: React.ReactNode;
  columns?: 1 | 2 | 3;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <fieldset className="grid gap-1.5" aria-describedby={error?.length ? `${id}-err` : undefined} aria-invalid={error?.length ? true : undefined}>
      <legend className="mb-1.5 text-xs font-medium">{legend}</legend>
      <div className={cn("grid gap-1.5", columns === 2 && "sm:grid-cols-2", columns === 3 && "sm:grid-cols-3")}>
        {options.map((o) => {
          const cid = `${id}-${o.value}`;
          const checked = value.includes(o.value);
          return (
            <label
              key={o.value}
              htmlFor={cid}
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-sm transition-colors hover:bg-accent/40",
                checked && "border-primary/40 bg-primary/5",
                (disabled || o.disabled) && "cursor-not-allowed opacity-60",
              )}
            >
              <Checkbox
                id={cid}
                className="mt-0.5"
                checked={checked}
                disabled={disabled || o.disabled}
                onCheckedChange={(c) => onChange(c ? [...value, o.value] : value.filter((v) => v !== o.value))}
              />
              <span className="min-w-0">
                <span className="block leading-tight">{o.label}</span>
                {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
              </span>
            </label>
          );
        })}
      </div>
      {error?.length ? (
        <p id={`${id}-err`} role="alert" className="text-xs text-destructive">
          {error[0]}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </fieldset>
  );
}

/**
 * Next 16 keeps recently visited routes mounted but hidden (React <Activity>).
 * Effects are cleaned up when a route is hidden, so transient UI (dialogs)
 * closes instead of re-appearing when the user navigates back.
 */
export function useCloseOnHide(close: () => void) {
  const ref = useRef(close);
  useEffect(() => {
    ref.current = close;
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Deferred so Strict Mode's mount → cleanup → mount in dev does not close a freshly opened dialog.
    if (timer.current) clearTimeout(timer.current);
    return () => {
      timer.current = setTimeout(() => ref.current(), 0);
    };
  }, []);
}
