/**
 * Two-role migration for an EXISTING (non-demo) CRM database.
 * The demo database doesn't need this — just run `npm run db:reset`.
 *
 *   npx tsx scripts/migrate-roles.ts            # dry run: prints what would change
 *   npx tsx scripts/migrate-roles.ts --apply    # applies inside one transaction
 *
 * What it does (idempotent, no business records are touched):
 *   1. Upserts the permission catalogue and the two roles (Super Admin, Sales Agent)
 *      with their exact grants.
 *   2. Users holding an obsolete role and no Super Admin role become Sales Agents
 *      (least privilege). Promote anyone who needs full access afterwards in Users.
 *   3. Removes obsolete role assignments, grants and role rows.
 *   4. Super Admins get every brand; aborts if no active Super Admin would remain.
 * Stop `next dev` first when targeting the local PGlite database.
 */
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { createPgliteDb } from "../lib/db/client";
import * as s from "../lib/db/schema";
import { ALL_PERMISSIONS, PERMISSIONS, ROLE_IDS, ROLES } from "../lib/domain/permissions";

async function main() {
  const apply = process.argv.includes("--apply");
  const { db, client } = await createPgliteDb();

  const obsoleteRoles = (await db.select({ id: s.roles.id }).from(s.roles).where(notInArray(s.roles.id, ROLE_IDS))).map((r) => r.id);
  const assignments = await db.select().from(s.userRoles);
  const users = await db.select({ id: s.users.id, email: s.users.email, status: s.users.status }).from(s.users);
  const rolesOf = (u: string) => assignments.filter((a) => a.userId === u).map((a) => a.roleId);
  const demoted = users.filter((u) => !rolesOf(u.id).includes("super_admin") && rolesOf(u.id).some((r) => obsoleteRoles.includes(r) || r === "sales_agent"));
  const toAgent = demoted.filter((u) => !rolesOf(u.id).includes("sales_agent"));
  const activeAdmins = users.filter((u) => u.status === "active" && rolesOf(u.id).includes("super_admin"));

  console.log(`Obsolete roles: ${obsoleteRoles.join(", ") || "none"}`);
  console.log(`Users to become Sales Agents: ${toAgent.map((u) => u.email).join(", ") || "none"}`);
  console.log(`Active Super Admins after migration: ${activeAdmins.map((u) => u.email).join(", ") || "NONE"}`);
  if (activeAdmins.length === 0) {
    console.error("Aborting: no active Super Admin would remain. Assign super_admin to someone first.");
    process.exit(1);
  }
  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to make these changes.");
    await client.close();
    return;
  }

  await db.transaction(async (tx) => {
    for (const key of ALL_PERMISSIONS) {
      const p = PERMISSIONS[key] as { module: string; description: string; sensitive?: boolean };
      await tx.insert(s.permissions).values({ key, module: p.module, description: p.description, sensitive: !!p.sensitive }).onConflictDoUpdate({
        target: s.permissions.key,
        set: { module: p.module, description: p.description, sensitive: !!p.sensitive },
      });
    }
    for (const id of ROLE_IDS) {
      await tx.insert(s.roles).values({ id, name: ROLES[id].name, description: ROLES[id].description }).onConflictDoUpdate({
        target: s.roles.id,
        set: { name: ROLES[id].name, description: ROLES[id].description },
      });
      await tx.delete(s.rolePermissions).where(eq(s.rolePermissions.roleId, id));
      await tx.insert(s.rolePermissions).values(ROLES[id].permissions.map((permissionKey) => ({ roleId: id, permissionKey })));
    }
    for (const u of toAgent) await tx.insert(s.userRoles).values({ userId: u.id, roleId: "sales_agent" });
    if (obsoleteRoles.length) {
      await tx.delete(s.userRoles).where(inArray(s.userRoles.roleId, obsoleteRoles));
      await tx.delete(s.rolePermissions).where(inArray(s.rolePermissions.roleId, obsoleteRoles));
      await tx.delete(s.roles).where(inArray(s.roles.id, obsoleteRoles));
    }
    // A user holds exactly one role: Super Admin wins.
    for (const a of activeAdmins) await tx.delete(s.userRoles).where(and(eq(s.userRoles.userId, a.id), eq(s.userRoles.roleId, "sales_agent")));
    await tx.delete(s.permissions).where(notInArray(s.permissions.key, ALL_PERMISSIONS));
    const brands = await tx.select({ id: s.brands.id }).from(s.brands);
    for (const a of activeAdmins) for (const b of brands) await tx.insert(s.userBrandAccess).values({ userId: a.id, brandId: b.id }).onConflictDoNothing();
    await tx.insert(s.activityLogs).values({
      action: "system.roles_migrated",
      entityType: "role",
      summary: `Migrated to two roles; ${toAgent.length} user(s) set to Sales Agent; removed ${obsoleteRoles.join(", ") || "no"} obsolete roles`,
      metadata: { obsoleteRoles, toAgent: toAgent.map((u) => u.id) },
    });
  });
  console.log("\nApplied.");
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
