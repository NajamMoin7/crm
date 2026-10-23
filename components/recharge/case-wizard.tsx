"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Info,
  Loader2,
  Search,
  Send,
  Save,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { BrandBadge, BrandMark, type BrandLite } from "@/components/crm/brand-badge";
import { StatusBadge } from "@/components/crm/status-badge";
import { CASE_TYPE, INVOICE_STATUS, PAYMENT_METHOD, REASON_CODES } from "@/lib/domain/vocab";
import { formatCents, fromCents, toCents } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  createCaseAction,
  entityOptionsAction,
  searchOriginalAction,
  updateDraftAction,
  type EntityOptions,
  type OriginalTxnResult,
} from "@/app/(crm)/recharge/actions";

type CaseType = "chargeback" | "intercompany_recharge";

export type WizardInitial = {
  caseId: string;
  brandId: string;
  caseType: CaseType;
  original: OriginalTxnResult;
  responsibleLegalEntityId: string;
  amount: string;
  reasonCode: string;
  notes: string;
  requestDate: string;
  origin: "crm" | "processor";
  externalProcessorReference: string;
  evidenceSummary: string;
};

const STEPS = ["Brand", "Original transaction", "Ownership", "Details", "Review"] as const;

type WizardProps = {
  brands: BrandLite[];
  viewerName: string;
  today: string;
  initial?: WizardInitial;
  prefillQuery?: string;
};

/**
 * Next 16 keeps visited routes mounted (React Activity), so a finished wizard
 * would reappear pre-filled on the next visit. Remount it after a save.
 */
export function CaseWizard(props: WizardProps) {
  const [generation, setGeneration] = useState(0);
  return <WizardInner key={generation} {...props} onSaved={() => setGeneration((g) => g + 1)} />;
}

function WizardInner({
  brands,
  viewerName,
  today,
  initial,
  prefillQuery,
  onSaved,
}: WizardProps & { onSaved: () => void }) {
  const router = useRouter();
  const editing = !!initial;
  const [step, setStep] = useState(editing ? 3 : brands.length === 1 ? 1 : 0);
  const [brandId, setBrandId] = useState(initial?.brandId ?? (brands.length === 1 ? brands[0].id : ""));
  const [query, setQuery] = useState(prefillQuery ?? "");
  const [results, setResults] = useState<OriginalTxnResult[] | null>(null);
  const [searching, startSearch] = useTransition();
  const [original, setOriginal] = useState<OriginalTxnResult | null>(initial?.original ?? null);
  const [caseType] = useState<CaseType>(initial?.caseType ?? "chargeback");
  const [requestDate, setRequestDate] = useState(initial?.requestDate ?? today);
  const [entities, setEntities] = useState<EntityOptions | null>(null);
  const [responsible, setResponsible] = useState(initial?.responsibleLegalEntityId ?? "");
  const [amount, setAmount] = useState(initial?.amount ?? "");
  const [reasonCode, setReasonCode] = useState(initial?.reasonCode ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [origin, setOrigin] = useState<"crm" | "processor">(initial?.origin ?? "crm");
  const [externalRef, setExternalRef] = useState(initial?.externalProcessorReference ?? "");
  const [evidence, setEvidence] = useState(initial?.evidenceSummary ?? "");
  const [errors, setErrors] = useState<Record<string, string[] | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();

  const brand = brands.find((b) => b.id === brandId);
  const brandName = (id: string) => brands.find((b) => b.id === id)?.name ?? id;

  // Remaining chargeable when editing excludes this case's own amount.
  const remaining = original ? original.remainingCents + (editing && initial?.caseType === caseType ? toCents(initial.amount) : 0) : 0;

  useEffect(() => {
    if (!original || !brandId) return;
    let live = true;
    entityOptionsAction({ brandId, caseType, originalTransactionId: original.id, requestDate }).then((res) => {
      if (!live) return;
      if (res.ok && res.data) {
        setEntities(res.data);
        setResponsible((cur) => (cur && res.data!.options.some((o) => o.id === cur) ? cur : res.data!.defaultId));
      } else if (!res.ok) setFormError(res.error);
    });
    return () => {
      live = false;
    };
  }, [original, brandId, caseType, requestDate]);

  const runSearch = () => {
    if (query.trim().length < 3) {
      setErrors({ query: ["Enter at least 3 characters."] });
      return;
    }
    setErrors({});
    startSearch(async () => {
      const res = await searchOriginalAction(query);
      if (res.ok) setResults(res.data ?? []);
      else toast.error(res.error);
    });
  };

  // Deep link (e.g. "Raise recharge" from an invoice): look the payment up and jump to ownership.
  useEffect(() => {
    if (!prefillQuery || editing) return;
    startSearch(async () => {
      const res = await searchOriginalAction(prefillQuery);
      if (!res.ok || !res.data) return;
      setResults(res.data);
      const usable = res.data.filter((r) => brands.some((b) => b.id === r.brandId) && r.remainingCents > 0);
      if (usable.length === 1) {
        setBrandId(usable[0].brandId);
        setOriginal(usable[0]);
        setAmount(fromCents(usable[0].remainingCents));
        setStep(2);
      } else if (res.data[0] && brands.some((b) => b.id === res.data![0].brandId)) {
        setBrandId(res.data[0].brandId);
        setStep(1);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reasonOptions = useMemo(
    () => REASON_CODES.filter((r) => (caseType === "intercompany_recharge" ? r.network === "Internal" : r.network !== "Internal")),
    [caseType],
  );

  /* --------------------------------------------------- client validation */
  const validateDetails = () => {
    const e: Record<string, string[]> = {};
    const cents = /^\d{1,10}(\.\d{1,2})?$/.test(amount.trim()) ? toCents(amount) : NaN;
    if (Number.isNaN(cents)) e.amount = ["Enter an amount with up to 2 decimals."];
    else if (cents <= 0) e.amount = ["Must be greater than zero."];
    else if (cents > remaining) e.amount = [`Maximum chargeable is ${fromCents(remaining)} ${original?.currency}.`];
    else if (entities && !entities.policy.allowPartial && cents !== remaining) e.amount = ["Policy requires the full chargeable amount."];
    if (!reasonCode || !reasonOptions.some((r) => r.code === reasonCode)) e.reasonCode = ["Select a reason code."];
    if (notes.trim().length < 5) e.notes = ["Add supporting notes (min. 5 characters)."];
    if (!requestDate) e.requestDate = ["Enter the request date."];
    else if (requestDate > today) e.requestDate = ["Cannot be in the future."];
    if (origin === "processor" && !externalRef.trim()) e.externalProcessorReference = ["Required for processor-originated cases."];
    if (externalRef && !/^[A-Za-z0-9_\-.:]*$/.test(externalRef)) e.externalProcessorReference = ["Use letters, numbers and - _ . : only."];
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const canNext = [
    !!brandId,
    !!original && original.brandId === brandId,
    !!original && !!responsible,
    true,
    true,
  ][step];

  const next = () => {
    setFormError(null);
    if (step === 3 && !validateDetails()) return;
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const payload = () => ({
    caseType,
    brandId,
    originalTransactionId: original!.id,
    responsibleLegalEntityId: responsible,
    amount: amount.trim(),
    currency: original!.currency,
    reasonCode,
    notes,
    requestDate,
    origin,
    externalProcessorReference: externalRef.trim() || undefined,
    evidenceSummary: evidence.trim() || undefined,
  });

  const fieldStep: Record<string, number> = {
    brandId: 0,
    originalTransactionId: 1,
    responsibleLegalEntityId: 2,
    amount: 3,
    currency: 3,
    reasonCode: 3,
    notes: 3,
    requestDate: 3,
    externalProcessorReference: 3,
  };

  const save = (submit: boolean) => {
    if (!validateDetails()) {
      setStep(3);
      return;
    }
    setFormError(null);
    startSave(async () => {
      const res = editing ? await updateDraftAction(initial!.caseId, payload()) : await createCaseAction(payload(), submit);
      if (!res.ok) {
        setFormError(res.error);
        setErrors(res.fieldErrors ?? {});
        const first = Object.keys(res.fieldErrors ?? {}).find((k) => k in fieldStep);
        if (first) setStep(fieldStep[first]);
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "Saved");
      const id = editing ? initial!.caseId : (res.data as { id: string }).id;
      router.push(`/recharge/${id}`);
      onSaved();
    });
  };

  const err = (k: string) =>
    errors[k]?.length ? (
      <p id={`${k}-error`} className="text-xs text-destructive">
        {errors[k]![0]}
      </p>
    ) : null;


  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="min-w-0 space-y-5">
        {/* Stepper */}
        <ol className="flex flex-wrap gap-1.5" aria-label="Progress">
          {STEPS.map((s, i) => {
            const done = i < step;
            const current = i === step;
            const reachable = editing ? i >= 3 || i <= step : i <= step;
            return (
              <li key={s}>
                <button
                  type="button"
                  disabled={!reachable || saving}
                  onClick={() => setStep(i)}
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors disabled:cursor-not-allowed",
                    current && "border-foreground bg-foreground text-background",
                    done && !current && "bg-muted text-foreground hover:bg-accent",
                    !done && !current && "text-muted-foreground",
                  )}
                >
                  <span className="tabular">{done ? <Check className="size-3" /> : i + 1}</span>
                  {s}
                </button>
              </li>
            );
          })}
        </ol>

        <section className="rounded-xl border bg-card p-4 shadow-xs sm:p-6">
          {/* Step 1 — Brand */}
          {step === 0 && (
            <div className="space-y-4">
              <StepTitle n={1} title="Select brand" hint="Only brands you are authorised for are listed. The brand stays fixed for the whole request." />
              <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Brand">
                {brands.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    role="radio"
                    aria-checked={brandId === b.id}
                    onClick={() => {
                      if (b.id !== brandId) {
                        setBrandId(b.id);
                        setOriginal(null);
                        setResults(null);
                        setEntities(null);
                        setResponsible("");
                      }
                    }}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-accent/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                      brandId === b.id && "border-foreground ring-1 ring-foreground",
                    )}
                  >
                    <BrandMark brand={b} size="lg" />
                    <span>
                      <span className="block text-sm font-medium">{b.name}</span>
                      <span className="block text-xs text-muted-foreground">{b.id}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step 2 — Find original transaction */}
          {step === 1 && (
            <div className="space-y-4">
              <StepTitle n={2} title="Find the original transaction" hint="Search by transaction ID, invoice number, customer ID, customer email or payment reference." />
              <form
                className="flex flex-col gap-2 sm:flex-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  runSearch();
                }}
              >
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="TXN-500123, LTD-2026-000042, CUS-100012, name@example.com, pi_…"
                    className="pl-8"
                    aria-label="Search original transaction"
                    aria-invalid={!!errors.query}
                  />
                </div>
                <Button type="submit" disabled={searching}>
                  {searching ? <Loader2 className="animate-spin" /> : <Search />} Search
                </Button>
              </form>
              {err("query")}
              {results && results.length === 0 && (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No succeeded payments found that you can access. Agents can only raise requests on their own billing records.
                </p>
              )}
              {results && results.length > 0 && (
                <ul className="divide-y overflow-hidden rounded-lg border">
                  {results.map((r) => {
                    const mismatch = r.brandId !== brandId;
                    const exhausted = r.remainingCents <= 0;
                    const selected = original?.id === r.id;
                    return (
                      <li key={r.id}>
                        <button
                          type="button"
                          disabled={mismatch}
                          onClick={() => {
                            setOriginal(r);
                            setAmount(fromCents(r.remainingCents));
                            setErrors({});
                          }}
                          className={cn(
                            "flex w-full flex-col gap-2 p-3 text-left transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60 sm:flex-row sm:items-center",
                            selected && "bg-accent/60",
                          )}
                        >
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                              <span className="font-mono">{r.id}</span>
                              <BrandBadge brand={brands.find((b) => b.id === r.brandId) ?? { id: r.brandId, code: r.brandId.slice(4), name: r.brandId, color: "#888" }} />
                              {selected && <StatusBadge tone="success" label="Selected" />}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {r.customerName} · {r.invoiceNumber} · {new Date(r.occurredAt).toLocaleDateString("en-US", { dateStyle: "medium" })} · {PAYMENT_METHOD[r.paymentMethod ?? ""] ?? r.paymentMethod}
                            </span>
                            {mismatch && <span className="text-xs text-amber-700 dark:text-amber-400">Belongs to {brandName(r.brandId)} — switch the brand in step 1 to use it.</span>}
                          </span>
                          <span className="text-right text-sm tabular">
                            <span className="block font-medium">{formatCents(r.originalCents, r.currency)}</span>
                            <span className={cn("block text-xs", exhausted ? "text-destructive" : "text-muted-foreground")}>
                              {exhausted ? "Nothing left to charge back" : `${formatCents(r.remainingCents, r.currency)} chargeable`}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {/* Step 3 — Ownership */}
          {step === 2 && original && (
            <div className="space-y-4">
              <StepTitle n={3} title="Transaction ownership" hint="Confirm this is the right payment. These facts come from the original record and cannot be changed here." />
              <OwnershipPanel original={original} brandName={brandName(original.brandId)} />
              {original.remainingCents <= 0 && (
                <Callout tone="danger">
                  This payment has no chargeable balance left (refunds and other active cases already cover the full amount). Choose another transaction.
                </Callout>
              )}
            </div>
          )}

          {step === 3 && original && (
            <div className="space-y-5">
              <StepTitle n={4} title="Request details" hint="Amounts are validated against the original transaction and every other active case on it." />
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="amount">Amount</Label>
                  <div className="flex gap-2">
                    <Input
                      id="amount"
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      aria-invalid={!!errors.amount}
                      aria-describedby="amount-hint amount-error"
                      className="tabular"
                    />
                    <Button type="button" variant="outline" onClick={() => setAmount(fromCents(remaining))}>
                      Full
                    </Button>
                  </div>
                  <p id="amount-hint" className="text-xs text-muted-foreground">
                    Max {formatCents(remaining, original.currency)} · {entities?.policy.allowPartial === false ? "partial amounts disabled by policy" : "partial allowed"}
                  </p>
                  {err("amount")}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="currency">Currency</Label>
                  <Input id="currency" value={original.currency} readOnly disabled />
                  <p className="text-xs text-muted-foreground">Locked to the original transaction currency.</p>
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label htmlFor="reason">Reason code</Label>
                  <Select value={reasonCode} onValueChange={setReasonCode}>
                    <SelectTrigger id="reason" className="w-full" aria-invalid={!!errors.reasonCode}>
                      <SelectValue placeholder="Select a reason code" />
                    </SelectTrigger>
                    <SelectContent>
                      {reasonOptions.map((r) => (
                        <SelectItem key={r.code} value={r.code}>
                          <span className="font-mono text-xs">{r.code}</span> {r.label} <span className="text-muted-foreground">· {r.network}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {err("reasonCode")}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="requestDate">Request date</Label>
                  <Input id="requestDate" type="date" max={today} value={requestDate} onChange={(e) => setRequestDate(e.target.value)} aria-invalid={!!errors.requestDate} />
                  {err("requestDate")}
                </div>
                <div className="grid gap-1.5">
                  <Label>Requested by</Label>
                  <Input value={viewerName} readOnly disabled />
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label>Origin</Label>
                  <RadioGroup value={origin} onValueChange={(v) => setOrigin(v as "crm" | "processor")} className="flex flex-wrap gap-4">
                    <label className="flex items-center gap-2 text-sm">
                      <RadioGroupItem value="crm" /> Raised in the CRM
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <RadioGroupItem value="processor" /> Received from processor / bank (external case)
                    </label>
                  </RadioGroup>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="extRef">External processor reference {origin === "processor" ? "" : "(optional)"}</Label>
                  <Input id="extRef" value={externalRef} onChange={(e) => setExternalRef(e.target.value)} placeholder="dp_1Q…, case number" aria-invalid={!!errors.externalProcessorReference} />
                  {err("externalProcessorReference")}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="evidence">Evidence summary (optional)</Label>
                  <Input id="evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Delivery logs, emails, signed SOW…" maxLength={2000} />
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label htmlFor="notes">Supporting notes</Label>
                  <Textarea id="notes" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={3000} aria-invalid={!!errors.notes} />
                  {err("notes")}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">Never paste card numbers, CVV or bank credentials into notes.</p>
            </div>
          )}

          {/* Step 6 — Review */}
          {step === 4 && original && (
            <div className="space-y-4">
              <StepTitle n={5} title="Review" hint={editing ? "Save your changes to the draft." : "Save as a draft, or submit now for review. Approval status starts at Draft / Pending Review."} />
              <dl className="grid gap-x-6 gap-y-3 rounded-lg border p-4 text-sm sm:grid-cols-2">
                <Row k="Case type" v={CASE_TYPE[caseType].label} />
                <Row k="Brand" v={brandName(brandId)} />
                <Row k="Customer" v={`${original.customerName} (${original.customerId})`} />
                <Row k="Original transaction" v={`${original.id} · ${original.invoiceNumber}`} />
                <Row k="Original amount" v={formatCents(original.originalCents, original.currency)} />
                <Row k="Requested amount" v={<span className="font-semibold">{formatCents(toCents(amount || "0"), original.currency)}</span>} />
                <Row k="Reason" v={`${reasonCode} — ${REASON_CODES.find((r) => r.code === reasonCode)?.label ?? ""}`} />
                <Row k="Request date" v={requestDate} />
                <Row k="Origin" v={origin === "processor" ? `Processor (${externalRef})` : "CRM"} />
                <Row k="Requested by" v={viewerName} />
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">Notes</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap">{notes}</dd>
                </div>
              </dl>
              <Callout tone="info">
                Demo — simulated. Submitting creates an internal case only; nothing is sent to a card network or processor, and no money moves until finance records completion.
              </Callout>
            </div>
          )}

          {formError && (
            <p role="alert" className="mt-4 flex gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="size-4 shrink-0" /> {formError}
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t pt-4">
            <Button type="button" variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || saving || (editing && step <= 3)}>
              <ArrowLeft /> Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button type="button" onClick={next} disabled={!canNext || (step === 2 && (original?.remainingCents ?? 0) <= 0 && !editing)}>
                Continue <ArrowRight />
              </Button>
            ) : editing ? (
              <Button type="button" onClick={() => save(false)} disabled={saving}>
                {saving ? <Loader2 className="animate-spin" /> : <Save />} Save draft
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => save(false)} disabled={saving}>
                  {saving ? <Loader2 className="animate-spin" /> : <Save />} Save as draft
                </Button>
                <Button type="button" onClick={() => save(true)} disabled={saving}>
                  {saving ? <Loader2 className="animate-spin" /> : <Send />} Submit for review
                </Button>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Sticky context */}
      <aside className="space-y-3 lg:sticky lg:top-20 lg:self-start">
        <div className="rounded-xl border bg-card p-4 shadow-xs">
          <p className="text-xs font-medium text-muted-foreground">Selected brand</p>
          {brand ? (
            <div className="mt-2 flex items-center gap-3">
              <BrandMark brand={brand} size="md" />
              <div>
                <p className="text-sm font-semibold">{brand.name}</p>
                <p className="text-xs text-muted-foreground">{brand.id}</p>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">Not selected yet</p>
          )}
          {original && (
            <dl className="mt-4 space-y-2 border-t pt-3 text-xs">
              <Row k="Original transaction" v={<span className="font-mono">{original.id}</span>} />
              <Row k="Customer" v={original.customerName} />
              <Row k="Chargeable" v={formatCents(remaining, original.currency)} />
            </dl>
          )}
        </div>
        <div className="rounded-xl border border-dashed p-4 text-xs leading-relaxed text-muted-foreground">
          <p className="mb-1 font-medium text-foreground">“Recharge” = chargeback</p>A disputed customer payment reversed by the card network or processor. Internal reimbursements between our LLCs are a separate <em>Intercompany Recharge</em> type with their own approval.
        </div>
      </aside>
    </div>
  );
}

function StepTitle({ n, title, hint }: { n: number; title: string; hint: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">Step {n} of 5</p>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 sm:block">
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className="text-right sm:mt-0.5 sm:text-left">{v}</dd>
    </div>
  );
}

export function Callout({ tone, children }: { tone: "info" | "warning" | "danger"; children: React.ReactNode }) {
  const cls = {
    info: "border-sky-500/30 bg-sky-500/5 text-sky-900 dark:text-sky-200",
    warning: "border-amber-500/40 bg-amber-500/8 text-amber-900 dark:text-amber-200",
    danger: "border-red-500/30 bg-red-500/5 text-red-900 dark:text-red-200",
  }[tone];
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <div className={cn("flex gap-2 rounded-lg border p-3 text-sm", cls)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export function OwnershipPanel({
  original,
  brandName,
}: {
  original: OriginalTxnResult;
  brandName: string;
}) {
  const inv = INVOICE_STATUS[original.invoiceStatus];
  return (
    <dl className="grid gap-x-6 gap-y-3 rounded-lg border p-4 text-sm sm:grid-cols-2">
      <Row k="Original customer" v={`${original.customerName} (${original.customerId})`} />
      <Row k="Original brand" v={brandName} />
      <Row k="Original invoice" v={<span>{original.invoiceNumber} {inv && <StatusBadge tone={inv.tone} label={inv.label} />}</span>} />
      <Row k="Original transaction amount" v={formatCents(original.originalCents, original.currency)} />
      <Row k="Currency" v={original.currency} />
      <Row k="Original payment reference" v={<span className="font-mono text-xs">{original.paymentReference}</span>} />
      <Row k="Current transaction status" v={<StatusBadge tone="success" label="Succeeded" />} />
      <Row k="Refunded" v={formatCents(original.refundedCents, original.currency)} />
      <Row k="Other active cases" v={`${original.activeCases} · ${formatCents(original.committedCents, original.currency)}`} />
      <Row k="Payment method" v={`${PAYMENT_METHOD[original.paymentMethod ?? ""] ?? original.paymentMethod ?? "—"} · ${original.processor ?? ""}`} />
      <Row k="Remaining chargeable" v={<span className="font-semibold">{formatCents(original.remainingCents, original.currency)}</span>} />
    </dl>
  );
}
