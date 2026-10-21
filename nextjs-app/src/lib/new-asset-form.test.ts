import { describe, expect, it } from "vitest";
import { stampAssetCreator, validateNewPhysicalAssetRequired } from "./new-asset-form";

describe("new physical asset requirements", () => {
  it("requires category, location, company, and a non-blank serial number", () => {
    expect(validateNewPhysicalAssetRequired({ categoryId: "", locationId: "", companyId: "", serialNumber: "   " }))
      .toEqual(["category", "location", "company", "serial"]);
    expect(validateNewPhysicalAssetRequired({ categoryId: "cat", locationId: "loc", companyId: "co", serialNumber: " SN-1 " }))
      .toEqual([]);
  });

  it("maps the signed-in user to created_by without creating custody", () => {
    const stamped = stampAssetCreator({ status: "available" as const, assigned_to_employee_id: "another-user", name: "Laptop" }, "current-user");
    expect(stamped.created_by).toBe("current-user");
    expect(stamped.assigned_to_employee_id).toBeNull();
  });
});
