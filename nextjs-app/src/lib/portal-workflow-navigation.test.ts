import { describe, expect, it } from "vitest";
import {
  portalDashboardBucket,
  portalDashboardFilterFromQuery,
  portalDisplayKey,
} from "@/lib/portal-status";

describe("portal workflow navigation", () => {
  it("maps actionable dashboard queues to the same list buckets", () => {
    expect(portalDashboardBucket(portalDisplayKey("needs_clarification", null))).toBe("clarify");
    expect(portalDashboardBucket(portalDisplayKey("preparing", null))).toBe("in_progress");
    expect(portalDashboardBucket(portalDisplayKey("returned", null))).toBe("completed");
    expect(portalDashboardBucket(portalDisplayKey("under_review", "pending_project_manager"))).toBe("pending_pm");
  });

  it("rejects unsupported or fabricated dashboard filters", () => {
    expect(portalDashboardFilterFromQuery("clarify")).toBe("clarify");
    expect(portalDashboardFilterFromQuery("open")).toBeNull();
    expect(portalDashboardFilterFromQuery("anything")).toBeNull();
  });
});
