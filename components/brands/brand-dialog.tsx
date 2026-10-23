"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ImagePlus, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, fieldAria } from "@/components/customers/field";
import { BrandMark } from "@/components/crm/brand-badge";
import { createBrandAction, updateBrandAction } from "@/app/(crm)/brands/actions";

export type EditableBrand = { id: string; name: string; code: string; color: string; logoUrl: string | null };

const MAX_BYTES = 150 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Create or edit a brand: name and logo. Everything else is automatic. */
export function BrandDialog({ brand }: { brand?: EditableBrand }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(brand?.name ?? "");
  // undefined = unchanged, null = removed, string = new upload
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  const [errors, setErrors] = useState<Record<string, string[] | undefined>>({});
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => setOpen(false), []);

  const openDialog = () => {
    setName(brand?.name ?? "");
    setLogo(undefined);
    setErrors({});
    setOpen(true);
  };

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    if (!TYPES.includes(file.type)) return setErrors((e) => ({ ...e, logo: ["Upload a PNG, JPEG or WebP image."] }));
    if (file.size > MAX_BYTES) return setErrors((e) => ({ ...e, logo: ["Logo must be 150 KB or smaller."] }));
    const reader = new FileReader();
    reader.onload = () => {
      setLogo(String(reader.result));
      setErrors((e) => ({ ...e, logo: undefined }));
    };
    reader.readAsDataURL(file);
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 2) return setErrors({ name: ["Brand name is required."] });
    start(async () => {
      const res = brand ? await updateBrandAction(brand.id, { name, logo }) : await createBrandAction({ name, logo });
      if (res.ok) {
        toast.success(res.message ?? "Saved");
        setOpen(false);
        router.refresh();
      } else {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
      }
    });
  };

  const preview = logo === undefined ? (brand?.logoUrl ?? null) : logo;
  const previewBrand = { code: brand?.code ?? (name.trim().slice(0, 2).toUpperCase() || "BR"), color: brand?.color ?? "#c9a227", name: name || "New brand", logoUrl: preview };

  return (
    <>
      {brand ? (
        <Button variant="ghost" size="sm" onClick={openDialog} aria-label={`Edit ${brand.name}`}>
          <Pencil /> Edit
        </Button>
      ) : (
        <Button size="sm" onClick={openDialog}>
          <Plus /> New brand
        </Button>
      )}
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{brand ? `Edit ${brand.name}` : "New brand"}</DialogTitle>
            <DialogDescription>{brand ? <span className="font-mono">{brand.id}</span> : "Just a name and, optionally, a logo."}</DialogDescription>
          </DialogHeader>
          <form id="brand-form" className="grid gap-5" noValidate onSubmit={save}>
            <Field id="b-name" label="Brand name" required error={errors.name}>
              <Input {...fieldAria("b-name", errors.name)} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" />
            </Field>
            <Field id="b-logo" label="Brand logo" error={errors.logo} hint="PNG, JPEG or WebP, up to 150 KB">
              <div className="flex items-center gap-3">
                <BrandMark brand={previewBrand} size="lg" />
                <input ref={fileRef} id="b-logo" type="file" accept={TYPES.join(",")} className="sr-only" onChange={(e) => pickFile(e.target.files?.[0])} />
                <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                  <ImagePlus /> {preview ? "Change" : "Upload"}
                </Button>
                {preview && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setLogo(null)}>
                    <Trash2 /> Remove
                  </Button>
                )}
              </div>
            </Field>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" form="brand-form" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} {brand ? "Save changes" : "Create brand"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
