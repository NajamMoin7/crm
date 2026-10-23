"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { GitMerge, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
import { mergeDuplicateAction } from "@/app/(crm)/customers/actions";

type Side = { id: string; fullName: string; salesCount: number; invoiceCount: number; createdAt: string };

export function MergeDialog({ candidateId, a, b, suggested }: { candidateId: string; a: Side; b: Side; suggested: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [survivor, setSurvivor] = useState(suggested);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  useEffect(() => () => setOpen(false), []);
  const mergedSide = survivor === a.id ? b : a;
  const valid = reason.trim().length >= 5;

  const run = () =>
    start(async () => {
      const res = await mergeDuplicateAction(candidateId, survivor, reason.trim());
      if (res.ok) {
        toast.success(res.message ?? "Merged");
        setOpen(false);
        setReason("");
        router.refresh();
      } else toast.error(res.error);
    });

  return (
    <AlertDialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
      <AlertDialogTrigger asChild>
        <Button size="sm">
          <GitMerge /> Merge…
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Merge duplicate customers</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>Choose the record that survives. The other record is retained read-only and points to the survivor.</p>
              <ul className="list-disc space-y-0.5 pl-5 text-xs">
                <li>Sales, invoices, recharge cases, leads, notes and tasks move to the survivor.</li>
                <li>Ledger transactions are immutable and keep their original customer ID.</li>
                <li>Brand relationships and tags are combined; missing contact details are filled from the merged record.</li>
                <li>The merge is audited with a full snapshot and can&apos;t be undone from the UI.</li>
              </ul>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium">Surviving record</legend>
          <RadioGroup value={survivor} onValueChange={setSurvivor} className="gap-2">
            {[a, b].map((s) => (
              <Label
                key={s.id}
                htmlFor={`survivor-${candidateId}-${s.id}`}
                className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-primary/5"
              >
                <RadioGroupItem value={s.id} id={`survivor-${candidateId}-${s.id}`} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {s.fullName} <span className="font-mono text-xs text-muted-foreground">{s.id}</span>
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {s.salesCount} sales · {s.invoiceCount} invoices · created {s.createdAt}
                  </span>
                </span>
              </Label>
            ))}
          </RadioGroup>
        </fieldset>
        <div className="grid gap-1.5">
          <Label htmlFor={`merge-reason-${candidateId}`} className="text-xs">
            Reason (required)
          </Label>
          <Textarea
            id={`merge-reason-${candidateId}`}
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Same person — confirmed by phone; email changed after rebrand."
          />
          <p className="text-xs text-muted-foreground">
            {mergedSide.id} will be merged into {survivor}. {valid ? "" : "Minimum 5 characters."}
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || !valid}
            onClick={(e) => {
              e.preventDefault();
              run();
            }}
          >
            {pending && <Loader2 className="animate-spin" />} Merge into {survivor}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
