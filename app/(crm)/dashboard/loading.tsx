import { PageSkeleton } from "@/components/crm/page-skeleton";

export default function Loading() {
  return <PageSkeleton kpis={10} rows={6} />;
}
