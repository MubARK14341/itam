import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Toggle chip for quick filters (aria-pressed). Pressed state is ink-filled. */
export function FilterChip({
  pressed, count, children, className = "", ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> & { pressed: boolean; count?: number; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={pressed} className={`ui-fchip ${className}`} {...props}>
      {children}
      {count !== undefined && <span className="text-[11.5px] tabular-nums opacity-70">{count}</span>}
    </button>
  );
}
