import Link from "next/link";
import type { ReactNode } from "react";
import { TONE_TEXT, type Tone } from "@/lib/tone";

export type KpiItem = {
  key: string;
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  href?: string;
  tone?: Tone;
};

/** One card split into equal KPI cells (Ledger KPI band). Cells become links when href is set. */
export function KpiBand({ items, label, className = "" }: { items: KpiItem[]; label?: string; className?: string }) {
  const cols = items.length >= 4 ? "lg:grid-cols-4" : items.length === 3 ? "lg:grid-cols-3" : "lg:grid-cols-2";
  return (
    <section aria-label={label} className={`ui-surface grid grid-cols-2 overflow-hidden ${cols} ${className}`}>
      {items.map((item, i) => {
        const body = (
          <>
            <span className="text-[13px] font-medium text-muted">{item.label}</span>
            <span className={`font-display text-[28px] font-semibold leading-9 tabular-nums ${item.tone ? TONE_TEXT[item.tone] : "text-fg"}`}>{item.value}</span>
            {item.hint && <span className="text-xs text-muted">{item.hint}</span>}
          </>
        );
        const cell = `flex min-w-0 flex-col gap-1 px-5 py-4 ${i % 2 === 1 ? "border-s border-line" : ""} ${i >= 2 ? "border-t border-line lg:border-t-0" : ""} ${i > 0 ? "lg:border-s lg:border-line" : ""}`;
        return item.href ? (
          <Link key={item.key} href={item.href} prefetch={false} className={`${cell} transition-colors hover:bg-surface-2`}>{body}</Link>
        ) : (
          <div key={item.key} className={cell}>{body}</div>
        );
      })}
    </section>
  );
}
