/**
 * Runs every browser suite sequentially against a running dev server.
 *   npm run test:e2e        (expects http://localhost:3100, override with CRM_URL)
 */
import { spawnSync } from "node:child_process";

const SUITES = ["users-dashboard", "routes", "billing-math", "simplify", "recharge"];
const results: [string, number][] = [];
for (const s of SUITES) {
  console.log(`\n━━━ ${s} ━━━`);
  const r = spawnSync(process.execPath, ["--import", "tsx", `scripts/e2e/${s}.ts`], { stdio: "inherit" });
  results.push([s, r.status ?? 1]);
}
console.log("\nSummary");
for (const [s, code] of results) console.log(`  ${code === 0 ? "PASS" : "FAIL"}  ${s}`);
process.exit(results.some(([, c]) => c !== 0) ? 1 : 0);
