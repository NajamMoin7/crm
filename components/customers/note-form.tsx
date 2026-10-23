"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { addCustomerNoteAction } from "@/app/(crm)/customers/actions";

export function NoteForm({ customerId, allowFinance }: { customerId: string; allowFinance: boolean }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"internal" | "finance">("internal");
  const [error, setError] = useState<string | undefined>();
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-2 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!body.trim()) {
          setError("Write a note.");
          return;
        }
        start(async () => {
          const res = await addCustomerNoteAction(customerId, { body, visibility });
          if (res.ok) {
            toast.success(res.message ?? "Note added");
            setBody("");
            setError(undefined);
            router.refresh();
          } else {
            setError(res.fieldErrors?.body?.[0] ?? res.error);
            toast.error(res.error);
          }
        });
      }}
    >
      <label htmlFor="note-body" className="sr-only">
        New internal note
      </label>
      <Textarea
        id="note-body"
        rows={3}
        maxLength={2000}
        placeholder="Add an internal note — visible to colleagues who can see this customer, never to the customer."
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          if (error) setError(undefined);
        }}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? "note-error" : undefined}
      />
      {error && (
        <p id="note-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {allowFinance ? (
          <Select value={visibility} onValueChange={(v) => setVisibility(v as "internal" | "finance")}>
            <SelectTrigger size="sm" className="h-8 w-48" aria-label="Note visibility">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="internal">Internal (all with access)</SelectItem>
              <SelectItem value="finance">Admin only</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <span className="text-xs text-muted-foreground">{body.length}/2000</span>
        )}
        <Button type="submit" size="sm" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />} Add note
        </Button>
      </div>
    </form>
  );
}
