"use server";

import { refresh } from "next/cache";
import { getDb } from "@/lib/db";
import { authorize } from "@/lib/auth/viewer";
import { runAction } from "@/lib/actions";
import type { ActionResult } from "@/lib/action-result";
import { createBrand, deleteBrand, updateBrand, type BrandInput } from "@/lib/services/brands";

export async function createBrandAction(input: BrandInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const viewer = await authorize("brands.manage");
    const db = await getDb();
    const res = await db.transaction((tx) => createBrand(tx, viewer, input));
    refresh();
    return { ok: true, data: res, message: `Brand created (${res.id}).` };
  });
}

export async function updateBrandAction(id: string, input: BrandInput): Promise<ActionResult> {
  return runAction(async () => {
    const viewer = await authorize("brands.manage");
    const db = await getDb();
    const res = await db.transaction((tx) => updateBrand(tx, viewer, String(id), input));
    refresh();
    return { ok: true, message: res.changed ? "Brand updated." : "No changes to save." };
  });
}

export async function deleteBrandAction(id: string): Promise<ActionResult> {
  return runAction(async () => {
    const viewer = await authorize("brands.manage");
    const db = await getDb();
    const res = await db.transaction((tx) => deleteBrand(tx, viewer, String(id)));
    refresh();
    return { ok: true, message: `${res.name} deleted.` };
  });
}
