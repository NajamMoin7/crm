import "server-only";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db";
import {
  brandLegalEntities,
  brands,
  customers,
  integrationRuns,
  integrationSources,
  paymentMethod,
  productsServices,
  tasks,
  userBrandAccess,
  userRoles,
  users,
} from "@/lib/db/schema";
import { logActivity } from "@/lib/audit";
import { BusinessRuleError } from "@/lib/actions";
import type { Viewer } from "@/lib/auth/viewer";

/** Uploaded logos are stored as data URLs. SVG is refused (it can carry script). */
const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
export const MAX_LOGO_BYTES = 150 * 1024;

/** A brand is just a name and an optional logo. Everything else is derived. */
export const brandSchema = z.object({
  name: z.string().trim().min(2, "Brand name is required.").max(60),
  /** undefined = keep, null = remove, string = new data URL. */
  logo: z
    .string()
    .nullable()
    .optional()
    .refine((v) => v == null || LOGO_RE.test(v), "Upload a PNG, JPEG or WebP image.")
    .refine((v) => v == null || Math.floor((v.length - v.indexOf(",") - 1) * 0.75) <= MAX_LOGO_BYTES, "Logo must be 150 KB or smaller."),
});
export type BrandInput = z.input<typeof brandSchema>;

const PALETTE = ["#2a78d6", "#eb6834", "#0f9a70", "#c98500", "#6250d6", "#d55181", "#e34948", "#008300"];

function initials(name: string) {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2)).toUpperCase() || "BR";
}

/** Short unique code (also the invoice prefix): initials or first letters, de-duplicated with a digit. */
async function uniqueCode(tx: DbOrTx, name: string) {
  const letters = name.toUpperCase().replace(/[^A-Z0-9 ]/g, "");
  const words = letters.split(" ").filter(Boolean);
  const base = (words.length >= 3 ? words.map((w) => w[0]).join("") : words.length === 2 ? words[0].slice(0, 2) + words[1][0] : letters.replace(/ /g, "").slice(0, 3)).slice(0, 4) || "BRD";
  const taken = new Set((await tx.select({ code: brands.code, prefix: brands.invoicePrefix }).from(brands)).flatMap((b) => [b.code, b.prefix]));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(`${base.slice(0, 3)}${i}`)) return `${base.slice(0, 3)}${i}`;
  throw new BusinessRuleError("Could not derive a unique brand code — try a different name.");
}

async function assertNameFree(tx: DbOrTx, name: string, exceptId?: string) {
  const [dupe] = await tx.select({ id: brands.id }).from(brands).where(eq(sql`lower(${brands.name})`, name.toLowerCase()));
  if (dupe && dupe.id !== exceptId) throw new BusinessRuleError("A brand with this name already exists.", { name: ["Name already in use."] });
}

export async function createBrand(tx: DbOrTx, viewer: Viewer, raw: BrandInput) {
  const input = brandSchema.parse(raw);
  await assertNameFree(tx, input.name);
  const code = await uniqueCode(tx, input.name);
  const id = `BRD-${code}`;
  const n = (await tx.select({ id: brands.id }).from(brands)).length;
  const now = new Date();
  await tx.insert(brands).values({
    id,
    code,
    name: input.name,
    domain: "",
    color: PALETTE[n % PALETTE.length],
    logoText: initials(input.name),
    logoUrl: input.logo ?? null,
    status: "active",
    invoicePrefix: code,
    // Sensible billing defaults; nothing to configure.
    defaultCurrency: "USD",
    allowedCurrencies: ["USD"],
    paymentTermsDays: 14,
    defaultTaxRate: "0",
    allowedPaymentMethods: [...paymentMethod.enumValues],
    createdAt: now,
    updatedAt: now,
  });
  // Super Admins always have every brand; agents are assigned on the Agents page.
  const admins = await tx.select({ id: users.id }).from(users).innerJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.roleId, "super_admin")));
  if (admins.length) await tx.insert(userBrandAccess).values(admins.map((a) => ({ userId: a.id, brandId: id, grantedBy: viewer.id }))).onConflictDoNothing();
  await logActivity(tx, { actorId: viewer.id, action: "brand.created", entityType: "brand", entityId: id, brandId: id, summary: `Brand ${input.name} created (${id})`, metadata: { logo: !!input.logo } });
  return { id };
}

export async function updateBrand(tx: DbOrTx, viewer: Viewer, id: string, raw: BrandInput) {
  const input = brandSchema.parse(raw);
  const [existing] = await tx.select().from(brands).where(eq(brands.id, id));
  if (!existing) throw new BusinessRuleError("Brand not found.");
  await assertNameFree(tx, input.name, id);
  const changes: string[] = [];
  if (input.name !== existing.name) changes.push("name");
  if (input.logo !== undefined && input.logo !== existing.logoUrl) changes.push(input.logo ? "logo" : "logo removed");
  if (!changes.length) return { changed: false };
  await tx
    .update(brands)
    .set({
      name: input.name,
      logoText: input.name !== existing.name ? initials(input.name) : existing.logoText,
      logoUrl: input.logo === undefined ? existing.logoUrl : input.logo,
      updatedAt: new Date(),
    })
    .where(eq(brands.id, id));
  await logActivity(tx, {
    actorId: viewer.id,
    action: "brand.updated",
    entityType: "brand",
    entityId: id,
    brandId: id,
    summary: `Brand ${input.name}: ${changes.join(", ")} updated`,
    metadata: { from: existing.name, to: input.name },
  });
  return { changed: true };
}

/**
 * Deletes a brand that has no business history. Brands with customers, sales,
 * invoices, payments or chargebacks can't be deleted — financial records are
 * never erased. Configuration rows (agent access, products, integration
 * placeholder) are removed with the brand.
 */
export async function deleteBrand(tx: DbOrTx, viewer: Viewer, id: string) {
  const [brand] = await tx.select().from(brands).where(eq(brands.id, id));
  if (!brand) throw new BusinessRuleError("Brand not found.");
  // Tables holding business history for a brand (all have a brand_id column).
  const HISTORY: [string, string][] = [
    ["customers", "customer_brand_relationships"],
    ["sales", "sales"],
    ["invoices", "invoices"],
    ["payments", "transactions"],
    ["chargebacks", "chargeback_cases"],
    ["leads", "leads"],
    ["adjustments", "financial_adjustments"],
    ["reconciliation records", "reconciliation_records"],
  ];
  const blocking: [string, number][] = [];
  for (const [label, table] of HISTORY) {
    const res = await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where brand_id = ${id}`);
    const n = Number(res.rows[0]?.n ?? 0);
    if (n > 0) blocking.push([label, n]);
  }
  if (blocking.length) {
    throw new BusinessRuleError(
      `${brand.name} can't be deleted: it has ${blocking.map(([k, n]) => `${n} ${k}`).join(", ")}. Financial history is never erased.`,
    );
  }
  await tx.update(customers).set({ firstBrandId: null }).where(eq(customers.firstBrandId, id));
  await tx.delete(tasks).where(eq(tasks.brandId, id));
  await tx.delete(productsServices).where(eq(productsServices.brandId, id));
  await tx.delete(brandLegalEntities).where(eq(brandLegalEntities.brandId, id));
  await tx.delete(userBrandAccess).where(eq(userBrandAccess.brandId, id));
  const sources = await tx.select({ id: integrationSources.id }).from(integrationSources).where(eq(integrationSources.brandId, id));
  for (const s of sources) await tx.delete(integrationRuns).where(eq(integrationRuns.sourceId, s.id));
  await tx.delete(integrationSources).where(eq(integrationSources.brandId, id));
  await tx.delete(brands).where(eq(brands.id, id));
  await logActivity(tx, { actorId: viewer.id, action: "brand.deleted", entityType: "brand", entityId: id, summary: `Brand ${brand.name} (${id}) deleted` });
  return { name: brand.name };
}
