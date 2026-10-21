import { describe, expect, it } from "vitest";
import {
  ACTION_ALERT_TYPE_KEYS, actionAlertCandidateCount, deriveActionAlertCandidates,
} from "./action-center";

describe("Dashboard / Action Center predicate parity", () => {
  const assets = [
    { id: "maintenance", asset_tag: "A-2", name: "Maintenance device", status: "in_maintenance", serial_number: null, qr_token: null, purchase_date: null },
    { id: "assigned", asset_tag: "A-3", name: "Assigned", status: "assigned", serial_number: "S3", qr_token: "q3", location_id: null, holder: null, purchase_date: null },
  ];
  const maintenance = [
    { id: "m1", status: "open", action_taken: null, technician_id: null, reported_at: "2026-06-01T00:00:00Z", asset: { id: "maintenance", asset_tag: "A-2" } },
  ];
  const requests = [
    { id: "r1", request_number: "REQ-1", status: "ready_for_pickup", pickup_date: "2026-07-12" },
    { id: "r2", request_number: "REQ-2", status: "under_review", return_date: null },
    { id: "r3", request_number: "REQ-3", status: "preparing", pickup_date: null },
    { id: "r4", request_number: "REQ-4", status: "completed", return_date: "2020-01-01" },
  ];
  const candidates = deriveActionAlertCandidates({
    maintenance, consumables: [
      { id: "empty", name: "Empty", quantity_on_hand: 0, reorder_level: 2 },
    ], requests, stocktakes: [{ id: "s1", review_state: "submitted", location: { name: "Main warehouse" } }], todayISO: "2026-07-13",
  });

  it("keeps the registry limited to simplified operational queues", () => {
    const removed = [
      "asset_maintenance_attention", "asset_no_qr", "asset_depreciation_ended", "request_overdue",
    ];
    expect(ACTION_ALERT_TYPE_KEYS.some((key) => removed.includes(key))).toBe(false);
    expect(candidates.some((candidate) => removed.includes(candidate.alert_type))).toBe(false);
  });

  it("creates each of the operational queues from its real source rows", () => {
    expect(actionAlertCandidateCount(candidates, "maint_overdue")).toBe(1);
    expect(actionAlertCandidateCount(candidates, "maint_no_technician")).toBe(1);
    expect(actionAlertCandidateCount(candidates, "consumable_below_threshold")).toBe(1);
    expect(actionAlertCandidateCount(candidates, "stocktake_review")).toBe(1);
  });

  it("excludes completed requests while keeping the three request queues", () => {
    expect(actionAlertCandidateCount(candidates, "request_pending")).toBe(1);
    expect(actionAlertCandidateCount(candidates, "request_preparing")).toBe(1);
    expect(actionAlertCandidateCount(candidates, "request_ready_delivery")).toBe(1);
    expect(candidates.some((candidate) => candidate.entity_id === "r4")).toBe(false);
  });
});
