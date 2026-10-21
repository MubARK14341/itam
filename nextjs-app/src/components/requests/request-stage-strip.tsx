import type { Tone } from "@/lib/tone";
import { AlertTriangle, CheckCircle2, ClipboardCheck, ClipboardList, PackageCheck, Truck } from "lucide-react";

export type StageCell = {
  key: string;
  label: string;
  caption: string;
  count: number | null;
  tone: Tone;
  pressed: boolean;
  onPick: () => void;
};

const STAGE_ICON = {
  all: ClipboardList, review: ClipboardCheck, fulfillment: PackageCheck,
  out: Truck, completed: CheckCircle2, overdue: AlertTriangle,
};

/** Studio summary strip; the existing stage controls also filter the request list. */
export function RequestStageStrip({ cells, label }: { cells: StageCell[]; label: string }) {
  return (
    <section aria-label={label} className="grid grid-cols-2 gap-3 overflow-hidden rounded-card bg-surface p-4 sm:grid-cols-3 sm:p-5 xl:grid-cols-6">
      {cells.map((cell) => {
        const hot = cell.tone === "bad" && (cell.count ?? 0) > 0;
        const Icon = STAGE_ICON[cell.key as keyof typeof STAGE_ICON] ?? ClipboardList;
        return (
          <button
            key={cell.key}
            type="button"
            aria-pressed={cell.pressed}
            onClick={cell.onPick}
            className={`flex min-w-0 items-center gap-3 rounded-control border-b-2 px-2 py-2.5 text-start transition-colors focus-visible:relative focus-visible:z-10 ${
              cell.pressed ? (cell.tone === "bad" ? "border-bad bg-bad-soft" : "border-brand bg-brand-soft") : "border-transparent hover:bg-surface-2"
            }`}
          >
            <Icon aria-hidden="true" className={`h-5 w-5 shrink-0 ${hot ? "text-bad" : "text-muted"}`} strokeWidth={1.6} />
            <span className="flex min-w-0 flex-col gap-1">
              <span className={`font-display text-[28px] font-medium leading-8 tabular-nums ${hot ? "text-bad" : "text-fg"}`}>
                {cell.count ?? "—"}
              </span>
              <span className="truncate text-xs font-medium text-muted">{cell.label}</span>
              <span className="sr-only">{cell.caption}</span>
            </span>
          </button>
        );
      })}
    </section>
  );
}
