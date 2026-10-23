"use client";

import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Banknote, Loader2, ShieldCheck, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { issueRefundAction, recordPaymentAction } from "@/app/(crm)/billing/actions";
import { PAYMENT_METHOD } from "@/lib/domain/vocab";
import { formatCents } from "@/lib/money";
import { centsToInput, parseMoneyInput, referenceError } from "./math";
import type { PaymentInput } from "./schema";

/** Shows the "created" toast once after the wizard redirects here, then cleans the URL. */
export function CreatedToast({ invoiceNumber }: { invoiceNumber: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const shown = useRef(false);
  useEffect(() => {
    if (params.get("created") === "1" && !shown.current) {
      shown.current = true;
      toast.success(`Billing record ${invoiceNumber} created`, { description: "Sale, invoice and any simulated payment were saved together." });
      router.replace(pathname, { scroll: false });
    }
  }, [params, router, pathname, invoiceNumber]);
  return null;
}

type Errors = Record<string, string>;

function FieldError({ id, error }: { id: string; error?: string }) {
  return error ? (
    <p id={`${id}-error`} className="text-xs text-destructive" role="alert">
      {error}
    </p>
  ) : null;
}

export function RecordPaymentDialog({
  invoiceId,
  balance,
  currency,
  methods,
  defaultMethod,
  today,
  minDate,
}: {
  invoiceId: string;
  balance: number;
  currency: string;
  methods: string[];
  defaultMethod: string;
  today: string;
  minDate: string;
}) {
  const [open, setOpen] = useState(false);
  // Close transient dialogs when the route is hidden by Activity.
  useLayoutEffect(() => () => setOpen(false), []);
  const [amount, setAmount] = useState(centsToInput(balance));
  const [method, setMethod] = useState(methods.includes(defaultMethod) ? defaultMethod : (methods[0] ?? "other"));
  const [reference, setReference] = useState("");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [pending, start] = useTransition();
  const router = useRouter();

  const submit = () => {
    const e: Errors = {};
    const cents = parseMoneyInput(amount);
    if (cents === null || cents <= 0) e.amount = "Enter an amount greater than zero.";
    else if (cents > balance) e.amount = `Cannot exceed the balance due (${formatCents(balance, currency)}).`;
    const refErr = referenceError(reference);
    if (refErr) e.reference = refErr;
    if (!date) e.date = "Enter the payment date.";
    else if (date > today) e.date = "Payment date cannot be in the future.";
    else if (date < minDate) e.date = "Payment date cannot be before the billing date.";
    setErrors(e);
    if (Object.keys(e).length) return;
    start(async () => {
      const res = await recordPaymentAction(invoiceId, {
        amount: centsToInput(cents!),
        method: method as PaymentInput["method"],
        reference: reference.trim(),
        date,
        note,
      });
      if (res.ok) {
        toast.success(res.message ?? "Payment recorded.");
        setOpen(false);
        setReference("");
        setNote("");
        router.refresh();
      } else {
        const fe: Errors = {};
        for (const [k, v] of Object.entries(res.fieldErrors ?? {})) if (v?.length) fe[k] = v[0];
        setErrors(fe);
        toast.error(res.error);
      }
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (pending) return;
        setOpen(o);
        if (o) {
          setAmount(centsToInput(balance));
          setErrors({});
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Banknote /> Record payment
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          <DialogDescription>Balance due {formatCents(balance, currency)}. A payment ledger row is appended; existing rows are never edited.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="pay-amount">Amount ({currency})</Label>
              <Input id="pay-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="tabular" aria-invalid={!!errors.amount} aria-describedby={errors.amount ? "pay-amount-error" : undefined} />
              <FieldError id="pay-amount" error={errors.amount} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pay-date">Payment date</Label>
              <Input id="pay-date" type="date" min={minDate} max={today} value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={!!errors.date} aria-describedby={errors.date ? "pay-date-error" : undefined} />
              <FieldError id="pay-date" error={errors.date} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pay-method">Method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger id="pay-method" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {methods.map((m) => (
                  <SelectItem key={m} value={m}>
                    {PAYMENT_METHOD[m] ?? m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pay-reference">Payment reference (tokenised)</Label>
            <Input id="pay-reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="pi_…" autoComplete="off" spellCheck={false} className="font-mono" aria-invalid={!!errors.reference} aria-describedby={errors.reference ? "pay-reference-error" : "pay-reference-hint"} />
            {errors.reference ? (
              <FieldError id="pay-reference" error={errors.reference} />
            ) : (
              <p id="pay-reference-hint" className="text-xs text-muted-foreground">
                Processor token only — never a card number or CVV.
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pay-note">
              Note <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea id="pay-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />
          </div>
          <p className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Simulated — no real payment is initiated and no processor is contacted.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Record payment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type RefundablePayment = { id: string; amount: number; refundable: number; reference: string; occurredAt: string };

export function RefundDialog({ invoiceId, currency, payments, paid }: { invoiceId: string; currency: string; payments: RefundablePayment[]; paid: number }) {
  const [open, setOpen] = useState(false);
  // Close transient dialogs when the route is hidden by Activity.
  useLayoutEffect(() => () => setOpen(false), []);
  const usable = payments.filter((p) => p.refundable > 0);
  const [paymentId, setPaymentId] = useState(usable[0]?.id ?? "");
  const selected = usable.find((p) => p.id === paymentId);
  const max = Math.min(paid, selected?.refundable ?? 0);
  const [amount, setAmount] = useState(centsToInput(max));
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [pending, start] = useTransition();
  const router = useRouter();

  const submit = () => {
    const e: Errors = {};
    const cents = parseMoneyInput(amount);
    if (!selected) e.paymentId = "Select the payment to refund.";
    if (cents === null || cents <= 0) e.amount = "Enter an amount greater than zero.";
    else if (cents > max) e.amount = `Cannot exceed ${formatCents(max, currency)} refundable on this payment.`;
    if (reason.trim().length < 3) e.reason = "Give a reason for the refund.";
    setErrors(e);
    if (Object.keys(e).length) return;
    start(async () => {
      const res = await issueRefundAction(invoiceId, { paymentId, amount: centsToInput(cents!), reason: reason.trim() });
      if (res.ok) {
        toast.success(res.message ?? "Refund issued.");
        setOpen(false);
        setReason("");
        router.refresh();
      } else {
        const fe: Errors = {};
        for (const [k, v] of Object.entries(res.fieldErrors ?? {})) if (v?.length) fe[k] = v[0];
        setErrors(fe);
        toast.error(res.error);
      }
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (pending) return;
        setOpen(o);
        if (o) {
          const first = usable[0];
          setPaymentId(first?.id ?? "");
          setAmount(centsToInput(Math.min(paid, first?.refundable ?? 0)));
          setErrors({});
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={!usable.length}>
          <Undo2 /> Issue refund
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Issue refund</DialogTitle>
          <DialogDescription>
            Appends a refund ledger row linked to the original payment and reduces the amount paid. The original payment is never modified.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="refund-payment">Original payment</Label>
            <Select
              value={paymentId}
              onValueChange={(v) => {
                setPaymentId(v);
                const p = usable.find((x) => x.id === v);
                setAmount(centsToInput(Math.min(paid, p?.refundable ?? 0)));
              }}
            >
              <SelectTrigger id="refund-payment" className="w-full" aria-invalid={!!errors.paymentId}>
                <SelectValue placeholder="Select payment" />
              </SelectTrigger>
              <SelectContent>
                {usable.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.id} · {formatCents(p.amount, currency)} · {formatCents(p.refundable, currency)} refundable
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError id="refund-payment" error={errors.paymentId} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="refund-amount">Refund amount ({currency})</Label>
            <Input id="refund-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="tabular" aria-invalid={!!errors.amount} aria-describedby={errors.amount ? "refund-amount-error" : "refund-amount-hint"} />
            {errors.amount ? (
              <FieldError id="refund-amount" error={errors.amount} />
            ) : (
              <p id="refund-amount-hint" className="text-xs text-muted-foreground">
                Up to {formatCents(max, currency)}.
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="refund-reason">Reason</Label>
            <Textarea id="refund-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} aria-invalid={!!errors.reason} aria-describedby={errors.reason ? "refund-reason-error" : undefined} />
            <FieldError id="refund-reason" error={errors.reason} />
          </div>
          <p className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Simulated — no money is returned through a live processor.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Issue refund
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
