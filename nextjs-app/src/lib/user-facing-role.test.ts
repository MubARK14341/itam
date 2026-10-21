import { ASSIGNABLE_TECHNICAL_ROLES, assignableTechnicalRole, canAccessInternalPath, defaultInternalLanding, userFacingRole } from "./user-facing-role";
import { describe, expect, it } from "vitest";

describe("six-state presentation model", () => {
  it("maps technical roles to the four approved internal account states", () => {
    expect(userFacingRole("admin")).toBe("manager");
    expect(userFacingRole("it_manager")).toBe("manager");
    expect(userFacingRole("warehouse_manager")).toBe("warehouse_employee");
    expect(userFacingRole("technician")).toBe("warehouse_employee");
    expect(userFacingRole("employee")).toBe("office_employee");
    expect(userFacingRole("auditor")).toBe("viewer");
    expect(userFacingRole("viewer")).toBe("viewer");
    expect(userFacingRole(null)).toBeNull();
  });

  it("routes each presentation state to the intended landing", () => {
    expect(defaultInternalLanding("admin")).toBe("/dashboard");
    expect(defaultInternalLanding("employee")).toBe("/my-tasks");
    expect(defaultInternalLanding("warehouse_manager")).toBe("/my-tasks");
    expect(defaultInternalLanding("viewer")).toBe("/overview");
  });

  it("keeps the executive dashboard manager-only and viewer request access consistent", () => {
    expect(canAccessInternalPath("viewer", "/dashboard")).toBe(false);
    expect(canAccessInternalPath("viewer", "/requests")).toBe(false);
    expect(canAccessInternalPath("viewer", "/requests/123")).toBe(false);
    expect(canAccessInternalPath("warehouse_manager", "/dashboard")).toBe(false);
    expect(canAccessInternalPath("admin", "/dashboard")).toBe(true);
  });

  it("offers only the four approved working states in account management", () => {
    expect(ASSIGNABLE_TECHNICAL_ROLES).toEqual(["it_manager", "employee", "warehouse_manager", "viewer"]);
    expect(assignableTechnicalRole("admin")).toBe("it_manager");
    expect(assignableTechnicalRole("technician")).toBe("warehouse_manager");
    expect(assignableTechnicalRole("auditor")).toBe("viewer");
  });
});
