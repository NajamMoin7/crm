import { redirect } from "next/navigation";

/** Old URL: accounts are managed on the Agents page. */
export default function UsersRedirect() {
  redirect("/admin/agents");
}
