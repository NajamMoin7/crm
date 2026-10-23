"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, fieldAria } from "./field";
import { updateCustomerAction } from "@/app/(crm)/customers/actions";

type Values = { fullName: string; email: string; phone: string; companyName: string; notes: string };
type Errors = Record<string, string[] | undefined>;

/** Client-side check mirroring the server schema (the server re-validates everything). */
export function validateCustomer(v: Values): Errors {
  const e: Errors = {};
  if (v.fullName.trim().length < 2) e.fullName = ["Full name is required."];
  if (!v.email.trim()) e.email = ["Email is required."];
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) e.email = ["Enter a valid email address."];
  if (!v.phone.trim()) e.phone = ["Phone number is required."];
  else if (v.phone.replace(/\D/g, "").length < 7) e.phone = ["Enter a valid phone number (at least 7 digits)."];
  return e;
}

/** The essentials only: name, email, phone; company and a note are optional. */
export function CustomerFields({
  values,
  errors,
  onChange,
  withNotes = true,
  idPrefix = "c",
}: {
  values: Values;
  errors: Errors;
  onChange: (k: keyof Values, v: string) => void;
  withNotes?: boolean;
  idPrefix?: string;
}) {
  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id={id("fullName")} label="Full name" required error={errors.fullName} className="sm:col-span-2">
        <Input {...fieldAria(id("fullName"), errors.fullName)} value={values.fullName} onChange={(e) => onChange("fullName", e.target.value)} autoComplete="off" maxLength={120} />
      </Field>
      <Field id={id("email")} label="Email address" required error={errors.email}>
        <Input {...fieldAria(id("email"), errors.email)} type="email" value={values.email} onChange={(e) => onChange("email", e.target.value)} autoComplete="off" maxLength={200} />
      </Field>
      <Field id={id("phone")} label="Phone number" required error={errors.phone}>
        <Input {...fieldAria(id("phone"), errors.phone)} type="tel" value={values.phone} onChange={(e) => onChange("phone", e.target.value)} autoComplete="off" maxLength={40} />
      </Field>
      <Field id={id("companyName")} label="Company name" error={errors.companyName} className="sm:col-span-2">
        <Input {...fieldAria(id("companyName"), errors.companyName)} value={values.companyName} onChange={(e) => onChange("companyName", e.target.value)} placeholder="Optional" maxLength={120} />
      </Field>
      {withNotes && (
        <Field id={id("notes")} label="Internal notes" error={errors.notes} className="sm:col-span-2">
          <Textarea id={id("notes")} rows={3} value={values.notes} onChange={(e) => onChange("notes", e.target.value)} placeholder="Optional — visible to your team only" maxLength={2000} />
        </Field>
      )}
    </div>
  );
}

export type EditableCustomer = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  status: "active" | "prospect" | "inactive" | "blocked";
  assignedAgentId: string | null;
};

/** Edit the same essentials; Super Admins can also change status and owner. */
export function EditCustomerDialog({ customer, agents }: { customer: EditableCustomer; agents: { id: string; name: string }[] | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const initial = { fullName: customer.fullName, email: customer.email ?? "", phone: customer.phone ?? "", companyName: customer.companyName ?? "", notes: "" };
  const [values, setValues] = useState<Values>(initial);
  const [status, setStatus] = useState(customer.status);
  const [owner, setOwner] = useState(customer.assignedAgentId ?? "");
  const [errors, setErrors] = useState<Errors>({});
  const [pending, start] = useTransition();
  useEffect(() => () => setOpen(false), []);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const v = validateCustomer(values);
    setErrors(v);
    if (Object.keys(v).length) return;
    start(async () => {
      const res = await updateCustomerAction(customer.id, {
        fullName: values.fullName,
        email: values.email,
        phone: values.phone,
        companyName: values.companyName || undefined,
        status,
        assignedAgentId: owner || undefined,
      });
      if (res.ok) {
        toast.success(res.message ?? "Customer updated");
        setOpen(false);
        router.refresh();
      } else {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
      }
    });
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setValues(initial);
          setErrors({});
          setOpen(true);
        }}
      >
        <Pencil /> Edit
      </Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit customer</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{customer.id}</span>
            </DialogDescription>
          </DialogHeader>
          <form id="edit-customer-form" className="grid gap-4" noValidate onSubmit={save}>
            <CustomerFields values={values} errors={errors} onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))} withNotes={false} idPrefix="edit" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="edit-status" label="Status">
                <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
                  <SelectTrigger id="edit-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="prospect">Prospect</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                    <SelectItem value="blocked">Blocked</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {agents && (
                <Field id="edit-owner" label="Assigned agent">
                  <Select value={owner} onValueChange={setOwner}>
                    <SelectTrigger id="edit-owner" className="w-full">
                      <SelectValue placeholder="Unassigned" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </div>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" form="edit-customer-form" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
