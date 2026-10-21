import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`ui-surface ${className}`}>
      {children}
    </div>
  );
}

/** Card section header: title (+ optional description) on the start side, actions on the end side. */
export function CardHeader({
  title, description, actions, id, className = "",
}: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; id?: string; className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-5 sm:px-6 ${className}`}>
      <div className="min-w-0">
        <h2 id={id} className="font-display text-[18px] font-semibold text-fg">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
