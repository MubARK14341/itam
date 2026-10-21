import type { StageModel } from "@/components/self-service/stage-progress";
import type { Tone } from "@/lib/tone";

// Presentation-only mapping of the raw request status to the employee's 4-stage line
// (Review → Preparing → Ready → Delivered). No workflow logic lives here.
export function employeeRequestStage(status: string): StageModel {
  const f = (...fills: (Tone | null)[]) => [fills[0] ?? null, fills[1] ?? null, fills[2] ?? null, fills[3] ?? null] as StageModel["fills"];
  switch (status) {
    case "draft": return { fills: f(), current: 0 };
    case "under_review": return { fills: f("info"), current: 0 };
    case "needs_clarification": return { fills: f("warn"), current: 0, tone: "warn" };
    case "approved":
    case "auto_provisioning":
    case "provisioned":
    case "preparing": return { fills: f("info", "info"), current: 1 };
    case "stock_shortage": return { fills: f("info", "warn"), current: 1, tone: "warn" };
    case "ready_for_pickup": return { fills: f("info", "info", "ok"), current: 2, tone: "ok" };
    case "delivered":
    case "partially_returned": return { fills: f("info", "info", "info", "info"), current: 3 };
    case "overdue": return { fills: f("info", "info", "info", "bad"), current: 3, tone: "bad" };
    case "returned":
    case "completed": return { fills: f("ok", "ok", "ok", "ok"), current: 3, tone: "ok" };
    case "rejected": return { fills: f("bad"), current: 0, tone: "bad" };
    case "cancelled": return { fills: f(), current: -1 };
    default: return { fills: f("info"), current: 0 };
  }
}

/** Requests that no longer need the employee's attention (frontend view split only). */
export const EMPLOYEE_DONE_STATUSES = new Set(["completed", "returned", "rejected", "cancelled"]);
