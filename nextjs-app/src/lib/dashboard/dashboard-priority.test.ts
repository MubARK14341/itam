import { describe, expect, it } from "vitest";
import { compareDashboardPriority, dashboardSlaStatus, selectDashboardPriorities } from "./priority-selector";
import type { DashboardPriorityItem } from "./dashboard-types";

function priority(overrides: Partial<DashboardPriorityItem> = {}): DashboardPriorityItem {
  return {
    id: "row-a",
    kind: "overdue_request",
    severity: "critical",
    entityType: "request",
    entityId: "a",
    entityLabel: "REQ-A",
    createdAt: "2026-07-01T00:00:00.000Z",
    dueAt: "2026-07-10",
    overdueDays: 5,
    owner: null,
    ownerKind: "operations_queue",
    location: null,
    company: null,
    status: "overdue",
    slaStatus: "overdue",
    impact: "custody",
    href: "/requests/a",
    action: "review",
    ...overrides,
  };
}

describe("stable dashboard priority selection", () => {
  it("orders severity, overdue duration, SLA deadline, age, then stable ID", () => {
    const rows = [
      priority({ id: "warning", entityId: "warning", severity: "warning", overdueDays: 99 }),
      priority({ id: "critical-short", entityId: "b", overdueDays: 2 }),
      priority({ id: "critical-long-new", entityId: "c", overdueDays: 8, createdAt: "2026-07-02T00:00:00Z" }),
      priority({ id: "critical-long-old-b", entityId: "e", overdueDays: 8, createdAt: "2026-06-01T00:00:00Z" }),
      priority({ id: "critical-long-old-a", entityId: "d", overdueDays: 8, createdAt: "2026-06-01T00:00:00Z" }),
    ];
    expect(selectDashboardPriorities(rows).map((row) => row.id)).toEqual([
      "critical-long-old-a",
      "critical-long-old-b",
      "critical-long-new",
      "critical-short",
      "warning",
    ]);
    expect(compareDashboardPriority(rows[0], rows[1])).toBeGreaterThan(0);
  });

  it("deduplicates one semantic entity candidate and applies the bound", () => {
    const duplicate = priority();
    expect(selectDashboardPriorities([duplicate, { ...duplicate }], 6)).toHaveLength(1);
    expect(selectDashboardPriorities([
      priority({ entityId: "1" }),
      priority({ entityId: "2" }),
      priority({ entityId: "3" }),
    ], 2)).toHaveLength(2);
  });

  it("maps due dates to deterministic SLA states", () => {
    const now = "2026-07-14T12:00:00Z";
    expect(dashboardSlaStatus(null, now)).toBe("not_applicable");
    expect(dashboardSlaStatus("2026-07-13", now)).toBe("overdue");
    expect(dashboardSlaStatus("2026-07-14", now)).toBe("due_today");
    expect(dashboardSlaStatus("2026-07-16", now)).toBe("at_risk");
    expect(dashboardSlaStatus("2026-07-17", now)).toBe("on_track");
  });
});
