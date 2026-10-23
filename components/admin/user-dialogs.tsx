"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Eye, EyeOff, KeyRound, Loader2, Pencil, RefreshCw, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CheckboxGroup, Field, invalid, useCloseOnHide, useServerAction } from "@/components/admin/form-kit";
import { createUserAction, resetPasswordAction, updateUserAction } from "@/app/(crm)/admin/actions";
import { cn } from "@/lib/utils";

type Role = "super_admin" | "sales_agent";
export type Opt = { id: string; name: string };
export type UserEditable = {
  id: string;
  name: string;
  email: string;
  status: "active" | "suspended";
  role: Role;
  brandIds: string[];
  createdLabel: string;
};

type Ctx = { brands: Opt[]; viewerId: string };

const RULES: [RegExp | ((s: string) => boolean), string][] = [
  [(s) => s.length >= 12, "12+ characters"],
  [/[A-Z]/, "Uppercase"],
  [/[a-z]/, "Lowercase"],
  [/\d/, "Number"],
  [/[^A-Za-z0-9]/, "Symbol"],
];

function generatePassword() {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^&*-_=+?"];
  const all = sets.join("");
  const rnd = (n: number) => {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] % n;
  };
  const chars = sets.map((s) => s[rnd(s.length)]);
  while (chars.length < 16) chars.push(all[rnd(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function PasswordInput({ id, value, onChange, error }: { id: string; value: string; onChange: (v: string) => void; error?: string[] }) {
  const [show, setShow] = useState(false);
  return (
    <div className="grid gap-1.5">
      <div className="flex gap-1.5">
        <div className="relative flex-1">
          <Input
            {...invalid(id, error)}
            type={show ? "text" : "password"}
            autoComplete="new-password"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="pr-9 font-mono"
            maxLength={128}
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            aria-label={show ? "Hide password" : "Show password"}
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Generate strong password"
          title="Generate"
          onClick={() => {
            onChange(generatePassword());
            setShow(true);
          }}
        >
          <RefreshCw />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Copy password"
          title="Copy"
          disabled={!value}
          onClick={() => navigator.clipboard?.writeText(value).then(() => toast.success("Password copied"), () => toast.error("Copy failed"))}
        >
          <Copy />
        </Button>
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Password requirements">
        {RULES.map(([test, label]) => {
          const ok = typeof test === "function" ? test(value) : test.test(value);
          return (
            <li key={label} className={cn("inline-flex items-center gap-1 text-[11px]", ok ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}>
              {ok ? <Check className="size-3" aria-hidden /> : <X className="size-3" aria-hidden />}
              {label}
              <span className="sr-only">{ok ? " met" : " not met"}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function UserDialog({ user, ctx, triggerVariant = "button" }: { user?: UserEditable; ctx: Ctx; triggerVariant?: "button" | "icon" | "text" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {user ? (
        triggerVariant === "text" ? (
          <Button variant="ghost" size="sm" aria-label={`Edit ${user.name}`} onClick={() => setOpen(true)}>
            Edit
          </Button>
        ) : triggerVariant === "icon" ? (
          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${user.name}`} onClick={() => setOpen(true)}>
            <Pencil />
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Pencil /> Edit agent
          </Button>
        )
      ) : (
        <Button size="sm" onClick={() => setOpen(true)}>
          <UserPlus /> New agent
        </Button>
      )}
      {open && <UserForm user={user} ctx={ctx} onClose={() => setOpen(false)} />}
    </>
  );
}

const ROLE_OPTIONS: { id: Role; name: string; description: string }[] = [
  { id: "super_admin", name: "Super Admin", description: "Full access to every brand, approvals, agents and configuration." },
  { id: "sales_agent", name: "Sales Agent", description: "Own customers, sales, billing and recharge requests in assigned brands." },
];

function UserForm({ user, ctx, onClose }: { user?: UserEditable; ctx: Ctx; onClose: () => void }) {
  const router = useRouter();
  const self = user?.id === ctx.viewerId;
  const [v, setV] = useState({
    name: user?.name ?? "",
    email: user?.email ?? "",
    role: (user?.role ?? "sales_agent") as Role,
    status: user?.status ?? "active",
    brandIds: user?.brandIds ?? [],
    password: "",
  });
  useCloseOnHide(onClose);
  const create = useServerAction(createUserAction, {
    onSuccess: (res) => {
      onClose();
      if (res.data?.id) router.push(`/admin/agents/${res.data.id}`);
    },
  });
  const update = useServerAction(updateUserAction, { onSuccess: onClose });
  const { pending, errors } = user ? update : create;
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV((p) => ({ ...p, [k]: val }));
  const isAdmin = v.role === "super_admin";
  const suspending = user && user.status !== "suspended" && v.status === "suspended";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const common = { name: v.name, email: v.email, role: v.role, brandIds: isAdmin ? [] : v.brandIds };
    if (user) update.run(user.id, { ...common, status: v.status });
    else create.run({ ...common, password: v.password });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{user ? `Edit ${user.name}` : "New agent"}</DialogTitle>
          <DialogDescription>
            {user ? (
              <>
                <span className="font-mono">{user.id}</span> · created {user.createdLabel}. Changes apply on the agent&apos;s next page load.
              </>
            ) : (
              "Create an agent account. Share the temporary password securely; the agent should change it after first sign-in."
            )}
          </DialogDescription>
        </DialogHeader>
        <form id="user-form" className="grid gap-4" onSubmit={submit} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" htmlFor="u-name" error={errors.name} required>
              <Input {...invalid("u-name", errors.name)} value={v.name} onChange={(e) => set("name", e.target.value)} maxLength={80} autoComplete="off" />
            </Field>
            <Field label="Email" htmlFor="u-email" error={errors.email} hint="Used to sign in. Must be unique." required>
              <Input {...invalid("u-email", errors.email)} type="email" value={v.email} onChange={(e) => set("email", e.target.value)} maxLength={200} autoComplete="off" />
            </Field>
          </div>

          {!user && (
            <Field label="Temporary password" htmlFor="u-pass" error={errors.password} required>
              <PasswordInput id="u-pass" value={v.password} onChange={(p) => set("password", p)} error={errors.password} />
            </Field>
          )}

          <fieldset className="grid gap-1.5" aria-invalid={errors.role?.length ? true : undefined}>
            <legend className="mb-1.5 text-xs font-medium">
              Role <span className="text-destructive">*</span>
            </legend>
            <RadioGroup value={v.role} onValueChange={(r) => set("role", r as Role)} className="grid gap-2 sm:grid-cols-2" disabled={self}>
              {ROLE_OPTIONS.map((r) => (
                <label key={r.id} htmlFor={`role-${r.id}`} className={cn("flex cursor-pointer gap-3 rounded-lg border p-3", v.role === r.id && "border-foreground", self && "cursor-not-allowed opacity-70")}>
                  <RadioGroupItem id={`role-${r.id}`} value={r.id} aria-label={r.name} className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-medium">{r.name}</span>
                    <span className="block text-xs text-muted-foreground">{r.description}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
            {self && <p className="text-xs text-muted-foreground">You cannot change your own role.</p>}
            {errors.role?.[0] && <p className="text-xs text-destructive">{errors.role[0]}</p>}
          </fieldset>

          {isAdmin ? (
            <p className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">Super Admins always have access to all three brands.</p>
          ) : (
            <CheckboxGroup
              legend="Assigned brands"
              columns={3}
              options={ctx.brands.map((b) => ({ value: b.id, label: b.name }))}
              value={v.brandIds}
              onChange={(next) => set("brandIds", next)}
              error={errors.brandIds}
              hint="The agent only sees customers, sales and records of these brands."
            />
          )}

          {user && (
            <Field label="Account status" htmlFor="u-status" error={errors.status} hint={self ? "You cannot suspend your own account." : "Suspending signs the user out everywhere."}>
              <Select value={v.status} onValueChange={(s) => set("status", s as "active" | "suspended")} disabled={self}>
                <SelectTrigger id="u-status" className="w-full sm:w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}

          {suspending && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              Suspending {user?.name} blocks sign-in and immediately revokes every active session. Their records and history are kept.
            </p>
          )}
          {errors.form?.[0] && <p className="text-xs text-destructive">{errors.form[0]}</p>}
        </form>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form="user-form" size="sm" variant={suspending ? "destructive" : "default"} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}
            {user ? (suspending ? "Suspend & save" : "Save changes") : "Create agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ResetPasswordDialog({ userId, name, disabled }: { userId: string; name: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={disabled} title={disabled ? "Use your own account settings to change your password" : undefined}>
        <KeyRound /> Reset password
      </Button>
      {open && <ResetForm userId={userId} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function ResetForm({ userId, name, onClose }: { userId: string; name: string; onClose: () => void }) {
  const [pw, setPw] = useState("");
  const { run, pending, errors } = useServerAction(resetPasswordAction, { onSuccess: onClose });
  useCloseOnHide(onClose);
  const err = errors.form ?? errors[""] ?? (Object.keys(errors).length ? Object.values(errors)[0] : undefined);
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset password — {name}</DialogTitle>
          <DialogDescription>Sets a new temporary password, clears any lockout and signs the agent out of every session.</DialogDescription>
        </DialogHeader>
        <form
          id="reset-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            run(userId, pw);
          }}
        >
          <Field label="New temporary password" htmlFor="r-pass" error={err} required>
            <PasswordInput id="r-pass" value={pw} onChange={setPw} error={err} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form="reset-form" size="sm" variant="destructive" disabled={pending || !pw}>
            {pending && <Loader2 className="animate-spin" />} Reset & sign out
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
