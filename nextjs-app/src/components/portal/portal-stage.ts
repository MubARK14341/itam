import type { StageModel } from "@/components/self-service/stage-progress";
import type { PortalStatusKey } from "@/lib/portal-status";
import type { Tone } from "@/lib/tone";

// Presentation-only: the client's 4-stage line (Review → Preparing → Delivery → Completion),
// derived from the simplified portal status key (portalDisplayKey). The raw status is only
// consulted to flag an overdue return on the last stage.
export function portalRequestStage(key: PortalStatusKey, rawStatus?: string | null): StageModel {
  const f = (...fills: (Tone | null)[]) => [fills[0] ?? null, fills[1] ?? null, fills[2] ?? null, fills[3] ?? null] as StageModel["fills"];
  switch (key) {
    case "draft": return { fills: f(), current: 0 };
    case "reviewing": return { fills: f("info"), current: 0 };
    case "pending_pm":
    case "clarify": return { fills: f("warn"), current: 0, tone: "warn" };
    case "accepted":
    case "preparing": return { fills: f("info", "info"), current: 1 };
    case "delivered":
      return rawStatus === "overdue"
        ? { fills: f("info", "info", "info", "bad"), current: 3, tone: "bad" }
        : { fills: f("info", "info", "info"), current: 2 };
    case "returned":
    case "completed": return { fills: f("ok", "ok", "ok", "ok"), current: 3, tone: "ok" };
    case "rejected":
    case "pm_rejected": return { fills: f("bad"), current: 0, tone: "bad" };
    case "cancelled": return { fills: f(), current: -1 };
    default: return { fills: f("info"), current: 0 };
  }
}
