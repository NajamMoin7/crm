import type { Metadata } from "next";
import { Suspense } from "react";
import { Layers, ShieldCheck } from "lucide-react";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

const DEMO_ACCOUNTS = [
  { email: "admin@crm.demo", role: "Super Admin — all brands" },
  { email: "agent@crm.demo", role: "Sales Agent — Logic Tech Digital, Xpectra" },
  { email: "agent2@crm.demo", role: "Sales Agent — Xpectra, CoreByte" },
];

export default function LoginPage(props: PageProps<"/login">) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_480px]">
      <div className="relative hidden flex-col justify-between overflow-hidden border-r bg-sidebar p-10 lg:flex">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Layers className="size-5" />
          </span>
          <span className="text-base font-semibold">Unified CRM</span>
        </div>
        <div className="max-w-lg space-y-5">
          <h1 className="text-3xl font-semibold tracking-tight text-balance">
            One internal workspace for Logic Tech Digital, Xpectra and CoreByte.
          </h1>
          <p className="text-muted-foreground">
            Shared customers, sales, billing and Recharge / Chargeback operations — with every record keeping its own brand and legal
            entity.
          </p>
          <div className="flex flex-wrap gap-2 text-xs">
            {[
              ["LTD", "Logic Tech Digital"],
              ["XPC", "Xpectra"],
              ["CBT", "CoreByte"],
            ].map(([code, name]) => (
              <span key={code} className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1">
                <span className="size-2 rounded-full" style={{ background: `var(--brand-${code})` }} />
                {name}
              </span>
            ))}
          </div>
        </div>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="size-4" /> Internal use only. Access is logged and audited.
        </p>
      </div>
      <div className="flex flex-col justify-center gap-8 px-6 py-10 sm:px-10">
        <div className="space-y-1.5">
          <h2 className="text-xl font-semibold">Sign in</h2>
          <p className="text-sm text-muted-foreground">Use your employee account. One login covers every brand you are authorised for.</p>
        </div>
        <Suspense>
          <LoginForm searchParams={props.searchParams} />
        </Suspense>
        <div className="rounded-xl border border-dashed bg-muted/40 p-4">
          <p className="text-xs font-medium">Local demo accounts — password <code className="rounded bg-background px-1 py-0.5">Demo@2026!</code> (change before production)</p>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {DEMO_ACCOUNTS.map((a) => (
              <li key={a.email} className="flex justify-between gap-3">
                <code className="text-foreground">{a.email}</code>
                <span className="text-right">{a.role}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
