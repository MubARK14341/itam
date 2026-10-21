import { describe, expect, it } from "vitest";
import { DASHBOARD_KPI_DEFINITIONS, dashboardKpiDefinition } from "./kpi-definitions";
import { ROLE_DASHBOARD_CONFIG, dashboardRoleConfig } from "./role-dashboard-config";
import type { DashboardKpiId, DashboardRole } from "./dashboard-types";

const roles: DashboardRole[] = ["admin", "it_manager", "technician", "warehouse_manager", "viewer", "auditor"];

describe("dashboard KPI registry", () => {
  it("defines every role-selected KPI exactly once", () => {
    const selected = new Set<DashboardKpiId>(roles.flatMap((role) => [...ROLE_DASHBOARD_CONFIG[role].kpis]));
    expect(Object.keys(DASHBOARD_KPI_DEFINITIONS).sort()).toEqual([...selected].sort());
    for (const id of selected) expect(dashboardKpiDefinition(id).id).toBe(id);
  });

  it("classifies every dashboard KPI as non-financial with a real drilldown", () => {
    for (const definition of Object.values(DASHBOARD_KPI_DEFINITIONS)) {
      expect(definition.financial).toBe(false);
      expect(definition.href.startsWith("/")).toBe(true);
      expect(definition.calculationOwner.length).toBeGreaterThan(10);
      expect(["dashboard_operational_summary", "exact_table_count"]).toContain(definition.source);
    }
  });

  it("documents good/bad direction without inventing comparisons", () => {
    expect(dashboardKpiDefinition("availableAssets").positiveDirection).toBe("up");
    expect(dashboardKpiDefinition("overdueRequests").positiveDirection).toBe("down");
    expect(dashboardKpiDefinition("activeAssets").positiveDirection).toBe("neutral");
  });
});

describe("role dashboard configuration", () => {
  it.each(roles)("%s receives exactly four KPIs", (role) => {
    expect(dashboardRoleConfig(role).kpis).toHaveLength(4);
    expect(new Set(dashboardRoleConfig(role).kpis).size).toBe(4);
  });

  it("keeps viewer and auditor read-only and mutation-free", () => {
    expect(dashboardRoleConfig("viewer").readOnly).toBe(true);
    expect(dashboardRoleConfig("auditor").readOnly).toBe(true);
    expect(dashboardRoleConfig("viewer").secondaryAction).toBeNull();
    expect(dashboardRoleConfig("auditor").secondaryAction).toBeNull();
  });

  it("uses only established operational routes", () => {
    expect(dashboardRoleConfig("admin").primaryAction).toBe("/alerts");
    expect(dashboardRoleConfig("technician").primaryAction).toBe("/maintenance");
    expect(dashboardRoleConfig("warehouse_manager").primaryAction).toBe("/requests?view=warehouse");
    expect(dashboardRoleConfig("viewer").primaryAction).toBe("/reports");
  });
});
