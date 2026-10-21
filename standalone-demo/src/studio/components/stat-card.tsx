import { Card } from "@/components/ui/card";
import type { LucideIcon } from "lucide-react";

export function StatCard({
  label, value, icon: Icon, tone = "slate", hint,
}: {
  label: string; value: number | string; icon: LucideIcon;
  tone?: "slate" | "emerald" | "blue" | "amber" | "rose" | "teal";
  hint?: string;
}) {
  const tones: Record<string, string> = {
    slate: "bg-sunk text-fg-2",
    emerald: "bg-ok-soft text-ok",
    blue: "bg-brand-soft text-brand-ink",
    amber: "bg-warn-soft text-warn",
    rose: "bg-bad-soft text-bad",
    teal: "bg-brand-soft text-brand-ink",
  };
  return (
    <Card className="px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium text-muted">{label}</p>
          <p className="mt-1 font-display text-[28px] font-semibold leading-9 tabular-nums text-fg">{value}</p>
          {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
        </div>
        <div className={`rounded-control p-2 ${tones[tone]}`}>
          <Icon aria-hidden="true" className="h-5 w-5" />
        </div>
      </div>
    </Card>
  );
}
