/**
 * Minimal browser test harness on playwright-core + the locally installed
 * Chrome/Edge (no browser download). Used by scripts/e2e/*.ts.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

export const BASE = process.env.CRM_URL ?? "http://localhost:3100";
export const PASSWORD = "Demo@2026!";
export const SHOTS = process.env.CRM_SHOTS ?? path.join(process.cwd(), ".data", "screenshots");

const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean) as string[];

export async function launch(): Promise<Browser> {
  const executablePath = CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) throw new Error("No Chrome/Edge found; set CHROME_PATH");
  mkdirSync(SHOTS, { recursive: true });
  return chromium.launch({ executablePath, headless: true });
}

export type Session = { ctx: BrowserContext; page: Page; errors: string[] };

export async function login(browser: Browser, email: string, opts: { viewport?: { width: number; height: number }; dark?: boolean } = {}): Promise<Session> {
  const ctx = await browser.newContext({
    viewport: opts.viewport ?? { width: 1440, height: 900 },
    colorScheme: opts.dark ? "dark" : "light",
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Download the React DevTools|favicon/.test(m.text())) errors.push(`console: ${m.text().slice(0, 300)}`);
  });
  await page.goto(`${BASE}/login`, { timeout: 180_000 });
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }), page.click("button[type=submit]")]);
  return { ctx, page, errors };
}

let failures = 0;
let passes = 0;
export function check(cond: unknown, label: string, detail?: unknown) {
  if (cond) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
}
export function summary() {
  console.log(`\n${passes} passed, ${failures} failed`);
  return failures;
}

/** Navigates and waits for streamed content to settle (no skeletons left). */
export async function visit(page: Page, route: string) {
  const res = await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForLoadState("networkidle", { timeout: 90_000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 60_000 }).catch(() => {});
  return res;
}

export async function hasNextErrorOverlay(page: Page) {
  return page.evaluate(() => !!document.querySelector("nextjs-portal")?.shadowRoot?.querySelector("[data-nextjs-dialog], [data-issues]"));
}

export async function shot(page: Page, name: string, fullPage = false) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
}
