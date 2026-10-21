import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Designed empty/zero state: icon tile, title, one line of help, optional action. */
export function EmptyState({
  icon: Icon, title, description, action, className = "", compact = false,
}: {
  icon?: LucideIcon; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string; compact?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-14"} ${className}`}>
      {Icon && (
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-sunk text-muted">
          <Icon aria-hidden="true" className="h-5 w-5" />
        </span>
      )}
      <p className="font-display text-[15px] font-semibold text-fg">{title}</p>
      {description && <p className="max-w-sm text-[13px] text-muted">{description}</p>}
      {action && <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
