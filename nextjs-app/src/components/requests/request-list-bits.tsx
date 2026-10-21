import type { ReactNode } from "react";
import type { Tone } from "@/lib/tone";

// Small presentational pieces shared by the requests list, stage board and warehouse view.

export type RequestParty = "portal" | "customer" | "employee";

/** Background colour for a tone dot (legend dots, stage strip, board columns). */
export const TONE_DOT: Record<Tone, string> = {
  ok: "bg-ok", res: "bg-res", warn: "bg-warn", bad: "bg-bad", info: "bg-brand", neu: "bg-muted",
};

/** Outlined source tag (Portal / Customer / Employee) — text, never colour alone. */
export function PartyTag({ children }: { children: ReactNode }) {
  return (
    <span dir="auto" className="inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-md border border-line-strong px-1.5 text-[11px] font-semibold leading-none text-fg-2">
      {children}
    </span>
  );
}

/** LTR-isolated request number in the mono face. */
export function RequestNumber({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <bdi dir="ltr" className={`whitespace-nowrap font-mono font-medium tabular-nums ${className}`}>{children}</bdi>;
}

export function initialsOf(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  return parts.length === 1 ? parts[0].slice(0, 2) : `${parts[0][0]}${parts[1][0]}`;
}

/** Responsible staff member: initials avatar + name, or a dashed placeholder when unassigned. */
export function ResponsibleCell({ label, unassignedLabel, compact = false }: { label: string | null; unassignedLabel: string; compact?: boolean }) {
  if (!label) {
    return (
      <span className="inline-flex items-center gap-2 text-muted" title={compact ? unassignedLabel : undefined}>
        <span aria-hidden="true" className={`${compact ? "h-6 w-6" : "h-7 w-7"} shrink-0 rounded-full border border-dashed border-line-strong`} />
        {compact ? <span className="sr-only">{unassignedLabel}</span> : <span className="text-[13px]">{unassignedLabel}</span>}
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-2" title={compact ? label : undefined}>
      <span aria-hidden="true" className={`ui-avatar ${compact ? "h-6 w-6 text-[10px]" : ""}`}>{initialsOf(label)}</span>
      {compact ? <span className="sr-only">{label}</span> : <span className="truncate text-[13px] text-fg">{label}</span>}
    </span>
  );
}
