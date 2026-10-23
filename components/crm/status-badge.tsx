import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/domain/vocab";

const TONES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground ring-border",
  info: "bg-sky-500/10 text-sky-700 ring-sky-600/20 dark:text-sky-300 dark:ring-sky-400/25",
  success: "bg-emerald-500/10 text-emerald-700 ring-emerald-600/20 dark:text-emerald-300 dark:ring-emerald-400/25",
  warning: "bg-amber-500/12 text-amber-800 ring-amber-600/25 dark:text-amber-300 dark:ring-amber-400/25",
  danger: "bg-red-500/10 text-red-700 ring-red-600/20 dark:text-red-300 dark:ring-red-400/25",
  violet: "bg-violet-500/10 text-violet-700 ring-violet-600/20 dark:text-violet-300 dark:ring-violet-400/25",
};
const DOTS: Record<Tone, string> = {
  neutral: "bg-muted-foreground/60",
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
  violet: "bg-violet-500",
};

export function StatusBadge({ tone, label, className }: { tone: Tone; label: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[10px] font-semibold tracking-wider whitespace-nowrap uppercase ring-1 ring-inset",
        TONES[tone],
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", DOTS[tone])} />
      {label}
    </span>
  );
}

export function VocabBadge({ map, value }: { map: Record<string, { label: string; tone: Tone }>; value: string }) {
  const v = map[value] ?? { label: value, tone: "neutral" as Tone };
  return <StatusBadge tone={v.tone} label={v.label} />;
}
