import type { Metadata } from "next";
import Link from "next/link";
import { UserRound, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/crm/page-header";
import { FilterBar } from "@/components/crm/filter-bar";
import { Pagination } from "@/components/crm/pagination";
import { EmptyState } from "@/components/crm/empty-state";
import { BrandBadge } from "@/components/crm/brand-badge";
import { StatusBadge } from "@/components/crm/status-badge";
import { ActionButton } from "@/components/crm/action-button";
import { AccessDenied } from "@/components/crm/access-denied";
import { UserDialog } from "@/components/admin/user-dialogs";
import { USER_STATUS } from "@/components/admin/vocab";
import { can, requireViewer } from "@/lib/auth/viewer";
import { getUserFormContext, listUsers } from "@/lib/data/admin";
import { getBrandMap } from "@/lib/data/reference";
import { ROLES } from "@/lib/domain/permissions";
import { fmtDate, fmtDateTime, fmtNumber } from "@/lib/format";
import { setUserStatusAction } from "../actions";

export const metadata: Metadata = { title: "Agents" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim().slice(0, 80) || null;

export default async function AgentsPage(props: PageProps<"/admin/agents">) {
  const viewer = await requireViewer();
  if (!can(viewer, "users.manage")) return <AccessDenied />;
  const sp = await props.searchParams;
  const f = {
    q: one(sp.q) ?? "",
    role: one(sp.role),
    status: one(sp.status),
    brand: one(sp.brand),
    page: Math.max(1, Number.parseInt(one(sp.page) ?? "1", 10) || 1),
  };
  const [{ rows, total }, ctx, brandMap] = await Promise.all([listUsers(f), getUserFormContext(viewer), getBrandMap()]);
  const activeCount = rows.filter((u) => u.status === "active").length;

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Agents"
        description="Create the accounts your team signs in with, assign their brands, reset passwords and switch access on or off."
      />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FilterBar
          fields={[
            { kind: "search", placeholder: "Name or email" },
            { kind: "select", param: "role", label: "Role", options: Object.entries(ROLES).map(([value, r]) => ({ value, label: r.name })), allLabel: "All roles" },
            { kind: "select", param: "status", label: "Status", options: Object.entries(USER_STATUS).map(([value, v]) => ({ value, label: v.label })) },
          ]}
        />
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{fmtNumber(activeCount)} active</span>
          <UserDialog ctx={ctx} />
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={Users} title="No accounts match these filters" />
      ) : (
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-3" aria-label="Accounts">
          {rows.map((u) => {
            const role = u.roleIds.includes("super_admin") ? "super_admin" : "sales_agent";
            const self = u.id === viewer.id;
            return (
              <li key={u.id} data-user={u.email} className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs md:flex-row md:items-center">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-full border border-primary/40 text-primary" aria-hidden>
                  <UserRound className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/admin/agents/${u.id}`} className="font-medium hover:text-primary">
                      {u.name}
                    </Link>
                    {role === "super_admin" ? (
                      <span className="inline-flex h-5 items-center rounded-full bg-primary px-2 text-[10px] font-semibold tracking-wider text-primary-foreground uppercase">
                        Super Admin
                      </span>
                    ) : (
                      <StatusBadge tone="neutral" label="Sales Agent" />
                    )}
                    <StatusBadge tone={u.status === "active" ? "success" : "danger"} label={USER_STATUS[u.status]?.label ?? u.status} />
                    {self && <span className="text-xs text-muted-foreground">(you)</span>}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {u.email} · {u.lastLoginAt ? `last signed in ${fmtDateTime(u.lastLoginAt)}` : "never signed in"} · created {fmtDate(u.createdAt)}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {u.brandIds.map((b) => (
                      <BrandBadge key={b} brand={brandMap.get(b)} />
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1 md:justify-end">
                  <ActionButton
                    variant="ghost"
                    disabled={self}
                    label={u.status === "active" ? "Deactivate" : "Activate"}
                    confirmTitle={u.status === "active" ? `Deactivate ${u.name}?` : `Activate ${u.name}?`}
                    confirmDescription={
                      u.status === "active"
                        ? "They are signed out immediately and can't sign in. Their records and history are kept."
                        : "They can sign in again with their existing password."
                    }
                    confirmLabel={u.status === "active" ? "Deactivate" : "Activate"}
                    destructive={u.status === "active"}
                    action={setUserStatusAction.bind(null, u.id, u.status === "active" ? "suspended" : "active")}
                  />
                  <Button asChild variant="ghost" size="sm">
                    <Link href={`/admin/agents/${u.id}`}>Profile</Link>
                  </Button>
                  <UserDialog
                    triggerVariant="text"
                    ctx={ctx}
                    user={{
                      id: u.id,
                      name: u.name,
                      email: u.email,
                      status: u.status === "suspended" ? "suspended" : "active",
                      role,
                      brandIds: u.brandIds,
                      createdLabel: fmtDate(u.createdAt),
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 overflow-hidden rounded-xl border bg-card">
        <Pagination basePath="/admin/agents" searchParams={sp} page={f.page} total={total} />
      </div>
    </>
  );
}
