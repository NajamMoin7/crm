import { redirect } from "next/navigation";
import { AccessDenied } from "@/components/crm/access-denied";
import { can, requireViewer } from "@/lib/auth/viewer";

/** /admin → the first administration screen the viewer may open. */
export default async function AdminIndex() {
  const viewer = await requireViewer();
  if (can(viewer, "users.manage")) redirect("/admin/agents");
  if (can(viewer, "audit.view")) redirect("/admin/activity");
  if (can(viewer, "settings.manage")) redirect("/admin/settings");
  return <AccessDenied />;
}
