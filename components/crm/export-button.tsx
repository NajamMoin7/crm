import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toQueryString, type RawSearchParams } from "@/lib/filters";

/** Downloads the currently filtered records as CSV. The server re-applies scoping and audits the export. */
export function ExportButton({ dataset, searchParams, label = "Export CSV" }: { dataset: string; searchParams: RawSearchParams; label?: string }) {
  const rest = Object.fromEntries(Object.entries(searchParams).filter(([k]) => k !== "page"));
  return (
    <Button asChild variant="outline" size="sm">
      <a href={`/api/export/${dataset}${toQueryString(rest)}`} download>
        <Download /> {label}
      </a>
    </Button>
  );
}
