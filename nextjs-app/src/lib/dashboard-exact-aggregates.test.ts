import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { selectDashboardV2, type DashboardV2Raw } from "./dashboard-v2";
import { ar } from "./translations/ar";

const sql = fs.readFileSync(
  path.join(process.cwd(), "migrations/20260727154633_dashboard_exact_aggregates.sql"),
  "utf8",
);

describe("dashboard exact aggregates", () => {
  it("uses the DB summary when the detail projection is capped at 1,000 rows", () => {
    const raw: DashboardV2Raw = {
      assets: Array.from({ length: 1_000 }, (_, index) => ({
        id: `asset-${index}`,
        status: index < 700 ? "available" : "reserved",
        asset_tag: `A-${index}`,
      })),
      consumables: [],
      maintenance: [],
      trendRows: [],
      trendUnavailable: false,
      trendCounts: { reported: 0, completed: 0 },
      summary: {
        assets: {
          total: 1_500,
          available: 1_000,
          reserved: 400,
          in_maintenance: 50,
        },
        consumables: { at_risk: 0, stockout: 0, without_threshold: 0 },
        maintenance: { long_open: 0, no_action: 0, followup: 0 },
        requests: {
          actionable: 0,
          overdue: 0,
          preparation: 0,
          ready_delivery: 0,
          returns_due: 0,
          returned_inspection: 0,
        },
      },
    };
    const result = selectDashboardV2(raw, {
      period: "all",
      location: "",
      department: "",
      status: "",
      category: "",
    }, ar);

    expect(result.kpis.total).toBe(1_500);
    expect(result.kpis.available).toBe(1_000);
    expect(result.kpis.reserved).toBe(400);
    expect(result.kpis.in_maintenance).toBe(50);
  });

  it("counts stockout and at-risk inventory over the full table in SQL", () => {
    expect(sql).toContain("count(*) filter (where quantity_on_hand = 0) as stockout");
    expect(sql).toMatch(/reorder_level > 0 and quantity_on_hand <= reorder_level/);
    expect(sql).toContain("function public.dashboard_operational_summary()");
  });

  it("uses one unique maintenance-record follow-up semantic", () => {
    expect(sql).toMatch(/or \(\s*nullif\(btrim\(action_taken\), ''\) is null[\s\S]*technician_id is null/);
    expect(sql).toContain(") as followup");
  });
});
