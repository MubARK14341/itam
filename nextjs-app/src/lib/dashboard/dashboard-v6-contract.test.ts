import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const page = read("src/app/(app)/dashboard/page.tsx");
const main = read("src/components/dashboard-v6/dashboard-command-center.tsx");
const components = [
  "priority-now.tsx",
  "kpi-grid.tsx",
  "dashboard-charts.tsx",
  "chart-error-boundary.tsx",
  "recent-activity.tsx",
  "widget-state.tsx",
  "dashboard-ui.tsx",
].map((name) => read(`src/components/dashboard-v6/${name}`)).join("\n");
const data = read("src/lib/dashboard/get-command-center-data.ts");
const types = read("src/lib/dashboard/dashboard-types.ts");
const css = read("src/app/globals.css");
const layout = read("src/app/(app)/layout.tsx");
const en = read("src/lib/translations/en.ts");
const ar = read("src/lib/translations/ar.ts");

describe("Manager dashboard composition contract", () => {
  it("uses a server page and server-side authenticated orchestration", () => {
    expect(page).not.toContain('"use client"');
    expect(page).toContain("getDashboardCommandCenterData()");
    expect(data).toContain('import "server-only"');
    expect(data).toContain('from "@/lib/supabase/server"');
    expect(data).not.toContain('from "@/lib/supabase/client"');
    expect(data).toContain('rpc("dashboard_operational_summary")');
    expect(data).toContain('rpc("my_capabilities")');
  });

  it("renders KPIs before one manager decision list in every viewport", () => {
    const priority = main.indexOf("<PriorityNow");
    const kpis = main.indexOf("<KpiGrid");
    expect(priority).toBeGreaterThan(0);
    expect(kpis).toBeGreaterThan(0);
    expect(kpis).toBeLessThan(priority);
    expect(main).not.toContain("<MyWork");
  });

  it("starts with KPIs and omits the redundant Command Center hero", () => {
    const order = [
      "<KpiGrid",
      "<PriorityNow",
      "<DashboardCharts",
      "<RecentActivity",
    ].map((token) => main.indexOf(token));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(main).not.toContain("<CommandHero");
    expect(main).not.toContain("<DashboardPrintHeader");
    expect(main).not.toContain("RisksExceptions");
    expect(main).not.toContain("RequestsMaintenance");
    expect(main).not.toContain("<AssetsInventory");
  });

  it("uses no more than two main charts and includes same-data tables", () => {
    const charts = read("src/components/dashboard-v6/dashboard-charts.tsx");
    expect(charts).toContain("function RequestChart");
    expect(charts).toContain("function AssetChart");
    expect(charts).not.toMatch(/Maintenance.*Chart|thirdChart/i);
    expect((charts.match(/<table/g) ?? [])).toHaveLength(2);
    expect(charts).toContain("<caption");
    expect((charts.match(/<ChartErrorBoundary/g) ?? [])).toHaveLength(2);
  });

  it("keeps KPI drilldowns aligned with their aggregate predicates", () => {
    const definitions = read("src/lib/dashboard/kpi-definitions.ts");
    expect(definitions).toContain('href: "/maintenance?view=followup"');
    expect(definitions).toContain('href: "/maintenance?view=past_due"');
    expect(definitions).toContain('href: "/requests?view=returns_due"');
    expect(definitions).toContain('href: "/assets?view=missing_location"');
  });

  it("keeps bounded previews separate from due-date-ranked priority queries", () => {
    expect(data).toContain("priorityRequestQuery");
    expect(data).toContain("priorityMaintenanceQuery");
    expect(data).toContain('.order("return_date", { ascending: true, nullsFirst: false })');
    expect(data).toContain('.order("next_due_date", { ascending: true, nullsFirst: false })');
    expect(data).not.toMatch(/createdAt:\s*""/);
  });

  it("never fetches, serializes, or renders financial fields", () => {
    const implementation = `${page}\n${main}\n${components}\n${data}`;
    expect(implementation).not.toMatch(/purchase_cost|unit_cost|total_cost|invoice_number|invoice_date|request_items_financial|assets_financial|service_role/i);
    expect(types).toContain("financial: false");
  });

  it("contains only real routes and no fake action patterns", () => {
    expect(components).toMatch(/href="\/alerts"|primaryAction/);
    // All remaining decision and KPI cards use their source-backed href rather
    // than hard-coded links to duplicated dashboard sections.
    expect(components).toContain("href={item.href}");
    expect(components).toContain("href={kpi.href}");
    expect(components).not.toMatch(/\balert\(|console\.log|Math\.random|TODO|toast/i);
  });

  it("does not expose opaque entity UUIDs when a human record label is available", () => {
    const priority = read("src/components/dashboard-v6/priority-now.tsx");
    expect(priority).toContain("{item.entityLabel}");
    expect(priority).not.toContain("{item.entityId}");
  });

  it("does not use unsafe HTML or raw DOM injection", () => {
    const implementation = `${components}\n${data}`;
    expect(implementation).not.toMatch(/dangerouslySetInnerHTML|insertAdjacentHTML|innerHTML/);
  });

  it("uses logical RTL classes and avoids page-level overflow hiding", () => {
    expect(components).not.toMatch(/\b(?:ml|mr|pl|pr)-/);
    expect(components).toContain("[unicode-bidi:isolate]");
    expect(components).toContain('dir="ltr"');
    expect(`${components}\n${css}`).not.toContain("overflow-x-hidden");
  });

  it("preserves one application main and adds accessible loading and controls", () => {
    expect((layout.match(/<main/g) ?? [])).toHaveLength(1);
    expect(main).not.toContain("<main");
    expect(main).toContain("<h1");
    expect(components).toContain("min-h-11");
    expect(read("src/app/(app)/dashboard/loading.tsx")).toContain('aria-busy="true"');
  });

  it("keeps the shared print styling without a dashboard-level print shortcut", () => {
    expect(css).toMatch(/@page\s*\{[\s\S]*size:\s*A4/);
    expect(css).toContain(".app-sidebar");
    expect(css).toContain(".dashboard-interactive");
    expect(css).toMatch(/section\[aria-labelledby="dashboard-charts-title"\][\s\S]*break-inside:\s*auto\s*!important/);
    expect(main).not.toContain("dashboard-print-header");
    for (const key of ["reference", "updated", "printed", "source", "user"]) {
      expect(en).toMatch(new RegExp(`\\b${key}:`));
      expect(ar).toMatch(new RegExp(`\\b${key}:`));
    }
  });

  it("ships the required implementation contract and retires the unused V5 component path", () => {
    expect(existsSync("docs/DASHBOARD_COMMAND_CENTER_V6.md")).toBe(true);
    expect(existsSync("src/components/dashboard/command-center-widgets.tsx")).toBe(false);
    expect(existsSync("src/lib/dashboard-command-center.ts")).toBe(false);
  });
});
