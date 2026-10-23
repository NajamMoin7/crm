import { redirect } from "next/navigation";
import { can, requireViewer } from "@/lib/auth/viewer";

/** Landing route: everyone starts on the dashboard (scoped to their role). */
export default async function Home() {
  const viewer = await requireViewer();
  redirect(can(viewer, "sales.view") ? "/dashboard" : "/customers");
}
