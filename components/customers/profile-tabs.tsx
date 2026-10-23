"use client";

import { useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type ProfileTab = { value: string; label: string; count?: number; content: React.ReactNode };

/**
 * Tabs whose selection lives in `?tab=`. Uses the native History API (which
 * Next syncs with useSearchParams) so switching never refetches the page.
 */
export function ProfileTabs({ tabs, defaultTab }: { tabs: ProfileTab[]; defaultTab: string }) {
  const params = useSearchParams();
  const requested = params.get("tab");
  const value = tabs.some((t) => t.value === requested) ? requested! : defaultTab;

  const onChange = (next: string) => {
    const sp = new URLSearchParams(params.toString());
    if (next === defaultTab) sp.delete("tab");
    else sp.set("tab", next);
    const qs = sp.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  };

  return (
    <Tabs value={value} onValueChange={onChange} className="gap-4">
      <div className="-mx-3 overflow-x-auto px-3 sm:mx-0 sm:px-0">
        <TabsList variant="line" className="h-9 w-max border-b-0">
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="px-2.5">
              {t.label}
              {t.count !== undefined && <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground tabular">{t.count}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {tabs.map((t) => (
        <TabsContent key={t.value} value={t.value} className="space-y-4">
          {t.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
