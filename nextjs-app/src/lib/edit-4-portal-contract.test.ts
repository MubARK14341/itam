import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPORT_TAB_KEYS } from "./report-layout";

const root = resolve(import.meta.dirname, "../..");
const migration = readFileSync(resolve(root, "migrations/20260806113000_edit_4_portal_availability_and_request_validation.sql"), "utf8");
const portal = readFileSync(resolve(root, "src/lib/portal.ts"), "utf8");
const form = readFileSync(resolve(root, "src/app/(portal)/client-portal/requests/new/page-client.tsx"), "utf8");
const stocktakes = readFileSync(resolve(root, "src/app/(app)/stocktakes/page.tsx"), "utf8");
const reports = readFileSync(resolve(root, "src/app/(app)/reports/page-client.tsx"), "utf8");
const reportData = readFileSync(resolve(root, "src/lib/report-data.ts"), "utf8");
const stocktakeSnapshotRepair = readFileSync(resolve(root, "migrations/20260808140000_fix_stocktake_snapshot_model_fields.sql"), "utf8");

describe("EDIT 4 portal availability contract", () => {
  it("uses a single server-side safe aggregate projection", () => {
    expect(migration).toContain("create or replace function public.portal_item_availability");
    expect(portal).toContain("portal_item_availability");
    expect(migration).toContain("a.status = 'available'");
    expect(migration).toContain("a.archived_at is null");
    expect(migration).toContain("asset_assignments");
    expect(migration).toContain("request_asset_allocations");
  });

  it("stores a final server-derived snapshot and requires explicit shortage acknowledgement", () => {
    expect(migration).toContain("available_quantity_at_submission");
    expect(migration).toContain("shortage_quantity");
    expect(migration).toContain("availability_snapshot_at");
    expect(migration).toContain("additional_quantity_acknowledgement_required");
    expect(migration).toContain("update public.request_items set available_quantity_at_submission");
  });

  it("enforces project, city, delivery date, and conditional return date on the server", () => {
    for (const code of ["project_name_required", "city_required", "delivery_date_required", "delivery_date_in_past", "return_date_required", "return_date_invalid"]) {
      expect(migration).toContain(code);
    }
    expect(migration).toContain("Asia/Riyadh");
  });

  it("keeps exactly the five executive report areas", () => {
    expect(REPORT_TAB_KEYS).toEqual(["executive", "requests", "inventory", "maintenance", "custody"]);
    expect(reports).toContain('custody: { label: rep.custodyTab.exportCustody, fn: exportCustody }');
    expect(reports).toContain('saveCSV(\n      "custody_summary.csv"');
    expect(reports).toContain("if (!downloadCSV(...args)) throw");
  });

  it("uses the configured main warehouse and the canonical action count", () => {
    expect(stocktakes).toContain("getInventorySettings");
    expect(stocktakes).toContain("settings.default_location_id");
    expect(stocktakes).toContain("setLocationId(settings.default_location_id)");
    expect(stocktakes).not.toContain("locationList.rows.some");
    expect(stocktakes).not.toContain("locationList.rows[0]");
    expect(reportData).toContain("getActionAlertOperationalCounts({ signal })");
    expect(reportData).toContain("return result.counts.needs_action");
    expect(reports).toContain("data, reqRows, deprRules, decisionCount } = report");
    expect(reports).toContain("rep.kpi.decisionsRequired");
  });

  it("snapshots the normalized model data for both create and unexpected scans", () => {
    expect(stocktakeSnapshotRepair).toContain("left join public.models m on m.id=a.model_id");
    expect(stocktakeSnapshotRepair).toContain("m.brand,m.model_name");
    expect(stocktakeSnapshotRepair).not.toContain("a.manufacturer,a.model");
    expect(stocktakeSnapshotRepair).toContain("revoke all on function public.stocktake_scan(uuid,text,uuid)");
  });

  it("shows safe availability and validates the wizard before submission", () => {
    expect(form).toContain("portalGetItemAvailability");
    expect(form).toContain("additionalAcknowledged");
    expect(form).toContain("validateStep");
    expect(form).toContain("portal-project_name");
    expect(form).toContain("portal-return_date");
  });
});
