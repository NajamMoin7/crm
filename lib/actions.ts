import "server-only";
import { ZodError } from "zod";
import { AuthorizationError } from "@/lib/auth/viewer";
import type { ActionResult } from "@/lib/action-result";

export class BusinessRuleError extends Error {
  constructor(
    message: string,
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "BusinessRuleError";
  }
}

function isNextControlFlow(err: unknown) {
  return (
    !!err &&
    typeof err === "object" &&
    "digest" in err &&
    typeof (err as { digest: unknown }).digest === "string" &&
    (err as { digest: string }).digest.startsWith("NEXT_")
  );
}

/**
 * Wraps a Server Action body: converts authorization, validation and business
 * rule failures into a typed result for the form, and hides internal errors.
 */
export async function runAction<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (isNextControlFlow(err)) throw err; // redirect() / notFound()
    if (err instanceof AuthorizationError) return { ok: false, error: err.message };
    if (err instanceof BusinessRuleError) return { ok: false, error: err.message, fieldErrors: err.fieldErrors };
    if (err instanceof ZodError) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of err.issues) {
        const key = issue.path.join(".") || "form";
        (fieldErrors[key] ??= []).push(issue.message);
      }
      return { ok: false, error: "Please correct the highlighted fields.", fieldErrors };
    }
    console.error("[action] unexpected error", err);
    return { ok: false, error: "Something went wrong. No changes were saved." };
  }
}
