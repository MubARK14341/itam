import { describe, it, expect } from "vitest";
import {
  isMaintenanceOpenNoAction,
  isMaintenanceLongOpen,
  isMaintenanceFollowup,
  isMaintenancePastDue,
  LONG_MAINT_DAYS,
  isRequestOverdueReturn,
  isRequestReturnDue,
  isAssetMaintenanceAttention,
  isAssetMissingLocation,
} from "./alert-predicates";

const DAY = 86_400_000;

describe("alert-predicates", () => {
  it("maintenance open-no-action treats a technician as an action", () => {
    expect(isMaintenanceOpenNoAction({ status: "open", action_taken: null, technician_id: null })).toBe(true);
    expect(isMaintenanceOpenNoAction({ status: "open", technician_id: "u1" })).toBe(false);
    expect(isMaintenanceOpenNoAction({ status: "completed" })).toBe(false);
  });

  it("maintenance long-open uses the threshold (injected clock)", () => {
    const now = 1_000 * DAY;
    const stale = new Date(now - (LONG_MAINT_DAYS + 1) * DAY).toISOString();
    const fresh = new Date(now - DAY).toISOString();
    expect(isMaintenanceLongOpen({ status: "open", reported_at: stale }, now)).toBe(true);
    expect(isMaintenanceLongOpen({ status: "open", reported_at: fresh }, now)).toBe(false);
    expect(isMaintenanceFollowup({ status: "open", reported_at: stale }, now)).toBe(true);
    expect(isMaintenanceFollowup({ status: "open", technician_id: "u1", reported_at: fresh }, now)).toBe(false);
  });

  it("maintenance past-due uses the current Riyadh date key", () => {
    expect(isMaintenancePastDue({ status: "open", next_due_date: "2026-07-13" }, "2026-07-14")).toBe(true);
    expect(isMaintenancePastDue({ status: "open", next_due_date: "2026-07-14" }, "2026-07-14")).toBe(false);
    expect(isMaintenancePastDue({ status: "completed", next_due_date: "2026-07-13" }, "2026-07-14")).toBe(false);
  });

  it("overdue-return by explicit status or past return date", () => {
    expect(isRequestOverdueReturn({ status: "overdue" }, "2026-07-07")).toBe(true);
    expect(isRequestOverdueReturn({ status: "delivered", return_date: "2020-01-01" }, "2026-07-07")).toBe(true);
    expect(isRequestOverdueReturn({ status: "delivered", return_date: "2099-01-01" }, "2026-07-07")).toBe(false);
    expect(isRequestReturnDue({ status: "delivered", return_date: "2026-07-07" }, "2026-07-07")).toBe(true);
    expect(isRequestReturnDue({ status: "delivered", return_date: "2026-07-08" }, "2026-07-07")).toBe(false);
  });

  it("asset drilldowns retain only actionable maintenance and data-quality predicates", () => {
    expect(isAssetMaintenanceAttention({ status: "in_maintenance" })).toBe(true);
    expect(isAssetMaintenanceAttention({ status: "available" })).toBe(false);
    expect(isAssetMissingLocation({ location_id: null })).toBe(true);
    expect(isAssetMissingLocation({ location_id: "loc-1" })).toBe(false);
  });
});
