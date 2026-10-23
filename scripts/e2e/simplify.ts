/**
 * Simplified workflows: billing form (customer created from the order), paste
 * details, Sales agent totals + chargeback from an order, Brand CRUD, no LLC UI.
 *   npx tsx scripts/e2e/simplify.ts   (dev server on :3100)
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { BASE, SHOTS, check, launch, login, shot, summary, visit } from "./harness";

const stamp = Date.now().toString(36);

async function toast(page: Page, re: RegExp) {
  return page.locator("[data-sonner-toast]").filter({ hasText: re }).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
}

/** A tiny valid PNG (1×1, gold) for the logo upload. */
function writeLogo() {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8v6/+PwAJ2QPmuF0hLQAAAABJRU5ErkJggg==", "base64");
  const file = path.join(SHOTS, "logo.png");
  writeFileSync(file, png);
  return file;
}

async function main() {
  const browser = await launch();
  const email = `nora.patel.${stamp}@example.com`;

  /* ---------------- Customers come from orders (agent) */
  console.log("customers");
  const agent = await login(browser, "agent@crm.demo");
  const a = agent.page;
  await visit(a, "/customers");
  const headers = (await a.locator("thead:visible th").allInnerTexts()).map((h) => h.trim()).filter(Boolean);
  check(JSON.stringify(headers) === JSON.stringify(["Customer", "Email", "Phone", "Brands", "Actions"]), "customer list shows only the essential columns", headers);
  check((await a.getByRole("button", { name: "Add customer" }).count()) === 0, "no separate Add customer form");
  check(await a.locator("main:visible").getByRole("link", { name: "New order" }).count(), "customers page links to the billing form");

  /* ---------------- Billing form with paste details (agent) */
  console.log("billing form");
  await visit(a, "/billing/new");
  check((await a.locator("ol[aria-label=Progress]:visible").count()) === 0, "billing is a single form, not a wizard");
  await a.locator('[aria-label="Brand"]:visible [role=radio]').filter({ hasText: "Xpectra" }).click();
  await a.getByRole("button", { name: "Paste details" }).click();
  const pd = a.getByRole("dialog");
  await pd.getByLabel("Pasted details").fill(
    [`Name: Nora Patel`, `Company: Patel Bakery`, `Email: ${email}`, `Phone: +1 (415) 555-0199`, `Address: 88 Mission St`, `City: San Francisco`, `State: CA`, `Zip: 94105`, `Amount: $324.75`, `Description: Logo animation`, `Card: 4111 1111 1111 1111`, `CVV: 123`].join("\n"),
  );
  await pd.getByRole("button", { name: /Fill the form/ }).click();
  check(await toast(a, /Filled \d+ fields/), "paste fills the form");
  check(await toast(a, /Card details were ignored/), "pasted card details are ignored with a warning");
  check((await a.locator("#o-firstName").inputValue()) === "Nora" && (await a.locator("#o-lastName").inputValue()) === "Patel", "name split into first / last");
  check((await a.locator("#o-email").inputValue()) === email, "email filled");
  check((await a.locator("#o-city").inputValue()) === "San Francisco" && (await a.locator("#o-zip").inputValue()) === "94105", "address filled");
  const formText = await a.locator("main:visible").evaluate((m) => [...m.querySelectorAll("input,textarea")].map((i) => (i as HTMLInputElement).value).join("|"));
  check(!/4111|\b123\b/.test(formText), "no card number or CVV anywhere in the form");
  check((await a.getByTestId("wizard-total").innerText()) === "$324.75", "amount from the paste drives the total", await a.getByTestId("wizard-total").innerText());
  await a.locator("#o-invoiceNumber").fill("483920");
  await a.locator("#o-method").click();
  await a.getByRole("option", { name: /PayPal/ }).click();
  await a.locator("#o-ref").fill("4111111111111111");
  await a.getByRole("button", { name: /Save order/ }).click();
  check(/card number/i.test(await a.locator("main:visible").innerText()), "card numbers are rejected as payment references");
  await a.locator("#o-ref").fill(`PAYID-E2E-${stamp.toUpperCase()}`);
  await shot(a, "order-form", true);
  await a.getByRole("button", { name: /Save order/ }).click();
  await a.waitForURL(/\/billing\/INV-\d+/, { timeout: 60_000 });
  check(await toast(a, /new customer CUS-\d+/), "saving the order creates the customer");
  check(await a.locator("main").getByText("$324.75").filter({ visible: true }).first().waitFor({ timeout: 30_000 }).then(() => true, () => false), "invoice saved with the right total");

  // Same email again → the existing customer is reused, not duplicated
  await visit(a, "/billing/new");
  await a.locator('[aria-label="Brand"]:visible [role=radio]').filter({ hasText: "Xpectra" }).click();
  await a.locator("#o-email").fill(email);
  check(await a.getByText(/Existing customer/).filter({ visible: true }).first().waitFor({ timeout: 15_000 }).then(() => true, () => false), "known email shows the existing customer");
  await a.locator("#o-amount").fill("50");
  await a.locator("#o-firstName").fill("Nora");
  await a.locator("#o-lastName").fill("Patel");
  await a.locator("#o-phone").fill("+1 (415) 555-0199");
  await a.locator('[aria-label="Payment status"] [role=radio]').filter({ hasText: /^Pending$/ }).click();
  await a.locator("#o-method").click();
  await a.getByRole("option", { name: /PayPal/ }).click();
  await a.getByRole("button", { name: /Save order/ }).click();
  await a.waitForURL(/\/billing\/INV-\d+/, { timeout: 60_000 });
  check(await toast(a, /existing customer CUS-\d+/), "second order attached to the existing customer");
  await visit(a, `/customers?q=${encodeURIComponent(email)}`);
  check((await a.locator("tbody:visible tr").count()) === 1, "still one customer record for that email");

  /* ---------------- Sales: agent totals, agent on every order, chargeback button (admin) */
  console.log("sales");
  const admin = await login(browser, "admin@crm.demo");
  const p = admin.page;
  await visit(p, "/sales");
  const totals = await p.locator("section[aria-labelledby=agent-totals] tbody tr").allInnerTexts();
  check(totals.some((r) => /Bilal Ahmed/.test(r)) && totals.some((r) => /Emily Carter/.test(r)) && /Total/i.test(totals.at(-1) ?? ""), "agent totals list every agent plus a total row", totals.length);
  await shot(p, "sales-admin", true);
  await visit(p, `/sales?q=${encodeURIComponent(email)}`);
  const card = p.locator("ul[aria-label=Orders] > li").filter({ hasText: "$324.75" }).first();
  check(/Bilal Ahmed/i.test(await card.innerText()), "order card names the agent");
  await card.locator("summary").click();
  const cb = card.getByRole("link", { name: /Chargeback/ });
  check(await cb.isVisible(), "paid order has a Chargeback button");
  await shot(p, "sales-order-expanded", true);
  await cb.click();
  await p.waitForURL(/\/recharge\/new\?txn=/, { timeout: 30_000 });
  check(await p.getByText("Remaining chargeable").filter({ visible: true }).first().waitFor({ timeout: 30_000 }).then(() => true, () => false), "chargeback opens on the order's payment");
  await visit(p, "/recharge/register");
  const cbHeaders = (await p.locator("thead:visible th").allInnerTexts()).map((h) => h.trim());
  check(cbHeaders.includes("Agent") && !cbHeaders.some((h) => /LLC|entity/i.test(h)), "chargeback list shows the agent, not LLCs", cbHeaders);

  /* ---------------- Brand CRUD (Super Admin): name + logo only */
  console.log("brands");
  await visit(p, "/brands");
  check((await p.locator("ul[aria-label=Brands] > li").count()) >= 3, "brands listed");
  await p.getByRole("button", { name: "New brand" }).click();
  const bd = p.getByRole("dialog");
  const brandLabels = (await bd.locator("label").allInnerTexts()).map((l) => l.replace("*", "").trim().toLowerCase().split("\n")[0]).filter(Boolean);
  check(brandLabels.join("|") === "brand name|brand logo", "brand form asks only for name and logo", brandLabels);
  const brandName = `Nova Prints ${stamp.slice(-4).toUpperCase()}`;
  await bd.locator("#b-name").fill(brandName);
  await bd.locator("#b-logo").setInputFiles(writeLogo());
  await bd.getByRole("button", { name: "Create brand" }).click();
  check(await toast(p, /Brand created/), "brand created");
  let row = p.locator("ul[aria-label=Brands] > li").filter({ hasText: brandName });
  await row.waitFor();
  check((await row.locator("img").count()) === 1, "uploaded logo shown");
  await row.getByRole("button", { name: `Edit ${brandName}` }).click();
  const renamed = `${brandName} Co`;
  await p.getByRole("dialog").locator("#b-name").fill(renamed);
  await p.getByRole("dialog").getByRole("button", { name: "Save changes" }).click();
  check(await toast(p, /Brand updated/), "brand renamed");
  row = p.locator("ul[aria-label=Brands] > li").filter({ hasText: renamed });
  await row.waitFor();
  await shot(p, "brands");
  await visit(p, "/billing/new");
  check(await p.locator('[aria-label="Brand"]:visible [role=radio]').filter({ hasText: renamed }).count(), "new brand is usable in the billing form");
  // A brand with sales can't be deleted
  await visit(p, "/brands");
  await p.locator("ul[aria-label=Brands] > li").filter({ hasText: "Logic Tech Digital" }).getByRole("button", { name: /Delete/ }).click();
  await p.getByRole("alertdialog").getByRole("button", { name: "Delete brand" }).click();
  check(await toast(p, /can't be deleted/), "brand with history is protected");
  await p.keyboard.press("Escape");
  // An unused brand can
  await visit(p, "/brands");
  await p.locator("ul[aria-label=Brands] > li").filter({ hasText: renamed }).getByRole("button", { name: /Delete/ }).click();
  await p.getByRole("alertdialog").getByRole("button", { name: "Delete brand" }).click();
  check(await toast(p, /deleted/), "unused brand deleted");
  await visit(p, "/brands");
  check((await p.locator("ul[aria-label=Brands] > li").filter({ hasText: renamed }).count()) === 0, "deleted brand is gone");

  /* ---------------- Agents cannot manage brands; no LLC wording anywhere */
  await visit(a, "/brands");
  check(await a.getByText("Access restricted").filter({ visible: true }).count(), "agent cannot open Brand Management");
  for (const route of ["/dashboard", "/sales", "/billing", "/recharge/register", "/customers/CUS-100001", "/admin/settings", "/reports", "/reports?report=chargeback-cases", "/reports?report=consolidated-sales"]) {
    await visit(p, route);
    const body = await p.locator("main:visible").innerText();
    check(!/legal entit|\bLLCs?\b/i.test(body), `no LLC / legal entity wording on ${route}`, body.match(/.{0,40}(legal entit|LLC).{0,40}/i)?.[0]);
  }
  await visit(p, "/admin/users");
  check(p.url().includes("/admin/agents"), "/admin/users redirects to /admin/agents");

  /* ---------------- Screens for review */
  for (const [route, name] of [["/dashboard", "dash"], ["/customers", "customers"], ["/admin/agents", "agents"], ["/recharge", "recharge"], ["/billing/new", "order-form-admin"]] as const) {
    await visit(p, route);
    await shot(p, `simplify-${name}`, true);
  }
  const m = await login(browser, "agent@crm.demo", { viewport: { width: 390, height: 844 } });
  for (const route of ["/customers", "/billing/new", "/sales"]) {
    await visit(m.page, route);
    const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 1, `390px no horizontal scroll ${route}`, overflow);
  }
  await shot(m.page, "sales-mobile", true);

  const errors = [...agent.errors, ...admin.errors, ...m.errors];
  check(errors.length === 0, "no console / page errors", errors.slice(0, 3));
  await browser.close();
  console.log(`(base ${BASE})`);
  process.exit(summary() ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
