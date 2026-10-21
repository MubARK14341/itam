import type { ReactNode } from "react";
import { toneChipClass, type Tone } from "@/lib/tone";

/** Status chip: dot + text in one of the six Ledger tones. */
export function StatusChip({
  tone, children, className = "", dot = true, size = "md",
}: {
  tone: Tone | null | undefined; children: ReactNode; className?: string; dot?: boolean; size?: "sm" | "md";
}) {
  return (
    <span className={`ui-chip ${toneChipClass(tone)} ${size === "sm" ? "h-[22px] px-2 text-[11.5px]" : ""} ${className}`}>
      {dot && <span aria-hidden="true" className="ui-chip-dot" />}
      {children}
    </span>
  );
}
