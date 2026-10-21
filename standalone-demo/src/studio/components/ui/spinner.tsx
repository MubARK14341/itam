import { Loader2 } from "lucide-react";

export function Spinner({ label, className = "" }: { label?: string; className?: string }) {
  return (
    <span role={label ? "status" : undefined} className={`inline-flex items-center gap-2 text-[13px] text-muted ${className}`}>
      <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
      {label}
    </span>
  );
}
