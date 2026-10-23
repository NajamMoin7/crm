"use client";

import { useState } from "react";
import { FlaskConical, KeyRound, Loader2, PlugZap, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ActionButton } from "@/components/crm/action-button";
import { CheckboxGroup, Field, invalid, useCloseOnHide, useServerAction } from "@/components/admin/form-kit";
import { dryRunAction, testConnectionAction, updateSyncConfigAction } from "@/app/(crm)/integrations/actions";

export function TestConnectionButton({ sourceId }: { sourceId: string }) {
  const { run, pending } = useServerAction(testConnectionAction);
  return (
    <Button variant="outline" size="sm" onClick={() => run(sourceId)} disabled={pending} data-testid={`test-${sourceId}`}>
      {pending ? <Loader2 className="animate-spin" /> : <PlugZap />} Test connection
    </Button>
  );
}

export function DryRunButton({ sourceId, brandName }: { sourceId: string; brandName: string }) {
  return (
    <ActionButton
      variant="outline"
      label={
        <>
          <FlaskConical /> Run dry-run import
        </>
      }
      confirmTitle={`Simulated dry run — ${brandName}`}
      confirmDescription={
        <>
          <p>This demo generates a plausible preview (records read, records flagged for review, validation errors).</p>
          <p className="mt-2 font-medium">No live system is contacted and no customer, invoice or payment data is written.</p>
        </>
      }
      confirmLabel="Run simulated dry run"
      action={() => dryRunAction(sourceId)}
    />
  );
}

const ENTITY_OPTS = [
  { value: "customers", label: "Customers" },
  { value: "invoices", label: "Invoices" },
  { value: "payments", label: "Payments" },
  { value: "chargebacks", label: "Chargebacks" },
  { value: "products", label: "Products" },
];

export type SyncConfigView = {
  mode: "pull" | "webhook";
  schedule: "manual" | "hourly" | "daily";
  entities: string[];
  batchSize: number;
  dryRunFirst: boolean;
  credentialsRef: string;
};

export function SyncConfigDialog({ sourceId, brandName, config, canEdit }: { sourceId: string; brandName: string; config: SyncConfigView; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Settings2 /> {canEdit ? "Sync configuration" : "View configuration"}
      </Button>
      {open && <SyncConfigForm sourceId={sourceId} brandName={brandName} config={config} canEdit={canEdit} onClose={() => setOpen(false)} />}
    </>
  );
}

function SyncConfigForm({
  sourceId,
  brandName,
  config,
  canEdit,
  onClose,
}: {
  sourceId: string;
  brandName: string;
  config: SyncConfigView;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [v, setV] = useState({ ...config, batchSize: String(config.batchSize) });
  const { run, pending, errors } = useServerAction(updateSyncConfigAction, { onSuccess: onClose });
  useCloseOnHide(onClose);
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV((p) => ({ ...p, [k]: val }));
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Sync configuration — {brandName}</DialogTitle>
          <DialogDescription>Non-secret settings only. Demo — no sync runs against a live system.</DialogDescription>
        </DialogHeader>
        <form
          id="sync-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            run(sourceId, { mode: v.mode, schedule: v.schedule, entities: v.entities as never, batchSize: v.batchSize, dryRunFirst: v.dryRunFirst });
          }}
        >
          <fieldset disabled={!canEdit || pending} className="grid gap-4 sm:grid-cols-2">
            <legend className="sr-only">Sync configuration</legend>
            <Field label="Sync mode" htmlFor="s-mode" error={errors.mode} hint={v.mode === "pull" ? "CRM pulls from the source on a schedule." : "Source pushes changes to a signed webhook."}>
              <Select value={v.mode} onValueChange={(m) => set("mode", m as typeof v.mode)} disabled={!canEdit || pending}>
                <SelectTrigger id="s-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pull">Pull (scheduled job)</SelectItem>
                  <SelectItem value="webhook">Webhook (push)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Schedule" htmlFor="s-schedule" error={errors.schedule}>
              <Select value={v.schedule} onValueChange={(s) => set("schedule", s as typeof v.schedule)} disabled={!canEdit || pending}>
                <SelectTrigger id="s-schedule" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual only</SelectItem>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <div className="sm:col-span-2">
              <CheckboxGroup
                legend="Record types to sync"
                columns={3}
                options={ENTITY_OPTS}
                value={v.entities}
                onChange={(next) => set("entities", next)}
                error={errors.entities}
                disabled={!canEdit || pending}
              />
            </div>
            <Field label="Batch size" htmlFor="s-batch" error={errors.batchSize} hint="50 – 5,000 records per batch.">
              <Input {...invalid("s-batch", errors.batchSize)} type="number" min={50} max={5000} step={50} value={v.batchSize} onChange={(e) => set("batchSize", e.target.value)} className="tabular" />
            </Field>
            <div className="flex items-center justify-between gap-3 self-start rounded-lg border px-3 py-2 sm:mt-5">
              <Label htmlFor="s-dry" className="text-sm font-normal">
                Dry run before each import
              </Label>
              <Switch id="s-dry" checked={v.dryRunFirst} onCheckedChange={(c) => set("dryRunFirst", c)} disabled={!canEdit || pending} />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <span className="text-xs font-medium">Credentials reference</span>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
                <KeyRound className="size-4 text-muted-foreground" aria-hidden />
                <code className="text-xs">{config.credentialsRef}</code>
                <span className="ml-auto text-[11px] text-muted-foreground">read-only</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Secrets are never stored in the database or sent to the browser. The CRM only keeps the <em>name</em> of a server environment variable; the
                connection string lives in the server&apos;s secret store.
              </p>
            </div>
          </fieldset>
        </form>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
            {canEdit ? "Cancel" : "Close"}
          </Button>
          {canEdit && (
            <Button type="submit" form="sync-form" size="sm" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Save configuration
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
