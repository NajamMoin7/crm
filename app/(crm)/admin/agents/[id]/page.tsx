import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/crm/page-header";
import { DetailList, SectionCard } from "@/components/crm/section-card";
import { StatusBadge, VocabBadge } from "@/components/crm/status-badge";
import { BrandBadge } from "@/components/crm/brand-badge";
import { EmptyState } from "@/components/crm/empty-state";
import { AccessDenied } from "@/components/crm/access-denied";
import { ResetPasswordDialog, UserDialog } from "@/components/admin/user-dialogs";
import { USER_STATUS } from "@/components/admin/vocab";
import { can, requireViewer } from "@/lib/auth/viewer";
import { getUserDetail, getUserFormContext } from "@/lib/data/admin";
import { getBrandMap } from "@/lib/data/reference";
import { ROLES } from "@/lib/domain/permissions";
import { fmtDate, fmtDateTime, fmtRelative } from "@/lib/format";

export const metadata: Metadata = { title: "Agent" };

export default async function AgentDetailPage(props: PageProps<"/admin/agents/[id]">) {
  const viewer = await requireViewer();
  if (!can(viewer, "users.manage")) return <AccessDenied />;
  const { id } = await props.params;
  const now = new Date();
  const [detail, ctx, brandMap] = await Promise.all([getUserDetail(decodeURIComponent(id)), getUserFormContext(viewer), getBrandMap()]);
  if (!detail) notFound();
  const { user, roleIds, brandIds, sessions, audit } = detail;
  const role = roleIds.includes("super_admin") ? "super_admin" : "sales_agent";
  const self = user.id === viewer.id;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Agents", href: "/admin/agents" }, { label: user.name }]}
        title={user.name}
        description={ROLES[role].name}
        meta={
          <>
            <span className="font-mono text-xs text-muted-foreground">{user.id}</span>
            <VocabBadge map={USER_STATUS} value={user.status} />
            {user.lockedUntil && user.lockedUntil > now && <StatusBadge tone="warning" label={`Locked until ${fmtDateTime(user.lockedUntil)}`} />}
            {self && <span className="text-xs text-muted-foreground">This is you</span>}
          </>
        }
        actions={
          <>
            <ResetPasswordDialog userId={user.id} name={user.name} disabled={self} />
            <UserDialog
              ctx={ctx}
              user={{
                id: user.id,
                name: user.name,
                email: user.email,
                status: user.status === "suspended" ? "suspended" : "active",
                role,
                brandIds,
                createdLabel: fmtDate(user.createdAt),
              }}
            />
          </>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 content-start gap-6">
          <SectionCard title="Account">
            <DetailList
              items={[
                { label: "Email", value: user.email },
                { label: "Created", value: fmtDate(user.createdAt) },
                { label: "Last sign-in", value: user.lastLoginAt ? `${fmtDateTime(user.lastLoginAt)} (${fmtRelative(user.lastLoginAt, now)})` : "Never" },
                { label: "Failed sign-ins (current window)", value: <span className="tabular">{user.failedLoginCount}</span> },
                { label: "Password", value: "Stored as a bcrypt hash — never displayed" },
              ]}
            />
          </SectionCard>
          <SectionCard title="Access">
            <DetailList
              columns={1}
              items={[
                { label: "Role", value: `${ROLES[role].name} — ${ROLES[role].description}` },
                {
                  label: "Assigned brands",
                  value: brandIds.length ? (
                    <div className="flex flex-wrap gap-1">
                      {brandIds.map((b) => (
                        <BrandBadge key={b} brand={brandMap.get(b)} full />
                      ))}
                    </div>
                  ) : (
                    "None"
                  ),
                },
              ]}
            />
          </SectionCard>
          <SectionCard title="Active sessions" description="Revoked automatically on suspension or password reset.">
            {sessions.length === 0 ? (
              <EmptyState title="No active sessions" />
            ) : (
              <ul className="divide-y text-sm">
                {sessions.map((s, i) => (
                  <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                    <span className="min-w-0 truncate text-xs text-muted-foreground">{s.userAgent ?? "Unknown device"}</span>
                    <span className="text-xs tabular">
                      {s.ip ?? "—"} · last seen {fmtRelative(s.lastSeenAt, now)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
        <SectionCard title="Audit trail" description="Actions performed by this agent and changes made to their account.">
          {audit.length === 0 ? (
            <EmptyState title="No activity recorded" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Event</TableHead>
                  <TableHead className="pr-4 text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {audit.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="pl-4">
                      <div className="font-mono text-[11px] text-muted-foreground">{a.action}</div>
                      <div className="text-sm">{a.summary}</div>
                      <div className="text-xs text-muted-foreground">
                        {a.actorId === user.id ? "By this agent" : `By ${a.actor ?? "system"}`}
                        {a.entityId && a.entityType !== "user" ? ` · ${a.entityType} ${a.entityId}` : ""}
                      </div>
                    </TableCell>
                    <TableCell className="pr-4 text-right text-xs whitespace-nowrap text-muted-foreground">{fmtDateTime(a.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {can(viewer, "audit.view") && (
            <div className="border-t px-4 py-2.5 text-right">
              <Link href={`/admin/activity?actor=${user.id}`} className="text-xs text-primary hover:underline">
                Open in activity log →
              </Link>
            </div>
          )}
        </SectionCard>
      </div>
    </>
  );
}
