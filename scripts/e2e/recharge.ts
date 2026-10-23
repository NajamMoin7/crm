/**
 * Recharge / Chargeback workflow — end-to-end.
 *   npx tsx scripts/e2e/recharge.ts   (dev server on :3100)
 */
import type { Page } from "playwright-core";
import { BASE, check, launch, login, shot, summary, visit } from "./harness";

async function caseIdFromUrl(page: Page) {
  await page.waitForURL(/\/recharge\/RCB-\d{4}-\d+$/, { timeout: 60_000 });
  return page.url().split("/").pop()!;
}

/** Polls the heading until it matches (the refreshed RSC payload lands just after the dialog closes). */
async function waitStatus(page: Page, re: RegExp) {
  for (let i = 0; i < 40; i++) {
    // Badges render uppercase via CSS, which innerText reflects — compare case-insensitively.
    if (new RegExp(re.source, "i").test(await statusText(page))) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function statusText(page: Page) {
  // Next 16 keeps the previous route mounted (hidden) for state preservation — only read the visible one.
  return (await page.locator("main h1:visible").first().innerText()).replace(/\s+/g, " ");
}

/** Runs the wizard for the first selectable payment found among the given search terms. */
async function createRequest(page: Page, terms: string[], opts: { amount?: "full" | "half"; submit: boolean; tryOverMax?: boolean }) {
  await visit(page, "/recharge/new");
  const brands = await page.locator('[role="radiogroup"][aria-label="Brand"]:visible [role="radio"]').count();
  for (const term of terms) {
    for (let b = 0; b < Math.max(1, brands); b++) {
      if (brands > 0) {
        await page.locator("ol[aria-label=Progress]:visible button").first().click();
        await page.locator('[role="radiogroup"][aria-label="Brand"]:visible [role="radio"]').nth(b).click();
        await page.getByRole("button", { name: /Continue/ }).click();
      }
      await page.getByLabel("Search original transaction").fill(term);
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await page.waitForTimeout(400);
      await page.waitForFunction(() => !document.querySelector("button[type=submit] .animate-spin"), null, { timeout: 30_000 });
      const candidates = page.locator("ul li button:not([disabled]):visible").filter({ hasNotText: "Nothing left to charge back" });
      if ((await candidates.count()) === 0) continue;
      await candidates.first().click();
      await page.getByRole("button", { name: /Continue/ }).click(); // → ownership
      await page.getByText("Remaining chargeable").first().waitFor();
      await page.getByRole("button", { name: /Continue/ }).click(); // → details
      const max = (await page.locator("#amount-hint:visible").innerText()).match(/Max \$([\d,]+\.\d{2})/)![1].replace(/,/g, "");
      if (opts.tryOverMax) {
        await page.fill("#amount:visible", (Number(max) + 1).toFixed(2));
        await page.getByRole("button", { name: /Continue/ }).click();
        check(await page.getByText(/Maximum chargeable is/).filter({ visible: true }).first().isVisible(), "amount above the chargeable balance is rejected");
      }
      await page.fill("#amount:visible", opts.amount === "half" ? (Number(max) / 2).toFixed(2) : max);
      await page.locator("#reason:visible").click();
      await page.getByRole("option").first().click();
      await page.fill("#notes:visible", "Customer disputed via issuing bank — e2e test.");
      await page.getByRole("button", { name: /Continue/ }).click(); // → review
      await page.getByText("Requested amount").waitFor();
      await page.getByRole("button", { name: opts.submit ? /Submit for review/ : /Save as draft/ }).click();
      const id = await caseIdFromUrl(page);
      return { id, max };
    }
  }
  throw new Error("No chargeable payment found for terms " + terms.join(","));
}

async function act(page: Page, button: RegExp, note?: string) {
  await page.getByRole("button", { name: button }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  if (note) await dialog.locator("#wf-note:visible").fill(note);
  await dialog.getByRole("button", { name: button }).click();
  await dialog.waitFor({ state: "detached", timeout: 30_000 });
  await page.waitForLoadState("networkidle");
}

async function customerIds(page: Page) {
  await visit(page, "/customers");
  return page.locator("tbody:visible tr td:first-child .font-mono").allInnerTexts();
}

async function main() {
  const browser = await launch();
  const year = new Date().getUTCFullYear();

  /* 1. Agent creates and submits a request on their own payment */
  console.log("Agent submits a request");
  const agent = await login(browser, "agent@crm.demo");
  const ids = await customerIds(agent.page);
  check(ids.length >= 3 && !ids.some((i) => ["CUS-100004", "CUS-100005", "CUS-100006"].includes(i)), "agent sees only their own customers", ids);
  const { id: caseA } = await createRequest(agent.page, ids, { amount: "half", submit: true, tryOverMax: true });
  check(await waitStatus(agent.page, /Pending Review/), `${caseA} is Pending Review after submit`);
  for (const b of [/Review & forward/, /^Approve$/, /^Reject$/, /Start processing/]) {
    check((await agent.page.getByRole("button", { name: b }).count()) === 0, `agent is not offered "${b.source}"`);
  }
  await shot(agent.page, "recharge-case-agent");

  /* 2. A second request: draft → submit; the admin returns it */
  const { id: caseB } = await createRequest(agent.page, [...ids].reverse(), { amount: "half", submit: false });
  check(await waitStatus(agent.page, /Draft/), `${caseB} saved as Draft`);
  await act(agent.page, /Submit for review/);
  check(await waitStatus(agent.page, /Pending Review/), `${caseB} submitted`);

  /* 3. Other agent cannot see it */
  const agent2 = await login(browser, "agent2@crm.demo");
  await visit(agent2.page, `/recharge/${caseA}`);
  check(await agent2.page.getByText("Access restricted").filter({ visible: true }).count(), "agent2 cannot open agent's case");
  await visit(agent2.page, `/recharge/RCB-${year}-0001`);
  check(await agent2.page.getByText("Access restricted").filter({ visible: true }).count(), "agent2 cannot open agent's seeded case");

  /* 4. Super Admin reviews, approves, processes and completes A */
  console.log("Super Admin decides");
  const admin = await login(browser, "admin@crm.demo");
  await visit(admin.page, "/recharge?queue=review");
  check(await admin.page.getByRole("link", { name: caseA }).isVisible(), "case appears in the admin review queue");
  await visit(admin.page, `/recharge/${caseA}`);
  await act(admin.page, /Review & forward/, "Docs verified (e2e)");
  check(await waitStatus(admin.page, /Pending Approval/), `${caseA} forwarded`);
  await act(admin.page, /^Approve$/);
  check(await waitStatus(admin.page, /Approved/), `${caseA} approved`);
  await act(admin.page, /Start processing/);
  check(await waitStatus(admin.page, /Processing/), `${caseA} processing`);
  await admin.page.getByRole("button", { name: /Record completion/ }).click();
  await admin.page.getByRole("dialog").locator("#proc-ref:visible").fill(`dp_e2e_${Date.now()}`);
  await admin.page.getByRole("dialog").getByRole("button", { name: /Record completion/ }).click();
  await admin.page.getByRole("dialog").waitFor({ state: "detached" });
  check(await waitStatus(admin.page, /Completed/), `${caseA} completed`);
  check(await admin.page.getByText("Ledger entry").filter({ visible: true }).first().isVisible(), "completion booked a ledger entry");

  /* 5. Return B for correction; the agent sees the note */
  await visit(admin.page, `/recharge/${caseB}`);
  await admin.page.getByRole("button", { name: /Return for correction/ }).click();
  const confirm = admin.page.getByRole("dialog").getByRole("button", { name: /Return for correction/ });
  check(await confirm.isDisabled(), "return requires a note");
  await admin.page.getByRole("dialog").locator("#wf-note:visible").fill("Please attach the bank letter.");
  await confirm.click();
  await admin.page.getByRole("dialog").waitFor({ state: "detached" });
  check(await waitStatus(admin.page, /Draft/), `${caseB} returned to Draft`);
  await visit(agent.page, `/recharge/${caseB}`);
  check(await agent.page.getByText(/Returned for correction: “Please attach the bank letter.”/).filter({ visible: true }).count(), "agent sees the return note");

  /* 6. Reject the seeded pending request from agent2 (note required) */
  const seeded = `RCB-${year}-0002`;
  await visit(admin.page, `/recharge/${seeded}`);
  check(await waitStatus(admin.page, /Pending Review/), `seeded ${seeded} is pending review`);
  await act(admin.page, /^Reject$/, "Second phase was delivered per signed acceptance (e2e).");
  check(await waitStatus(admin.page, /Rejected/), `${seeded} rejected by the Super Admin`);

  /* 7. Separation of duties: the admin's own request cannot be reviewed/approved by the admin */
  const { id: caseC } = await createRequest(admin.page, ["CUS-100001", "CUS-100003", "CUS-100005"], { amount: "half", submit: true });
  const forwardOwn = admin.page.getByRole("button", { name: /Review & forward/ });
  check((await forwardOwn.count()) > 0 && (await forwardOwn.isDisabled()), `admin cannot review own ${caseC}`);
  check(await admin.page.getByText(/Separation of duties/).filter({ visible: true }).first().isVisible(), "SoD reason is shown");

  /* 8. Results are in the activity log */
  await visit(admin.page, `/admin/activity?q=${caseA}`);
  const log = await admin.page.locator("main").innerText();
  check(log.includes(caseA) && /approved/i.test(log) && /completed/i.test(log), "approval and completion appear in the activity log");
  await visit(admin.page, `/admin/activity?q=${seeded}`);
  check(/rejected/i.test(await admin.page.locator("main").innerText()), "rejection appears in the activity log");

  /* 9. Agent notified of the outcome */
  await visit(agent.page, "/notifications");
  check(await agent.page.getByText(new RegExp(`${caseA} completed`)).filter({ visible: true }).count(), "agent notified that their case completed");

  const all = [agent, agent2, admin].flatMap((s) => s.errors);
  check(all.length === 0, "no console / page errors", all.slice(0, 5));
  await browser.close();
  console.log(`(base ${BASE})`);
  process.exit(summary() ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
