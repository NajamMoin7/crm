"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "@/lib/nav";
import { cn } from "@/lib/utils";

/** Renders only the routes the server says this user may open. */
export function SidebarNav({ allowed, onNavigate }: { allowed: string[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  const allowedSet = new Set(allowed);
  // Longest matching href wins so /recharge/register doesn't also light up /recharge.
  const active = allowed
    .filter((h) => pathname === h || pathname.startsWith(h + "/"))
    .sort((a, b) => b.length - a.length)[0];

  return (
    <nav aria-label="Main" className="flex flex-col gap-5 px-3 py-4">
      {NAV.map((group) => {
        const items = group.items.filter((i) => allowedSet.has(i.href));
        if (items.length === 0) return null;
        return (
          <div key={group.label}>
            <p className="mb-1.5 px-2 text-[10px] font-medium tracking-[0.2em] text-muted-foreground/80 uppercase">{group.label}</p>
            <ul className="space-y-0.5">
              {items.map((item) => {
                const isActive = item.href === active;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-sidebar-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                        isActive && "bg-sidebar-accent font-medium text-sidebar-accent-foreground shadow-[inset_2px_0_0_var(--sidebar-primary)]",
                      )}
                    >
                      <item.icon className={cn("size-4 shrink-0", isActive ? "text-sidebar-accent-foreground" : "text-muted-foreground")} aria-hidden />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
