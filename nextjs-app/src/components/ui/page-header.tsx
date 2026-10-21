import type { ReactNode } from "react";

/** Studio page heading. Actions and copy remain owned by each operational page. */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`mb-7 flex flex-wrap items-end justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        {eyebrow && <p className="mb-1 text-[13px] font-medium text-muted">{eyebrow}</p>}
        <h1 className="font-display text-[27px] font-semibold leading-[1.5] tracking-tight text-fg sm:text-[32px]">{title}</h1>
        {description && <p className="mt-1 text-[13px] leading-6 text-muted">{description}</p>}
      </div>
      {actions && <div className="page-header-actions flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
