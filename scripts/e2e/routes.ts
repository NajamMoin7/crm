/**
 * Route & access smoke test for the two roles.
 *   npx tsx scripts/e2e/routes.ts   (dev server on :3100)
 * Every nav route loads cleanly per account; admin pages are denied to agents
 * by direct URL and API; removed modules are gone; sidebar matches the spec.
 */
import { BASE, check, hasNextErrorOverlay, launch, login, summary, visit } from "./harness";

const ADMIN_ONLY = [
  "/brands",
  "/admin/agents",
  "/admin/agents/USR-0001",
  "/admin/activity",
  "/admin/settings",
  "/reports",
  "/integrations",
  "/customers/duplicates",
  "/recharge/register",
];
const REMOVED = ["/leads", "/agents", "/team", "/my", "/transactions", "/adjustments", "/reconciliation", "/dashboard/brands", "/sales/mine", "/brands/configure", "/admin/permissions", "/customers/new", "/brands/BRD-LTD", "/entities/mapping", "/entities", "/entities/LLC-001"];
const EXPECTED_NAV = {
  admin: ["Dashboard", "Customers", "Sales", "Billing", "Recharge / Chargeback", "Brands", "Agents", "Reports", "Activity Logs", "Settings"],
  agent: ["Dashboard", "Customers", "Sales", "Billing", "Recharge / Chargeback"],
};

async function main() {
  const browser = await launch();

  for (const [email, kind] of [["admin@crm.demo", "admin"], ["agent@crm.demo", "agent"], ["agent2@crm.demo", "agent"]] as const) {
    console.log(`\n${email}`);
    const s = await login(browser, email);
    const nav = await s.page.locator('nav[aria-label="Main"] a').allInnerTexts();
    check(JSON.stringify(nav.map((n) => n.trim())) === JSON.stringify(EXPECTED_NAV[kind]), "sidebar matches the specified navigation", nav);
    const hrefs = await s.page.locator('nav[aria-label="Main"] a').evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
    for (const href of [...hrefs, "/billing/new", "/recharge/new", "/notifications"]) {
      const before = s.errors.length;
      const res = await visit(s.page, href);
      const denied = await s.page.getByText("Access restricted").filter({ visible: true }).count();
      const overlay = await hasNextErrorOverlay(s.page);
      const errs = s.errors.slice(before);
      check((res?.status() ?? 0) < 400 && !overlay && !denied && errs.length === 0, href, { status: res?.status(), overlay, denied, errs: errs.map((e) => e.slice(0, 200)) });
    }
    if (kind === "agent") {
      for (const href of ADMIN_ONLY) {
        await visit(s.page, href);
        check(await s.page.getByText("Access restricted").filter({ visible: true }).count(), `direct URL denied: ${href}`);
      }
      // API: exports and admin data are refused server-side
      const exp = await s.page.request.get(`${BASE}/api/export/customers`);
      check(exp.status() === 403, "agent cannot export CSV via API", exp.status());
      const act = await s.page.request.get(`${BASE}/api/export/activity`);
      check(act.status() === 403, "agent cannot export activity logs via API", act.status());
    } else {
      for (const href of ADMIN_ONLY) {
        await visit(s.page, href);
        check(!(await s.page.getByText("Access restricted").filter({ visible: true }).count()) && !(await hasNextErrorOverlay(s.page)), `admin opens ${href}`);
      }
    }
    for (const href of REMOVED) {
      // Paths like /sales/mine now fall through to /sales/[id], which streams a not-found / restricted page.
      const res = await visit(s.page, href);
      const body = await s.page.locator("body").innerText();
      check(res?.status() === 404 || /could not be found|does not exist|Access restricted/i.test(body), `removed route ${href} is gone`, res?.status());
    }
    await s.ctx.close();
  }

  // Unauthenticated API access
  const ctx = await browser.newContext();
  const anon = await ctx.request.get(`${BASE}/api/search?q=olivia`);
  check(anon.status() === 401, "search API requires a session", anon.status());

  // Phone width: no horizontal page scroll
  const m = await login(browser, "admin@crm.demo", { viewport: { width: 390, height: 844 } });
  for (const href of ["/dashboard", "/customers", "/sales", "/billing", "/recharge", "/admin/agents", "/brands", "/billing/new"]) {
    await visit(m.page, href);
    const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 1, `390px no horizontal scroll ${href}`, overflow);
  }
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
