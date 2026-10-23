import { fmtDateTime } from "@/lib/format";
import { EmptyState } from "./empty-state";
import { History } from "lucide-react";

export type TimelineEntry = {
  id: string | number;
  title: React.ReactNode;
  body?: React.ReactNode;
  actor?: string | null;
  at: Date;
  tone?: "default" | "success" | "danger" | "warning";
};

const DOT = {
  default: "bg-muted-foreground/50",
  success: "bg-emerald-500",
  danger: "bg-red-500",
  warning: "bg-amber-500",
};

export function Timeline({ entries, empty = "No activity recorded yet." }: { entries: TimelineEntry[]; empty?: string }) {
  if (entries.length === 0) return <EmptyState icon={History} title={empty} />;
  return (
    <ol className="relative space-y-5 p-4 pl-8">
      <span aria-hidden className="absolute top-5 bottom-5 left-[19px] w-px bg-border" />
      {entries.map((e) => (
        <li key={e.id} className="relative">
          <span aria-hidden className={`absolute top-1.5 -left-[17px] size-2.5 rounded-full ring-4 ring-card ${DOT[e.tone ?? "default"]}`} />
          <div className="text-sm">{e.title}</div>
          {e.body && <div className="mt-0.5 text-sm text-muted-foreground">{e.body}</div>}
          <div className="mt-0.5 text-xs text-muted-foreground">
            {e.actor ? `${e.actor} · ` : ""}
            <time dateTime={e.at.toISOString()}>{fmtDateTime(e.at)}</time>
          </div>
        </li>
      ))}
    </ol>
  );
}
