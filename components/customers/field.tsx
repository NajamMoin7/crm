import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Label + control + inline error, wired up for screen readers via `id`. */
export function Field({
  id,
  label,
  error,
  hint,
  required,
  className,
  children,
}: {
  id: string;
  label: string;
  error?: string[] | string;
  hint?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const msg = Array.isArray(error) ? error[0] : error;
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        {required && (
          <span className="text-destructive" aria-hidden>
            *
          </span>
        )}
      </Label>
      {children}
      {msg ? (
        <p id={`${id}-error`} className="text-xs text-destructive" role="alert">
          {msg}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** aria props for a control rendered inside <Field>. */
export function fieldAria(id: string, error?: string[] | string) {
  const has = Array.isArray(error) ? error.length > 0 : !!error;
  return { id, "aria-invalid": has || undefined, "aria-describedby": has ? `${id}-error` : undefined } as const;
}
