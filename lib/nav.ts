import {
  Activity,
  Building2,
  FileBarChart,
  LayoutDashboard,
  type LucideIcon,
  Receipt,
  RotateCcw,
  Settings,
  ShoppingBag,
  UserRound,
  Users,
} from "lucide-react";
import type { Permission } from "./domain/permissions";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Any one of these grants visibility. Empty = every signed-in user. */
  anyOf: Permission[];
};

export type NavGroup = { label: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, anyOf: ["sales.view"] }],
  },
  {
    label: "Operations",
    items: [
      { href: "/customers", label: "Customers", icon: Users, anyOf: ["customers.view"] },
      { href: "/sales", label: "Sales", icon: ShoppingBag, anyOf: ["sales.view"] },
      { href: "/billing", label: "Billing", icon: Receipt, anyOf: ["billing.view"] },
      { href: "/recharge", label: "Recharge / Chargeback", icon: RotateCcw, anyOf: ["chargebacks.view"] },
    ],
  },
  {
    label: "Administration",
    items: [
      { href: "/brands", label: "Brands", icon: Building2, anyOf: ["brands.manage"] },
      { href: "/admin/agents", label: "Agents", icon: UserRound, anyOf: ["users.manage"] },
      { href: "/reports", label: "Reports", icon: FileBarChart, anyOf: ["reports.view"] },
      { href: "/admin/activity", label: "Activity Logs", icon: Activity, anyOf: ["audit.view"] },
      { href: "/admin/settings", label: "Settings", icon: Settings, anyOf: ["settings.manage"] },
    ],
  },
];

export function allowedHrefs(perms: Set<Permission>): string[] {
  return NAV.flatMap((g) => g.items)
    .filter((i) => i.anyOf.length === 0 || i.anyOf.some((p) => perms.has(p)))
    .map((i) => i.href);
}
