"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ClipboardPaste, CreditCard, Loader2, Lock, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BrandMark, type BrandLite } from "@/components/crm/brand-badge";
import { createOrderAction } from "@/app/(crm)/billing/actions";
import { lookupCustomersAction } from "@/app/(crm)/customers/actions";
import { parsePastedOrder, type PastedOrder } from "./paste-parse";
import { parseMoneyInput, referenceError } from "./math";
import { COUNTRIES, PAYMENT_METHOD } from "@/lib/domain/vocab";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";

export type OrderBrand = BrandLite & { allowedPaymentMethods: string[]; defaultCurrency: string };
export type OrderAgent = { id: string; name: string; brandIds: string[] };
export type OrderPrefill = Partial<Record<keyof PastedOrder, string>>;

type Status = "paid" | "partially_paid" | "pending" | "draft";
const STATUSES: { value: Status; label: string }[] = [
  { value: "paid", label: "Paid" },
  { value: "partially_paid", label: "Partially paid" },
  { value: "pending", label: "Pending" },
  { value: "draft", label: "Draft" },
];
const EMPTY = {
  firstName: "",
  lastName: "",
  company: "",
  email: "",
  phone: "",
  country: "United States",
  address1: "",
  address2: "",
  city: "",
  state: "",
  zip: "",
  amount: "",
  description: "",
  invoiceNumber: "",
};
type Values = typeof EMPTY;

/** Remounted after each save (Next keeps visited routes mounted) so it always starts empty. */
export function OrderForm(props: Props) {
  const [generation, setGeneration] = useState(0);
  return <Form key={generation} {...props} onSaved={() => setGeneration((g) => g + 1)} />;
}

type Props = {
  brands: OrderBrand[];
  agents: OrderAgent[];
  viewer: { id: string; name: string };
  canChooseAgent: boolean;
  initialBrandId: string | null;
  prefill?: OrderPrefill;
};

function Form({ brands, agents, viewer, canChooseAgent, initialBrandId, prefill, onSaved }: Props & { onSaved: () => void }) {
  const router = useRouter();
  const [brandId, setBrandId] = useState(initialBrandId ?? (brands.length === 1 ? brands[0].id : ""));
  const [v, setV] = useState<Values>({ ...EMPTY, ...prefill });
  const [status, setStatus] = useState<Status>("paid");
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [received, setReceived] = useState("");
  const [notes, setNotes] = useState("");
  const [agentId, setAgentId] = useState(viewer.id);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [match, setMatch] = useState<{ id: string; name: string } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [saving, start] = useTransition();
  const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const brand = brands.find((b) => b.id === brandId);
  const currency = brand?.defaultCurrency ?? "USD";
  const totalCents = parseMoneyInput(v.amount) ?? 0;
  const set = (k: keyof Values, value: string) => {
    setV((s) => ({ ...s, [k]: value }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: "" }));
  };

  // Let the agent know when the email belongs to a customer we already have.
  useEffect(() => {
    if (lookupTimer.current) clearTimeout(lookupTimer.current);
    const email = v.email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    lookupTimer.current = setTimeout(async () => {
      const res = await lookupCustomersAction({ email });
      const hit = res.ok ? res.data?.find((m) => m.reasons.includes("Email") && !m.merged) : undefined;
      setMatch(hit ? { id: hit.id, name: hit.fullName } : null);
    }, 400);
    return () => {
      if (lookupTimer.current) clearTimeout(lookupTimer.current);
    };
  }, [v.email]);

  const applyPaste = (text: string) => {
    const { fields, removedCardData, matched } = parsePastedOrder(text);
    const filled = Object.entries(fields).filter(([, val]) => val);
    if (!filled.length) {
      toast.error("Couldn't find customer details in the pasted text.");
      return false;
    }
    setV((s) => ({ ...s, ...Object.fromEntries(filled) }));
    setErrors({});
    toast.success(`Filled ${filled.length} field${filled.length === 1 ? "" : "s"} from the pasted details.`);
    if (removedCardData) toast.warning("Card details were ignored — the CRM never stores card numbers, CVV or expiry dates.");
    return matched >= 0;
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim() && applyPaste(text)) return;
    } catch {
      /* clipboard permission denied: fall back to the paste box */
    }
    setPasteText("");
    setPasteOpen(true);
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!brand) e.brandId = "Select a brand.";
    if (!totalCents) e.amount = "Enter the amount.";
    if (!v.firstName.trim()) e.firstName = "First name is required.";
    if (!v.lastName.trim()) e.lastName = "Last name is required.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) e.email = v.email ? "Enter a valid email address." : "Email is required.";
    if (v.phone.replace(/\D/g, "").length < 7) e.phone = v.phone ? "Enter a valid phone number." : "Phone number is required.";
    if (!method) e.paymentMethod = "Choose a payment method.";
    if (status === "paid" || status === "partially_paid") {
      const r = referenceError(reference);
      if (r) e.paymentReference = r;
    }
    if (status === "partially_paid") {
      const r = parseMoneyInput(received);
      if (!r) e.amountReceived = "Enter the amount received.";
      else if (r >= totalCents) e.amountReceived = "Must be less than the amount — use Paid instead.";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = () => {
    if (!validate()) {
      toast.error("Please complete the highlighted fields.");
      return;
    }
    start(async () => {
      const res = await createOrderAction({
        brandId,
        agentId: canChooseAgent ? agentId : undefined,
        amount: (totalCents / 100).toFixed(2),
        description: v.description || undefined,
        invoiceNumber: v.invoiceNumber || undefined,
        firstName: v.firstName,
        lastName: v.lastName,
        company: v.company || undefined,
        email: v.email,
        phone: v.phone,
        country: v.country || undefined,
        address1: v.address1 || undefined,
        address2: v.address2 || undefined,
        city: v.city || undefined,
        state: v.state || undefined,
        zip: v.zip || undefined,
        paymentStatus: status,
        paymentMethod: method as never,
        paymentReference: status === "paid" || status === "partially_paid" ? reference.trim() : undefined,
        amountReceived: status === "partially_paid" ? ((parseMoneyInput(received) ?? 0) / 100).toFixed(2) : undefined,
        notes: notes || undefined,
      });
      if (res.ok && res.data) {
        toast.success(res.message ?? "Order saved");
        router.push(`/billing/${res.data.invoiceId}`);
        onSaved();
      } else if (!res.ok) {
        setErrors(Object.fromEntries(Object.entries(res.fieldErrors ?? {}).map(([k, m]) => [k, m?.[0] ?? ""])));
        toast.error(res.error);
      }
    });
  };

  const field = (k: keyof Values, label: string, opts: { required?: boolean; placeholder?: string; type?: string; className?: string; inputMode?: "decimal" | "tel" | "email" } = {}) => (
    <div className={cn("grid gap-1.5", opts.className)}>
      <Label htmlFor={`o-${k}`}>
        {label}
        {opts.required && <span className="text-primary">*</span>}
      </Label>
      <Input
        id={`o-${k}`}
        type={opts.type ?? "text"}
        inputMode={opts.inputMode}
        value={v[k]}
        onChange={(e) => set(k, e.target.value)}
        placeholder={opts.placeholder}
        aria-invalid={!!errors[k] || undefined}
        autoComplete="off"
        className="h-10"
      />
      {errors[k] && <p className="text-xs text-destructive">{errors[k]}</p>}
    </div>
  );

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-6">
        <section className="rounded-xl border bg-card p-5 shadow-xs sm:p-7">
          <SectionTitle n="01" title="Billing information" hint="Choose the brand, then enter or paste the customer's details and the amount." />
          <div className="mt-5 grid gap-2" role="radiogroup" aria-label="Brand">
            <Label>
              Brand<span className="text-primary">*</span>
            </Label>
            <div className="flex flex-wrap gap-2">
              {brands.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  role="radio"
                  aria-checked={brandId === b.id}
                  onClick={() => {
                    setBrandId(b.id);
                    setMethod("");
                    setErrors((e) => ({ ...e, brandId: "" }));
                  }}
                  className={cn(
                    "flex items-center gap-2 rounded-full border py-1.5 pr-4 pl-1.5 text-sm transition-colors hover:border-primary/60",
                    brandId === b.id && "border-primary bg-primary/10 text-primary",
                  )}
                >
                  <BrandMark brand={b} size="md" />
                  {b.name}
                </button>
              ))}
            </div>
            {brands.length === 0 && <p className="text-sm text-muted-foreground">No brands are assigned to you. Ask a Super Admin.</p>}
            {errors.brandId && <p className="text-xs text-destructive">{errors.brandId}</p>}
          </div>

          <div className="mt-6">
            <Button type="button" variant="outline" size="sm" className="rounded-full border-primary/50 text-primary hover:bg-primary/10" onClick={paste}>
              <ClipboardPaste /> Paste details
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">Copy the customer&apos;s details from anywhere and paste them in one click. Card details are always ignored.</p>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {field("amount", `Amount (${currency})`, { required: true, placeholder: "0.00", inputMode: "decimal" })}
            {field("invoiceNumber", "Invoice number", { placeholder: "Optional, e.g. 483920" })}
            {field("description", "Description", { placeholder: "Optional, e.g. custom logo", className: "sm:col-span-2" })}
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {field("firstName", "First name", { required: true })}
            {field("lastName", "Last name", { required: true })}
            {field("company", "Company")}
            {field("email", "Email address", { required: true, type: "email", inputMode: "email", className: "sm:col-span-2" })}
            {field("phone", "Phone number", { required: true, type: "tel", inputMode: "tel" })}
          </div>
          {match && (
            <p className="mt-3 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
              <UserCheck className="size-4 text-primary" aria-hidden />
              Existing customer <span className="font-medium">{match.name}</span> <span className="font-mono text-xs text-muted-foreground">{match.id}</span> — this order will be added to their record.
            </p>
          )}

          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5 sm:col-span-3">
              <Label htmlFor="o-country">Country</Label>
              <Select value={v.country} onValueChange={(c) => set("country", c)}>
                <SelectTrigger id="o-country" className="h-10 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(COUNTRIES.includes(v.country) || !v.country ? COUNTRIES : [v.country, ...COUNTRIES]).map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {field("address1", "Address")}
            {field("address2", "Address (cont.)")}
            {field("city", "City")}
            {field("state", "State / province")}
            {field("zip", "ZIP code")}
          </div>
        </section>

        <section className="rounded-xl border bg-card p-5 shadow-xs sm:p-7">
          <SectionTitle n="02" title="Payment" hint="How the order was paid. Payments are recorded, never processed, in this demo." />
          <div className="mt-5 grid gap-2" role="radiogroup" aria-label="Payment status">
            <Label>Payment status</Label>
            <div className="flex flex-wrap gap-2">
              {STATUSES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  role="radio"
                  aria-checked={status === s.value}
                  onClick={() => setStatus(s.value)}
                  className={cn("rounded-full border px-4 py-1.5 text-sm transition-colors hover:border-primary/60", status === s.value && "border-primary bg-primary/10 text-primary")}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="o-method">
                Payment method<span className="text-primary">*</span>
              </Label>
              <Select value={method} onValueChange={(m) => (setMethod(m), setErrors((e) => ({ ...e, paymentMethod: "" })))} disabled={!brand}>
                <SelectTrigger id="o-method" className="h-10 w-full" aria-invalid={!!errors.paymentMethod || undefined}>
                  <SelectValue placeholder={brand ? "Choose…" : "Select a brand first"} />
                </SelectTrigger>
                <SelectContent>
                  {(brand?.allowedPaymentMethods ?? []).map((m) => (
                    <SelectItem key={m} value={m}>
                      {PAYMENT_METHOD[m] ?? m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.paymentMethod && <p className="text-xs text-destructive">{errors.paymentMethod}</p>}
            </div>
            {(status === "paid" || status === "partially_paid") && (
              <div className="grid gap-1.5">
                <Label htmlFor="o-ref">
                  Payment reference<span className="text-primary">*</span>
                </Label>
                <Input id="o-ref" value={reference} onChange={(e) => (setReference(e.target.value), setErrors((x) => ({ ...x, paymentReference: "" })))} placeholder="Transaction ID, e.g. pi_…" className="h-10" autoComplete="off" aria-invalid={!!errors.paymentReference || undefined} />
                <p className={cn("text-xs", errors.paymentReference ? "text-destructive" : "text-muted-foreground")}>{errors.paymentReference || "The processor's transaction ID — never a card number."}</p>
              </div>
            )}
            {status === "partially_paid" && (
              <div className="grid gap-1.5">
                <Label htmlFor="o-received">Amount received</Label>
                <Input id="o-received" inputMode="decimal" value={received} onChange={(e) => (setReceived(e.target.value), setErrors((x) => ({ ...x, amountReceived: "" })))} placeholder="0.00" className="h-10" aria-invalid={!!errors.amountReceived || undefined} />
                {errors.amountReceived && <p className="text-xs text-destructive">{errors.amountReceived}</p>}
              </div>
            )}
            {canChooseAgent && brand && (
              <div className="grid gap-1.5">
                <Label htmlFor="o-agent">Sales agent</Label>
                <Select value={agentId} onValueChange={setAgentId}>
                  <SelectTrigger id="o-agent" className="h-10 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={viewer.id}>{viewer.name} (you)</SelectItem>
                    {agents
                      .filter((a) => a.id !== viewer.id && a.brandIds.includes(brand.id))
                      .map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="o-notes">Notes</Label>
              <Textarea id="o-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" maxLength={2000} />
            </div>
          </div>
          <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <Lock className="size-3.5" aria-hidden /> Card numbers and CVV are never entered or stored here — only the processor&apos;s transaction reference.
          </p>
        </section>
      </div>

      <aside className="xl:sticky xl:top-20 xl:self-start" data-testid="wizard-summary">
        <div className="rounded-xl border bg-card p-6 shadow-xs">
          <p className="eyebrow text-primary">Order summary</p>
          <p className="mt-1 text-xs text-muted-foreground">Invoice number assigned on save</p>
          <dl className="mt-5 space-y-3 border-t pt-4 text-sm">
            <Row k="Brand" v={brand?.name} />
            <Row k="Agent" v={canChooseAgent ? (agents.find((a) => a.id === agentId)?.name ?? viewer.name) : viewer.name} />
            <Row k="Customer" v={[v.firstName, v.lastName].filter(Boolean).join(" ")} />
            <Row k="Invoice #" v={v.invoiceNumber} />
            <Row k="Description" v={v.description} />
            <Row k="Status" v={STATUSES.find((s) => s.value === status)?.label} />
          </dl>
          <div className="mt-5 flex items-baseline justify-between border-t pt-4">
            <span className="font-heading text-lg">Total</span>
            <span className="text-2xl font-semibold text-primary tabular" data-testid="wizard-total">
              {formatCents(totalCents, currency)}
            </span>
          </div>
          <Button type="button" size="lg" className="mt-5 h-12 w-full rounded-full text-sm font-semibold tracking-[0.14em] uppercase" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <CreditCard />} Save order {formatCents(totalCents, currency)}
          </Button>
          <p className="mt-3 text-center text-xs text-muted-foreground">Saving creates the invoice and adds the order to the customer&apos;s record.</p>
        </div>
      </aside>

      <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Paste details</DialogTitle>
            <DialogDescription>Paste the customer&apos;s details below — names, email, phone, address, amount. Card details are ignored.</DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="Pasted details"
            rows={8}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={"Name: Jane Smith\nEmail: jane@example.com\nPhone: +1 555 010 2030\nAddress: 12 Main St\nCity: Austin\nState: TX\nZip: 78701\nAmount: $150"}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasteOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (applyPaste(pasteText)) setPasteOpen(false);
              }}
              disabled={!pasteText.trim()}
            >
              <ClipboardPaste /> Fill the form
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SectionTitle({ n, title, hint }: { n: string; title: string; hint: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-primary/50 text-xs font-semibold text-primary">{n}</span>
      <div>
        <h2 className="text-xl">{title}</h2>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="min-w-0 truncate text-right">{v || "—"}</dd>
    </div>
  );
}
