"use client";

import { Check, AlertTriangle, X } from "lucide-react";
import type { RequestRow } from "@/lib/requests";
import { simplifiedRequestStatus, type DisplayRequestStatus } from "@/lib/request-fulfillment";
import { formatDate } from "@/lib/format";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";

// مراحل دورة حياة الطلب — عرض فقط، مشتق من الحالة المبسّطة (simplifiedRequestStatus) وطوابع الوقت الموجودة.
// لا ينفّذ أي انتقال؛ الأزرار الفعلية في رأس الصفحة (requestActionMap).
const STEP_KEYS = ["submitted", "review", "preparing", "ready", "delivered", "closed"] as const;
type StepKey = (typeof STEP_KEYS)[number];
type StepState = "done" | "current" | "warn" | "late" | "stopped" | "todo";

/** Index of the step the request is currently at (steps before it are done). 6 = everything done. */
function currentStepIndex(display: DisplayRequestStatus): number {
  switch (display) {
    case "draft": return 0;
    case "under_review":
    case "needs_clarification": return 1;
    case "preparing":
    case "awaiting_supply": return 2;
    case "ready_for_pickup": return 4;
    case "delivered":
    case "returned": return 5;
    case "completed": return 6;
    default: return 1;
  }
}

export function RequestLifecycleStepper({ request, overdue }: { request: RequestRow; overdue: boolean }) {
  const { t, lang } = useAppPreferences();
  const tl = t.requests.ledger;
  const display = simplifiedRequestStatus(request.status);
  const statusLabel = (t.requestStatus as Record<string, string>)[display] ?? display;
  const stopped = display === "rejected" || display === "cancelled";
  const stopIndex = display === "rejected" ? 1 : request.approved_at ? 2 : 1;
  const current = stopped ? stopIndex : currentStepIndex(display);

  const dateFor: Record<StepKey, string | null> = {
    submitted: request.created_at,
    review: request.approved_at ?? request.rejected_at,
    preparing: request.prepared_at,
    ready: null,
    delivered: request.delivered_at,
    closed: request.returned_at,
  };

  const steps = STEP_KEYS.map((key, index) => {
    let state: StepState = index < current ? "done" : index === current ? "current" : "todo";
    let caption: string | null = null;
    if (index === current) {
      if (stopped) { state = "stopped"; caption = statusLabel; }
      else if (key === "closed" && overdue) { state = "late"; caption = tl.stepOverdue; }
      else if (display === "needs_clarification" || display === "awaiting_supply") { state = "warn"; caption = statusLabel; }
      else if (key === "closed" && display === "delivered" && request.return_date) {
        caption = tl.stepDue.replace("{date}", formatDate(request.return_date, lang));
      } else caption = index === 0 || key === "delivered" || key === "closed" ? statusLabel : tl.stepCurrent;
    }
    const date = state === "todo" ? null : dateFor[key];
    return { key, index, state, caption, date };
  });

  return (
    <section tabIndex={0} aria-label={tl.lifecycleLabel} className="ui-surface overflow-x-auto p-5 sm:p-6">
      <ol className="grid min-w-[620px] grid-cols-6">
        {steps.map((step) => {
          const reached = step.state !== "todo";
          return (
            <li key={step.key} aria-current={step.index === current ? "step" : undefined}
              className="relative flex flex-col items-center gap-1 px-1 text-center">
              {step.index > 0 && (
                <span aria-hidden="true" className={`absolute -start-1/2 top-[15px] h-0.5 w-full ${reached ? "bg-ok" : "bg-line-strong"}`} />
              )}
              <span aria-hidden="true" className={`relative z-[1] inline-flex h-[30px] w-[30px] items-center justify-center rounded-full text-[12.5px] font-semibold tabular-nums ${
                step.state === "done" ? "bg-[rgb(var(--hero))] text-white"
                : step.state === "current" ? "bg-brand text-brand-on"
                : step.state === "warn" ? "bg-warn-soft text-warn ring-2 ring-warn"
                : step.state === "late" || step.state === "stopped" ? "bg-bad text-white ring-4 ring-bad-soft"
                : "bg-sunk text-muted"
              }`}>
                {step.state === "done" ? <Check className="h-4 w-4" strokeWidth={2.4} />
                  : step.state === "late" || step.state === "warn" ? <AlertTriangle className="h-4 w-4" />
                  : step.state === "stopped" ? <X className="h-4 w-4" strokeWidth={2.4} />
                  : step.index + 1}
              </span>
              <span className={`mt-1.5 text-[13.5px] font-semibold ${reached ? "text-fg" : "text-muted"}`}>{tl.steps[step.key]}</span>
              {step.date && <span className="text-xs tabular-nums text-muted" dir={lang === "ar" ? "rtl" : "ltr"}>{formatDate(step.date, lang)}</span>}
              {step.caption && (
                <span className={`text-xs ${step.state === "late" || step.state === "stopped" ? "font-semibold text-bad" : step.state === "warn" ? "font-semibold text-warn" : "text-brand-ink"}`}>
                  {step.caption}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
