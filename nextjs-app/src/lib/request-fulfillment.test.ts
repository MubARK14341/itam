import { describe, expect, it } from "vitest";
import {
  requestActionMap,
  simplifiedRequestStatus,
  type RequestFulfillmentRole,
} from "./request-fulfillment";

const roles: RequestFulfillmentRole[] = [
  "admin", "it_manager", "warehouse_manager", "technician",
  "employee", "auditor", "portal_customer",
];

function actions(
  status: Parameters<typeof requestActionMap>[0]["status"],
  role: RequestFulfillmentRole,
  overrides: Partial<Parameters<typeof requestActionMap>[0]> = {},
) {
  return requestActionMap({
    status,
    role,
    hasOutstandingReturns: true,
    hasReservedDevices: true,
    secondApprovalRequired: false,
    secondApprovalComplete: false,
    ...overrides,
  });
}

describe("Edit 1 request fulfillment action mapping", () => {
  it("uses the simplified customer-facing status labels", () => {
    expect(simplifiedRequestStatus("approved")).toBe("preparing");
    expect(simplifiedRequestStatus("provisioned")).toBe("preparing");
    expect(simplifiedRequestStatus("preparing")).toBe("preparing");
    expect(simplifiedRequestStatus("ready_for_pickup")).toBe("ready_for_pickup");
    expect(simplifiedRequestStatus("partially_returned")).toBe("delivered");
    expect(simplifiedRequestStatus("returned")).toBe("returned");
    expect(simplifiedRequestStatus("stock_shortage")).toBe("awaiting_supply");
  });

  it("shows exactly the three manager review decisions without manager cancellation", () => {
    for (const role of ["admin", "it_manager"] as const) {
      expect(actions("under_review", role)).toEqual({
        primary: null,
        review: ["approve", "clarify", "reject"],
        secondary: [],
      });
    }
  });

  it("maps each operational stage to one primary action", () => {
    for (const role of ["admin", "it_manager", "warehouse_manager", "technician"] as const) {
      expect(actions("preparing", role).primary).toBe("confirm_ready");
      expect(actions("ready_for_pickup", role).primary).toBe("deliver");
      expect(actions("delivered", role).primary).toBe("receive_return");
      expect(actions("returned", role).primary).toBe("close");
      expect(actions("completed", role).primary).toBeNull();
      expect(actions("rejected", role).primary).toBeNull();
      expect(actions("cancelled", role).primary).toBeNull();
    }
  });

  it("keeps reserved-device changes away from technicians and directly contextual", () => {
    expect(actions("preparing", "warehouse_manager").secondary).toContain("change_reserved");
    expect(actions("preparing", "technician").secondary).not.toContain("change_reserved");
    expect(actions("preparing", "admin").primary).toBe("confirm_ready");
  });

  it("allows only the requester to cancel before approval or preparation", () => {
    expect(actions("under_review", "employee").secondary).toEqual(["cancel"]);
    expect(actions("draft", "employee").secondary).toEqual(["cancel"]);
    expect(actions("preparing", "employee").secondary).toEqual([]);
  });

  it("keeps auditor and portal customer mutation-free", () => {
    for (const role of ["auditor", "portal_customer"] as const) {
      for (const status of ["under_review", "preparing", "ready_for_pickup", "delivered", "returned"] as const) {
        expect(actions(status, role)).toEqual({ primary: null, review: [], secondary: [] });
      }
    }
  });

  it("covers every requested role without exposing more than one primary action", () => {
    for (const role of roles) {
      for (const status of ["draft", "under_review", "preparing", "ready_for_pickup", "delivered", "returned", "completed"] as const) {
        const result = actions(status, role);
        expect(result.primary === null || typeof result.primary === "string").toBe(true);
      }
    }
  });

  it("fails closed for strong-proof delivery while retaining direct independent approval", () => {
    const result = actions("ready_for_pickup", "it_manager", {
      secondApprovalRequired: true,
      secondApprovalComplete: false,
    });
    expect(result.primary).toBeNull();
    expect(result.secondary).toContain("secondary_approval");
  });
});
