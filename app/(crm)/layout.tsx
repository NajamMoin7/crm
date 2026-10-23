import { Suspense } from "react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarNav } from "@/components/shell/sidebar-nav";
import {
  BrandSwitcher,
  GlobalSearch,
  Logo,
  MobileNav,
  NotificationsMenu,
  ThemeToggle,
  UserMenu,
} from "@/components/shell/topbar-controls";
import { requireViewer } from "@/lib/auth/viewer";
import { getActiveBrand } from "@/lib/auth/scope";
import { allowedHrefs } from "@/lib/nav";
import { getViewerBrands } from "@/lib/data/reference";
import { getDb } from "@/lib/db";
import { fmtRelative, initials } from "@/lib/format";

/**
 * Authenticated application shell. The frame is static; everything that
 * depends on the session (navigation, brand context, notifications) streams
 * in behind its own Suspense boundary, and each page has its own loading UI.
 */
export default function CrmLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r bg-sidebar lg:flex">
        <Link href="/" className="flex h-14 shrink-0 items-center gap-2.5 border-b px-4">
          <Logo />
          <span className="leading-tight">
            <span className="eyebrow block text-[11px] text-primary">Unified CRM</span>
            <span className="block text-[10px] tracking-[0.18em] text-muted-foreground uppercase">LTD · Xpectra · CoreByte</span>
          </span>
        </Link>
        <ScrollArea className="min-h-0 flex-1">
          <Suspense fallback={<NavSkeleton />}>
            <SidebarSlot />
          </Suspense>
        </ScrollArea>
        <div className="border-t px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-amber-700 dark:text-amber-400">Demo environment</span> — fictional data, simulated
          payments & integrations. No production database is connected.
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-4">
          <Suspense fallback={<TopbarSkeleton />}>
            <TopbarSlot />
          </Suspense>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1500px] flex-1 px-3 py-5 sm:px-6 sm:py-6">
          {children}
        </main>
      </div>
    </div>
  );
}

async function SidebarSlot() {
  const viewer = await requireViewer();
  return <SidebarNav allowed={allowedHrefs(viewer.permissions)} />;
}

async function TopbarSlot() {
  const viewer = await requireViewer();
  const C = await getDb();
  const [brandList, active, recent, unread] = await Promise.all([
    getViewerBrands(viewer),
    getActiveBrand(viewer),
    C.notifications.find({ userId: viewer.id }, { sort: { createdAt: -1 }, limit: 8 }).toArray(),
    C.notifications.countDocuments({ userId: viewer.id, readAt: null }),
  ]);
  const now = new Date();
  return (
    <>
      <MobileNav allowed={allowedHrefs(viewer.permissions)} />
      <BrandSwitcher brands={brandList} active={active} />
      <div className="flex min-w-0 flex-1 justify-center px-1">
        <GlobalSearch />
      </div>
      <NotificationsMenu
        unread={unread}
        items={recent.map((n) => ({
          id: n.id,
          title: n.title,
          body: n.body,
          href: n.href,
          read: !!n.readAt,
          when: fmtRelative(n.createdAt, now),
        }))}
      />
      <ThemeToggle />
      <UserMenu name={viewer.name} email={viewer.email} role={viewer.roleNames.join(", ")} initials={initials(viewer.name)} />
    </>
  );
}

function NavSkeleton() {
  return (
    <div className="space-y-5 px-3 py-4">
      {[4, 6, 5].map((n, g) => (
        <div key={g} className="space-y-1.5">
          <Skeleton className="mx-2 h-3 w-24" />
          {Array.from({ length: n }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}

function TopbarSkeleton() {
  return (
    <div className="flex w-full items-center gap-3">
      <Skeleton className="h-8 w-36" />
      <Skeleton className="mx-auto h-8 w-full max-w-md" />
      <Skeleton className="size-8 rounded-full" />
      <Skeleton className="size-8 rounded-full" />
    </div>
  );
}
