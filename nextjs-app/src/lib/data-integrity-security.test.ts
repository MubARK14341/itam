import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const sql = fs.readFileSync(
  path.join(process.cwd(), "migrations/20260727153809_future_asset_integrity_guards.sql"),
  "utf8",
);

describe("future asset integrity guards", () => {
  it("requires creator, company, location and a serial on new assets", () => {
    expect(sql).toContain("asset_creator_required");
    expect(sql).toContain("asset_company_required");
    expect(sql).toContain("asset_location_required");
    expect(sql).toContain("asset_serial_required");
    expect(sql).toContain("new.created_by := coalesce(new.created_by, auth.uid())");
  });

  it("does not fabricate missing historical ownership", () => {
    expect(sql).toContain("do not fabricate history");
    expect(sql).toContain("having count(distinct al.changed_by) = 1");
    expect(sql).toContain("and al.action = 'INSERT'");
    expect(sql).not.toMatch(/update public\.assets[\s\S]*set company_id/i);
  });

  it("checks assigned state at transaction commit", () => {
    expect(sql.match(/deferrable initially deferred/g)).toHaveLength(2);
    expect(sql).toContain("assigned_asset_requires_one_matching_active_assignment");
    expect(sql).toContain("aa.employee_id = new.assigned_to_employee_id");
  });

  it("prevents two concurrent active maintenance records", () => {
    expect(sql).toContain("unique index if not exists uq_maintenance_one_active_per_asset");
    expect(sql).toContain("coalesce(workflow_stage, 'open')");
  });
});
