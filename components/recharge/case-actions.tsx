"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban, Check, CheckCheck, CornerUpLeft, Loader2, Lock, MessageSquarePlus, Pencil, Play, Send, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { WorkflowAction } from "@/lib/domain/chargeback-workflow";
import { recordEvidenceAction, transitionAction } from "@/app/(crm)/recharge/actions";

export type ActionView = {
  action: WorkflowAction;
  label: string;
  allowed: boolean;
  reason?: string;
  noteRequired?: boolean;
  description: string;
  tone: "default" | "outline" | "destructive" | "secondary";
};

const ICONS: Partial<Record<WorkflowAction, React.ComponentType<{ className?: string }>>> = {
  submit: Send,
  forward: CheckCheck,
  approve: Check,
  return: CornerUpLeft,
  reject: XCircle,
  start_processing: Play,
  complete: CheckCheck,
  fail: X,
  cancel: Ban,
  edit: Pencil,
  note: MessageSquarePlus,
};

/** Primary first, then secondary, then destructive. */
const ORDER: WorkflowAction[] = ["submit", "forward", "approve", "start_processing", "complete", "edit", "return", "fail", "reject", "cancel"];

export function CaseActions({ caseId, actions, today }: { caseId: string; actions: ActionView[]; today: string }) {
  const router = useRouter();
  const [open, setOpen] = useState<ActionView | null>(null);
  const [note, setNote] = useState("");
  const [ref, setRef] = useState("");
  const [date, setDate] = useState(today);
  const [pending, start] = useTransition();

  const relevant = ORDER.map((a) => actions.find((x) => x.action === a)!).filter(
    (a) => a && (a.allowed || (a.reason && !a.reason.startsWith("Not possible"))),
  );
  const blockedByRole = relevant.filter((a) => !a.allowed && a.reason === "Your role does not include this permission.");
  const shown = relevant.filter((a) => !blockedByRole.includes(a));

  const run = () => {
    if (!open) return;
    start(async () => {
      const res = await transitionAction(caseId, open.action, note, open.action === "complete" ? { processorReference: ref, outcomeDate: date } : {});
      if (res.ok) {
        toast.success(res.message ?? "Done");
        setOpen(null);
        setNote("");
        setRef("");
        router.refresh();
      } else toast.error(res.error);
    });
  };

  return (
    <div className="space-y-2">
      {shown.length === 0 && <p className="text-sm text-muted-foreground">No workflow actions are available to you at this stage.</p>}
      {shown.map((a) => {
        const Icon = ICONS[a.action] ?? Check;
        if (a.action === "edit") {
          return a.allowed ? (
            <Button key={a.action} asChild variant="outline" className="w-full justify-start">
              <Link href={`/recharge/${caseId}/edit`}>
                <Icon className="size-4" /> {a.label}
              </Link>
            </Button>
          ) : null;
        }
        const btn = (
          <Button
            key={a.action}
            variant={a.allowed ? (a.tone === "destructive" ? "destructive" : a.tone === "default" ? "default" : "outline") : "outline"}
            className="w-full justify-start"
            disabled={!a.allowed}
            onClick={() => {
              setNote("");
              setOpen(a);
            }}
          >
            {a.allowed ? <Icon className="size-4" /> : <Lock className="size-4" />} {a.label}
          </Button>
        );
        return a.allowed ? (
          btn
        ) : (
          <div key={a.action} className="space-y-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block" tabIndex={0}>
                  {btn}
                </span>
              </TooltipTrigger>
              <TooltipContent>{a.reason}</TooltipContent>
            </Tooltip>
            <p className="px-1 text-xs text-muted-foreground">{a.reason}</p>
          </div>
        );
      })}

      <Dialog open={!!open} onOpenChange={(o) => !pending && !o && setOpen(null)}>
        <DialogContent>
          {open && (
            <>
              <DialogHeader>
                <DialogTitle>{open.label}</DialogTitle>
                <DialogDescription>{open.description}</DialogDescription>
              </DialogHeader>
              <div className="grid gap-4">
                {open.action === "complete" && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="proc-ref">Processor reference (optional)</Label>
                      <Input id="proc-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="dp_…, case #" />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="outcome-date">Outcome date</Label>
                      <Input id="outcome-date" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
                    </div>
                    <p className="text-xs text-muted-foreground sm:col-span-2">
                      Demo — simulated. Recording completion books a ledger entry; no processor is contacted.
                    </p>
                  </div>
                )}
                <div className="grid gap-1.5">
                  <Label htmlFor="wf-note">
                    Note {open.noteRequired ? <span className="text-destructive">(required)</span> : <span className="text-muted-foreground">(optional)</span>}
                  </Label>
                  <Textarea id="wf-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(null)} disabled={pending}>
                  Cancel
                </Button>
                <Button
                  variant={open.tone === "destructive" ? "destructive" : "default"}
                  onClick={run}
                  disabled={pending || (open.noteRequired && note.trim().length < 3)}
                >
                  {pending && <Loader2 className="animate-spin" />} {open.label}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function AddCaseNote({ caseId }: { caseId: string }) {
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (note.trim().length < 3) return;
        start(async () => {
          const res = await transitionAction(caseId, "note", note);
          if (res.ok) {
            toast.success("Note added");
            setNote("");
            router.refresh();
          } else toast.error(res.error);
        });
      }}
    >
      <Label htmlFor="case-note" className="sr-only">
        Internal note
      </Label>
      <Textarea id="case-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add an internal note…" maxLength={2000} />
      <Button type="submit" size="sm" variant="outline" disabled={pending || note.trim().length < 3} className="justify-self-end">
        {pending ? <Loader2 className="animate-spin" /> : <MessageSquarePlus />} Add note
      </Button>
    </form>
  );
}

export function EvidenceForm({ caseId, externalRef, evidence }: { caseId: string; externalRef: string; evidence: string }) {
  const [ref, setRef] = useState(externalRef);
  const [ev, setEv] = useState(evidence);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await recordEvidenceAction(caseId, { externalProcessorReference: ref, evidenceSummary: ev });
          if (res.ok) {
            toast.success(res.message ?? "Saved");
            router.refresh();
          } else toast.error(res.error);
        });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="ev-ref">External case reference</Label>
        <Input id="ev-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="dp_… / bank case #" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="ev-sum">Evidence summary</Label>
        <Textarea id="ev-sum" rows={2} value={ev} onChange={(e) => setEv(e.target.value)} maxLength={2000} />
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={pending} className="justify-self-end">
        {pending && <Loader2 className="animate-spin" />} Save evidence
      </Button>
    </form>
  );
}
