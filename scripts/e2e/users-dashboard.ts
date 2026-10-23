/**
 * User management (Super Admin) + dashboard correctness for both roles.
 *   npx tsx scripts/e2e/users-dashboard.ts   (dev server on :3100)
 */
import type { Page } from "playwright-core";
import { BASE, check, launch, login, shot, summary, visit } from "./harness";

const stamp = Date.now().toString(36);
const NEW_EMAIL = `new.agent.${stamp}@crm.demo`;
const NEW_PASSWORD = "Temp#Pass2026xyz";

async function toast(page: Page, re: RegExp) {
  return page.locator("[data-sonner-toast]").filter({ hasText: re }).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
}
async function kpi(page: Page, label: string) {
  const card = page.locator('[data-testid="kpis"]:visible a').filter({ hasText: label }).first();
  return (await card.locator(".text-2xl").innerText()).trim();
}
async function listTotal(page: Page, route: string) {
  await visit(page, route);
  const t = (await page.getByText(/Showing \d+–\d+ of \d+|No results/).filter({ visible: true }).first().innerText()).trim();
  return t === "No results" ? 0 : Number(t.split(" of ")[1].replace(/,/g, ""));
}

async function main() {
  const browser = await launch();
  const admin = await login(browser, "admin@crm.demo");
  const p = admin.page;

  /* Dashboard — Super Admin: KPIs equal the underlying records */
  console.log("dashboard (Super Admin)");
  await visit(p, "/dashboard");
  for (const label of ["Total Customers", "Total Sales", "Total Billed Amount", "Pending Billing", "Recharge / Chargeback Cases", "Active Sales Agents"]) {
    check(await p.locator('[data-testid="kpis"]:visible').getByText(label, { exact: true }).isVisible(), `KPI "${label}" present`);
  }
  check((await p.locator('[data-testid="kpis"]:visible a').count()) === 6, "exactly six KPI cards");
  for (const t of ["Sales by Brand", "Sales Activity Over Time", "Recent Sales", "Recent Recharge / Chargeback Requests"]) {
    check(await p.getByRole("heading", { name: t }).filter({ visible: true }).count(), `section "${t}" present`);
  }
  const adminSales = Number(await kpi(p, "Total Sales"));
  const adminCustomers = Number(await kpi(p, "Total Customers"));
  const agentsKpi = await kpi(p, "Active Sales Agents");
  check(adminSales === (await listTotal(p, "/sales?range=all")), "Total Sales equals the sales records", adminSales);
  check(adminCustomers === (await listTotal(p, "/customers")), "Total Customers equals the customer records", adminCustomers);
  check(/^\d+ \/ \d+$/.test(agentsKpi), "agents KPI shows active / total", agentsKpi);
  await visit(p, "/dashboard?brand=BRD-LTD&range=all");
  const ltdSales = Number(await kpi(p, "Total Sales"));
  check(ltdSales === (await listTotal(p, "/sales?brand=BRD-LTD&range=all")) && ltdSales < adminSales, "brand filter updates the KPIs", { ltdSales, adminSales });
  await visit(p, "/dashboard");
  await shot(p, "dashboard-admin", true);

  /* Dashboard — agents see only their own records */
  for (const email of ["agent@crm.demo", "agent2@crm.demo"]) {
    const a = await login(browser, email);
    await visit(a.page, "/dashboard");
    const sales = Number(await kpi(a.page, "Total Sales"));
    const own = await listTotal(a.page, "/sales?range=all");
    check(sales === own && sales < adminSales, `${email}: dashboard counts only own sales`, { sales, own });
    await visit(a.page, "/dashboard");
    check(!(await a.page.locator('[data-testid="kpis"]:visible').getByText("Active Sales Agents").count()), `${email}: no company-wide agent KPI`);
    if (email === "agent@crm.demo") await shot(a.page, "dashboard-agent", true);
    await a.ctx.close();
  }

  /* Users — only two roles are selectable; create an LTD agent */
  console.log("user management");
  await visit(p, "/admin/agents");
  check((await p.locator("ul[aria-label=Accounts]:visible > li").count()) >= 3, "seeded accounts listed");
  await p.getByRole("button", { name: "New agent" }).click();
  const dlg = p.getByRole("dialog");
  const roleRadios = await dlg.getByRole("radio").allInnerTexts().catch(() => []);
  const roleNames = await dlg.locator('[role="radiogroup"] label').allInnerTexts();
  check(roleNames.length === 2 && roleNames.some((r) => r.startsWith("Super Admin")) && roleNames.some((r) => r.startsWith("Sales Agent")), "only Super Admin and Sales Agent are selectable", { roleNames, roleRadios });
  await dlg.locator("#u-name").fill("New Test Agent");
  await dlg.locator("#u-email").fill(NEW_EMAIL);
  await dlg.locator("#u-pass").fill(NEW_PASSWORD);
  await dlg.getByRole("radio", { name: "Sales Agent" }).click();
  await dlg.getByRole("button", { name: "Create agent" }).click();
  check(await dlg.getByText(/Assign at least one brand/).first().waitFor({ timeout: 15_000 }).then(() => true, () => false), "agent without brands is rejected");
  await dlg.getByRole("checkbox", { name: /^Logic Tech Digital/ }).check();
  await dlg.getByRole("button", { name: "Create agent" }).click();
  check(await toast(p, /created/i), "user created");

  await visit(p, `/admin/agents?q=${encodeURIComponent(NEW_EMAIL)}`);
  check((await p.locator("ul[aria-label=Accounts]:visible > li").count()) === 1, "search finds the new user");
  await visit(p, "/admin/agents?role=super_admin");
  check((await p.locator("ul[aria-label=Accounts]:visible > li").count()) === 1, "role filter: one Super Admin");

  const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const np = await fresh.newPage();
  await np.goto(`${BASE}/login`);
  await np.fill("#email", NEW_EMAIL);
  await np.fill("#password", NEW_PASSWORD);
  await Promise.all([np.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }), np.click("button[type=submit]")]);
  check(true, "new agent can sign in");
  await visit(np, "/billing/new");
  const brandRadios = await np.locator('[role="radiogroup"][aria-label="Brand"]:visible [role="radio"]').count();
  check(brandRadios <= 1 && (await np.getByText("Logic Tech Digital").filter({ visible: true }).count()) > 0, "new agent only gets Logic Tech Digital", brandRadios);
  await visit(np, "/admin/agents");
  check(await np.getByText("Access restricted").filter({ visible: true }).count(), "new agent cannot open user management");

  /* Self-protection: the admin cannot change own role or suspend self */
  await visit(p, "/admin/agents/USR-0001");
  await p.getByRole("button", { name: "Edit agent" }).click();
  const selfDlg = p.getByRole("dialog");
  check(await selfDlg.getByRole("radio", { name: "Sales Agent" }).isDisabled(), "own role cannot be changed");
  check(await selfDlg.locator("#u-status").isDisabled(), "own account cannot be suspended");
  await selfDlg.getByRole("button", { name: "Cancel" }).click();

  /* Suspend the new user → session revoked; reactivate */
  await visit(p, `/admin/agents?q=${encodeURIComponent(NEW_EMAIL)}`);
  await p.getByRole("button", { name: "Edit New Test Agent" }).click();
  await p.getByRole("dialog").locator("#u-status").click();
  await p.getByRole("option", { name: "Suspended" }).click();
  await p.getByRole("dialog").getByRole("button", { name: /Suspend & save/ }).click();
  check(await toast(p, /suspended/i), "user suspended");
  await np.goto(`${BASE}/customers`);
  await np.waitForURL(/\/login/, { timeout: 30_000 }).catch(() => {});
  check(np.url().includes("/login"), "suspended user's session no longer works", np.url());
  await fresh.close();

  check(admin.errors.length === 0, "no console / page errors", admin.errors.slice(0, 3));
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
