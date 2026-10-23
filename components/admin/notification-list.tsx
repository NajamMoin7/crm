"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, CheckCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { markAllNotificationsRead, markNotificationRead } from "@/app/(crm)/shell-actions";
import { cn } from "@/lib/utils";

export type NotificationItem = { id: string; kind: string; title: string; body: string; href: string | null; read: boolean; when: string; at: string };

const KIND: Record<string, string> = {
  approval_needed: "Approval needed",
  case_update: "Case update",
  assignment: "Assignment",
  integration: "Integration",
  system: "System",
};

export function MarkAllReadButton({ disabled }: { disabled: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled || pending}
      onClick={() =>
        start(async () => {
          await markAllNotificationsRead();
          toast.success("All notifications marked as read");
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <CheckCheck />} Mark all read
    </Button>
  );
}

export function NotificationList({ items }: { items: NotificationItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const open = (n: NotificationItem) =>
    start(async () => {
      if (!n.read) await markNotificationRead(n.id);
      if (n.href) router.push(n.href);
    });

  return (
    <ul className="divide-y" aria-busy={pending || undefined}>
      {items.map((n) => (
        <li key={n.id} className={cn("group relative flex gap-3 px-4 py-3", !n.read && "bg-primary/[0.03]")} data-notification={n.id}>
          <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-primary")} aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <button
                type="button"
                onClick={() => open(n)}
                className={cn("text-left text-sm hover:underline focus-visible:underline focus-visible:outline-none", !n.read && "font-semibold")}
              >
                {n.title}
                {!n.read && <span className="sr-only"> (unread)</span>}
              </button>
              <span className="rounded border px-1.5 text-[10px] text-muted-foreground">{KIND[n.kind] ?? n.kind}</span>
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">{n.body}</p>
            <time dateTime={n.at} className="text-xs text-muted-foreground">
              {n.when}
            </time>
          </div>
          {!n.read && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Mark “${n.title}” as read`}
              title="Mark as read"
              className="shrink-0"
              onClick={() => start(() => markNotificationRead(n.id))}
            >
              <Check />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

