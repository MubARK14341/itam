import type { Tone } from "@/lib/tone";

/** One segment of a 4-stage progress line: filled with a tone, or empty (null). */
export type StageFill = Tone | null;

export type StageModel = {
  /** Fill of each of the four segments. */
  fills: [StageFill, StageFill, StageFill, StageFill];
  /** Index of the current stage (0–3), or -1 when the request closed before any stage. */
  current: number;
  /** Tone of the current stage label (defaults to ink). */
  tone?: Tone;
};

const FILL: Record<Tone, string> = {
  info: "bg-brand", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", res: "bg-res", neu: "bg-line-strong",
};
const LABEL_TONE: Partial<Record<Tone, string>> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", res: "text-res" };

/**
 * Ledger 4-stage progress line (bars + labels). Purely presentational: the stage model is
 * derived by the caller from the existing status helpers. Announced as one image with a label.
 */
export function StageProgress({
  stages, model, label, className = "",
}: {
  stages: [string, string, string, string];
  model: StageModel;
  label: string;
  className?: string;
}) {
  return (
    <span role="img" aria-label={label} className={`grid grid-cols-4 gap-2 ${className}`}>
      {stages.map((stage, i) => {
        const fill = model.fills[i];
        const on = i === model.current;
        return (
          <span key={stage} aria-hidden="true" className="min-w-0">
            <span className={`block h-[3px] rounded-full ${fill ? FILL[fill] : "bg-sunk"}`} />
            <span className={`mt-2 block truncate text-xs ${on ? `font-semibold ${(model.tone && LABEL_TONE[model.tone]) || "text-fg"}` : "text-muted"}`}>
              {stage}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** "Stage {n} of 4: {stage}" / closed label for the progress line's accessible name. */
export function stageAriaLabel(template: string, closed: string, stages: string[], current: number) {
  if (current < 0) return closed;
  return template.replace("{n}", String(current + 1)).replace("{stage}", stages[current] ?? "");
}
