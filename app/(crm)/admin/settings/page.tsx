import type { Metadata } from "next";
import Link from "next/link";
import { Cable, ChevronRight, Database, ServerCog } from "lucide-react";
import { PageHeader } from "@/components/crm/page-header";
import { DetailList, SectionCard } from "@/components/crm/section-card";
import { StatusBadge } from "@/components/crm/status-badge";
import { AccessDenied } from "@/components/crm/access-denied";
import { SettingsForm } from "@/components/admin/settings-form";
import { can, requireViewer } from "@/lib/auth/viewer";
import { listSettings } from "@/lib/data/admin";
import { settingMetaFor } from "@/lib/services/admin";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "settings.manage")) return <AccessDenied />;
  const rows = await listSettings();
  const data = rows.map((r) => ({
    key: r.key,
    value: r.value,
    description: r.description,
    updatedAt: r.updatedAt.toISOString(),
    updatedByName: r.updatedByName,
    meta: settingMetaFor(r.key, r.value),
  }));
  const order = ["Recharge / chargeback policy", "Security", "Reporting"];
  data.sort((a, b) => {
    const ga = order.indexOf(a.meta.group);
    const gb = order.indexOf(b.meta.group);
    return (ga < 0 ? 99 : ga) - (gb < 0 ? 99 : gb) || a.key.localeCompare(b.key);
  });

  return (
    <>
      <PageHeader eyebrow="Administration" title="Settings" description="Policies applied across all brands. Every change is validated and written to the audit log with its previous value." />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <SettingsForm key={JSON.stringify(data.map((d) => [d.key, d.value]))} rows={data} />
        <div className="grid content-start gap-6">
          <SectionCard title={<span className="flex items-center gap-2"><ServerCog className="size-4" aria-hidden /> Environment</span>}>
            <DetailList
              columns={1}
              items={[
                { label: "Environment", value: <StatusBadge tone="warning" label="Demo" /> },
                {
                  label: "Database",
                  value: (
                    <span className="inline-flex items-center gap-1.5">
                      <Database className="size-3.5 text-muted-foreground" aria-hidden /> PGlite (embedded PostgreSQL) — demo data only
                    </span>
                  ),
                },
                { label: "Production database", value: "Not connected" },
                { label: "Brand integrations", value: "Simulated — Demo / Not Connected" },
                { label: "Payments", value: "Simulated — no processor contacted, no card data stored" },
                { label: "Runtime", value: `Node ${process.version}` },
              ]}
            />
          </SectionCard>
          <SectionCard title="Configuration">
            <Link href="/integrations" className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent/40">
              <Cable className="size-4 text-muted-foreground" aria-hidden />
              <span className="flex-1">
                <span className="block font-medium">Integration settings</span>
                <span className="block text-xs text-muted-foreground">Connections to the three brand systems (Demo / Not Connected)</span>
              </span>
              <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
            </Link>
            <p className="border-t px-4 py-3 text-xs text-muted-foreground">Secrets (database URLs, processor keys) are never stored as settings — they live in server environment variables.</p>
          </SectionCard>
        </div>
      </div>
    </>
  );
}
