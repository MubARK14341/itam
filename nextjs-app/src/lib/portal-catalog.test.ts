import { describe, expect, it } from "vitest";
import { filterPortalCatalog, portalKeyForCategoryName } from "./portal-catalog";

const rows = [
  { category_id: "laptop", company_id: "dell", model_id: "latitude" },
  { category_id: "laptop", company_id: "hp", model_id: "elitebook" },
  { category_id: "printer", company_id: "hp", model_id: "laserjet" },
];

describe("portal catalog filtering", () => {
  it("fails closed until a category is selected", () => {
    expect(filterPortalCatalog(rows, "")).toEqual([]);
  });

  it("filters by category and then company", () => {
    expect(filterPortalCatalog(rows, "laptop")).toHaveLength(2);
    expect(filterPortalCatalog(rows, "laptop", "hp")).toEqual([rows[1]]);
  });

  it("maps only supported category names", () => {
    expect(portalKeyForCategoryName(" Laptop ")).toBe("laptop");
    expect(portalKeyForCategoryName("Unlisted category")).toBeNull();
  });
});
