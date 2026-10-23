import { PageSkeleton } from "@/components/crm/page-skeleton";

/** Per-segment boundary so client navigations between sibling routes stay instant. */
export default function Loading() {
  return <PageSkeleton />;
}
