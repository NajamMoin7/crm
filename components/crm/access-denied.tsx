import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AccessDenied({ message }: { message?: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-24 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
        <ShieldAlert className="size-6 text-destructive" aria-hidden />
      </div>
      <h1 className="text-lg font-semibold">Access restricted</h1>
      <p className="text-sm text-muted-foreground">
        {message ??
          "Your role does not include permission to view this page or record. Ask a Super Admin if you need access."}
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href="/">Back to home</Link>
      </Button>
    </div>
  );
}
