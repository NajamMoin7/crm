"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { useTheme } from "next-themes";
import {
  Bell,
  Check,
  ChevronsUpDown,
  Laptop,
  Layers,
  LogOut,
  Menu,
  Moon,
  Search,
  Sun,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarNav } from "./sidebar-nav";
import { BrandBadge, BrandMark, type BrandLite } from "@/components/crm/brand-badge";
import { logout, markAllNotificationsRead, markNotificationRead, setActiveBrand } from "@/app/(crm)/shell-actions";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------ mobile nav */

export function MobileNav({ allowed }: { allowed: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 p-0">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <Logo /> Unified CRM
          </SheetTitle>
          <SheetDescription className="sr-only">Main navigation</SheetDescription>
        </SheetHeader>
        <ScrollArea className="h-[calc(100dvh-60px)]">
          <SidebarNav allowed={allowed} onNavigate={() => setOpen(false)} />
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

export function Logo() {
  return (
    <span className="inline-flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
      <Layers className="size-4" aria-hidden />
    </span>
  );
}

/* --------------------------------------------------------- global search */

type SearchGroup = { type: string; label: string; items: { id: string; title: string; subtitle: string; href: string; brand?: BrandLite | null }[] };

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal });
        if (res.ok) setGroups((await res.json()).groups);
      } catch {
        /* aborted */
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const visibleGroups = q.trim().length < 2 ? [] : groups;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 w-full max-w-md items-center gap-2 rounded-lg border bg-background px-2.5 text-sm text-muted-foreground shadow-xs transition-colors hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        aria-label="Search customers, invoices, transactions"
      >
        <Search className="size-4" aria-hidden />
        <span className="truncate">Search customers, invoices, cases…</span>
        <kbd className="ml-auto hidden rounded border bg-muted px-1.5 font-mono text-[10px] sm:inline">Ctrl K</kbd>
      </button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Global search" description="Search records you have access to">
        <CommandInput placeholder="Customer ID, email, phone, invoice #, transaction or case ID…" value={q} onValueChange={setQ} />
        <CommandList>
          {q.trim().length < 2 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">Type at least 2 characters.</p>
          ) : (
            <CommandEmpty>{loading ? "Searching…" : "No matching records you can access."}</CommandEmpty>
          )}
          {visibleGroups.map((g) => (
            <CommandGroup key={g.type} heading={g.label}>
              {g.items.map((item) => (
                <CommandItem
                  key={item.href}
                  value={`${g.type}-${item.id}-${item.title}`}
                  onSelect={() => {
                    setOpen(false);
                    router.push(item.href);
                  }}
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{item.title}</span>
                    <span className="truncate text-xs text-muted-foreground">{item.subtitle}</span>
                  </div>
                  {item.brand && <BrandBadge brand={item.brand} />}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
    </>
  );
}

/* ------------------------------------------------------- brand switcher */

export function BrandSwitcher({ brands, active }: { brands: BrandLite[]; active: string }) {
  const [pending, start] = useTransition();
  const current = brands.find((b) => b.id === active);
  if (brands.length <= 1) return current ? <BrandBadge brand={current} full /> : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={cn("gap-2", pending && "opacity-70")} aria-label="Active brand">
          {current ? <BrandMark brand={current} /> : <Layers className="size-4 text-muted-foreground" />}
          <span className="hidden max-w-36 truncate md:inline">{current ? current.name : "All brands"}</span>
          <ChevronsUpDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Active brand context</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={active} onValueChange={(v) => start(() => setActiveBrand(v))}>
          <DropdownMenuRadioItem value="all">
            <Layers className="size-4 text-muted-foreground" /> All authorised brands
          </DropdownMenuRadioItem>
          {brands.map((b) => (
            <DropdownMenuRadioItem key={b.id} value={b.id}>
              <BrandMark brand={b} /> {b.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* -------------------------------------------------------- notifications */

export type NotificationItem = { id: string; title: string; body: string; href: string | null; read: boolean; when: string };

export function NotificationsMenu({ items, unread }: { items: NotificationItem[]; unread: number }) {
  const [open, setOpen] = useState(false);
  const [, start] = useTransition();
  const router = useRouter();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}>
          <Bell />
          {unread > 0 && (
            <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <p className="text-sm font-semibold">Notifications</p>
          {unread > 0 && (
            <Button variant="ghost" size="xs" onClick={() => start(() => markAllNotificationsRead())}>
              <Check /> Mark all read
            </Button>
          )}
        </div>
        <ul className="max-h-96 overflow-y-auto">
          {items.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted-foreground">You’re all caught up.</li>}
          {items.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className="flex w-full gap-2 border-b px-3 py-2.5 text-left last:border-0 hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
                onClick={() => {
                  setOpen(false);
                  if (!n.read) start(() => markNotificationRead(n.id));
                  if (n.href) router.push(n.href);
                }}
              >
                <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-sky-500")} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{n.title}</span>
                  <span className="line-clamp-2 block text-xs text-muted-foreground">{n.body}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{n.when}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t p-1.5">
          <Button asChild variant="ghost" size="sm" className="w-full" onClick={() => setOpen(false)}>
            <Link href="/notifications">View all notifications</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ---------------------------------------------------------- theme + user */

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Theme">
          <Sun className="dark:hidden" />
          <Moon className="hidden dark:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">
            <Sun /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Laptop /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function UserMenu({ name, email, role, initials }: { name: string; email: string; role: string; initials: string }) {
  const [pending, start] = useTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-9 gap-2 px-1.5" aria-label="Account menu">
          <span className="flex size-7 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
            {initials}
          </span>
          <span className="hidden flex-col items-start leading-tight xl:flex">
            <span className="text-xs font-medium">{name}</span>
            <span className="text-[11px] text-muted-foreground">{role}</span>
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <p className="text-sm font-medium">{name}</p>
          <p className="truncate text-xs text-muted-foreground">{email}</p>
          <p className="mt-1 text-xs">
            Role: <span className="font-medium">{role}</span>
          </p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/dashboard">
            <UserRound /> Dashboard
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/notifications">
            <Bell /> Notifications
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={pending} onSelect={() => start(() => logout())}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
