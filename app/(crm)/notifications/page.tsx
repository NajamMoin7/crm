import type { Metadata } from "next";
import Link from "next/link";
import { Bell } from "lucide-react";
import { PageHeader } from "@/components/crm/page-header";
import { SectionCard } from "@/components/crm/section-card";
import { Pagination } from "@/components/crm/pagination";
import { EmptyState } from "@/components/crm/empty-state";
import { MarkAllReadButton, NotificationList } from "@/components/admin/notification-list";
import { requireViewer } from "@/lib/auth/viewer";
import { listNotifications } from "@/lib/data/admin";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage(props: PageProps<"/notifications">) {
  const viewer = await requireViewer();
  const sp = await props.searchParams;
  const now = new Date();
  const unreadOnly = (Array.isArray(sp.filter) ? sp.filter[0] : sp.filter) === "unread";
  const page = Math.max(1, Number.parseInt(String(Array.isArray(sp.page) ? sp.page[0] : (sp.page ?? "1")), 10) || 1);
  const { rows, total, unread } = await listNotifications(viewer, { unread: unreadOnly, page });

  const tabs = [
    { label: "All", href: "/notifications", active: !unreadOnly },
    { label: `Unread (${unread})`, href: "/notifications?filter=unread", active: unreadOnly },
  ];

  return (
    <>
      <PageHeader eyebrow="Inbox" title="Notifications" description="Approvals, case updates, assignments and system messages addressed to you." actions={<MarkAllReadButton disabled={unread === 0} />} />
      <SectionCard
        actions={
          <nav aria-label="Filter notifications" className="flex rounded-lg border bg-muted/40 p-0.5">
            {tabs.map((t) => (
              <Link
                key={t.href}
                href={t.href}
                aria-current={t.active ? "page" : undefined}
                className={cn("rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground", t.active && "bg-background text-foreground shadow-xs")}
              >
                {t.label}
              </Link>
            ))}
          </nav>
        }
        title={unreadOnly ? "Unread" : "All notifications"}
      >
        {rows.length === 0 ? (
          <EmptyState icon={Bell} title={unreadOnly ? "You're all caught up" : "No notifications yet"} description={unreadOnly ? "No unread notifications." : undefined} />
        ) : (
          <NotificationList
            items={rows.map((n) => ({
              id: n.id,
              kind: n.kind,
              title: n.title,
              body: n.body,
              href: n.href,
              read: !!n.readAt,
              when: `${fmtRelative(n.createdAt, now)} · ${fmtDateTime(n.createdAt)}`,
              at: n.createdAt.toISOString(),
            }))}
          />
        )}
        <Pagination basePath="/notifications" searchParams={sp} page={page} total={total} />
      </SectionCard>
    </>
  );
}
