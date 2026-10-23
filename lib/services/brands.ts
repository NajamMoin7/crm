import "server-only";
import { z } from "zod";
import { getDb, type TableKey } from "@/lib/db";
import { equalsCi } from "@/lib/db/query";
import { paymentMethod } from "@/lib/db/schema";
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
async function uniqueCode(name: string) {
  const letters = name.toUpperCase().replace(/[^A-Z0-9 ]/g, "");
  const words = letters.split(" ").filter(Boolean);
  const base = (words.length >= 3 ? words.map((w) => w[0]).join("") : words.length === 2 ? words[0].slice(0, 2) + words[1][0] : letters.replace(/ /g, "").slice(0, 3)).slice(0, 4) || "BRD";
  const C = await getDb();
  const taken = new Set((await C.brands.find({}, { projection: { code: 1, invoicePrefix: 1 } }).toArray()).flatMap((b) => [b.code, b.invoicePrefix]));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(`${base.slice(0, 3)}${i}`)) return `${base.slice(0, 3)}${i}`;
  throw new BusinessRuleError("Could not derive a unique brand code — try a different name.");
}

async function assertNameFree(name: string, exceptId?: string) {
  const C = await getDb();
  const dupe = await C.brands.findOne({ name: equalsCi(name) }, { projection: { id: 1 } });
  if (dupe && dupe.id !== exceptId) throw new BusinessRuleError("A brand with this name already exists.", { name: ["Name already in use."] });
}

export async function createBrand(viewer: Viewer, raw: BrandInput) {
  const input = brandSchema.parse(raw);
  const C = await getDb();
  await assertNameFree(input.name);
  const code = await uniqueCode(input.name);
  const id = `BRD-${code}`;
  const n = await C.brands.countDocuments();
  const now = new Date();
  await C.brands.insertOne({
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
  const admins = await C.userRoles.distinct("userId", { roleId: "super_admin" });
  for (const userId of admins) {
    await C.userBrandAccess.updateOne({ userId, brandId: id }, { $setOnInsert: { userId, brandId: id, grantedBy: viewer.id, grantedAt: now } }, { upsert: true });
  }
  await logActivity({ actorId: viewer.id, action: "brand.created", entityType: "brand", entityId: id, brandId: id, summary: `Brand ${input.name} created (${id})`, metadata: { logo: !!input.logo } });
  return { id };
}

export async function updateBrand(viewer: Viewer, id: string, raw: BrandInput) {
  const input = brandSchema.parse(raw);
  const C = await getDb();
  const existing = await C.brands.findOne({ id });
  if (!existing) throw new BusinessRuleError("Brand not found.");
  await assertNameFree(input.name, id);
  const changes: string[] = [];
  if (input.name !== existing.name) changes.push("name");
  if (input.logo !== undefined && input.logo !== existing.logoUrl) changes.push(input.logo ? "logo" : "logo removed");
  if (!changes.length) return { changed: false };
  await C.brands.updateOne(
    { id },
    {
      $set: {
      name: input.name,
      logoText: input.name !== existing.name ? initials(input.name) : existing.logoText,
      logoUrl: input.logo === undefined ? existing.logoUrl : input.logo,
      updatedAt: new Date(),
      },
    },
  );
  await logActivity({
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
export async function deleteBrand(viewer: Viewer, id: string) {
  const C = await getDb();
  const brand = await C.brands.findOne({ id });
  if (!brand) throw new BusinessRuleError("Brand not found.");
  // Collections holding business history for a brand (all have a brandId field).
  const HISTORY: [string, TableKey][] = [
    ["customers", "customerBrandRelationships"],
    ["sales", "sales"],
    ["invoices", "invoices"],
    ["payments", "transactions"],
    ["chargebacks", "chargebackCases"],
    ["leads", "leads"],
    ["adjustments", "financialAdjustments"],
    ["reconciliation records", "reconciliationRecords"],
  ];
  const blocking: [string, number][] = [];
  for (const [label, key] of HISTORY) {
    const n = await (C[key] as unknown as { countDocuments(f: object): Promise<number> }).countDocuments({ brandId: id });
    if (n > 0) blocking.push([label, n]);
  }
  if (blocking.length) {
    throw new BusinessRuleError(
      `${brand.name} can't be deleted: it has ${blocking.map(([k, n]) => `${n} ${k}`).join(", ")}. Financial history is never erased.`,
    );
  }
  await C.customers.updateMany({ firstBrandId: id }, { $set: { firstBrandId: null } });
  await C.tasks.deleteMany({ brandId: id });
  await C.productsServices.deleteMany({ brandId: id });
  await C.brandLegalEntities.deleteMany({ brandId: id });
  await C.userBrandAccess.deleteMany({ brandId: id });
  const sources = await C.integrationSources.distinct("id", { brandId: id });
  await C.integrationRuns.deleteMany({ sourceId: { $in: sources } });
  await C.integrationSources.deleteMany({ brandId: id });
  await C.brands.deleteOne({ id });
  await logActivity({ actorId: viewer.id, action: "brand.deleted", entityType: "brand", entityId: id, summary: `Brand ${brand.name} (${id}) deleted` });
  return { name: brand.name };
}
