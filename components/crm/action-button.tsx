"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/action-result";

type Props = {
  action: (note: string) => Promise<ActionResult<unknown>>;
  label: React.ReactNode;
  confirmTitle: string;
  confirmDescription: React.ReactNode;
  confirmLabel?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  /** Ask for a note (required when `noteRequired`). */
  withNote?: boolean;
  noteRequired?: boolean;
  noteLabel?: string;
  destructive?: boolean;
  disabled?: boolean;
};

/** A button that confirms, runs a Server Action, toasts the outcome and refreshes. */
export function ActionButton({
  action,
  label,
  confirmTitle,
  confirmDescription,
  confirmLabel = "Confirm",
  variant = "default",
  size = "sm",
  withNote,
  noteRequired,
  noteLabel = "Note",
  destructive,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  const run = () =>
    start(async () => {
      const res = await action(note.trim());
      if (res.ok) {
        toast.success(res.message ?? "Saved");
        setOpen(false);
        setNote("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });

  return (
    <AlertDialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size={size} disabled={disabled}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{confirmDescription}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {withNote && (
          <div className="grid gap-1.5">
            <Label htmlFor="action-note">
              {noteLabel}
              {noteRequired ? " (required)" : " (optional)"}
            </Label>
            <Textarea id="action-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={pending || (noteRequired && !note.trim())}
            onClick={(e) => {
              e.preventDefault();
              run();
            }}
          >
            {pending && <Loader2 className="animate-spin" />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
