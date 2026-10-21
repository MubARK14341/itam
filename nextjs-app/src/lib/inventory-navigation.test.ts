import { describe, expect, it } from "vitest";
import {
  buildInventoryReturnTo,
  safeInventoryReturnTo,
  withInventoryReturnTo,
} from "@/lib/inventory-navigation";

describe("inventory navigation context", () => {
  it("keeps only active inventory filters in a stable order", () => {
    expect(buildInventoryReturnTo({
      q: " DM26-LAP ",
      category: "cat-1",
      status: "available",
      location: "loc-1",
      company: "company-1",
      type: "assets",
    })).toBe("/assets?q=DM26-LAP&cat=cat-1&status=available&loc=loc-1&company=company-1&type=assets");
  });

  it("adds an encoded return target to detail URLs", () => {
    expect(withInventoryReturnTo("/assets/asset-1", "/assets?q=tag 1"))
      .toBe("/assets/asset-1?returnTo=%2Fassets%3Fq%3Dtag%201");
  });

  it("rejects external or non-inventory return targets", () => {
    expect(safeInventoryReturnTo("https://evil.example/assets")).toBe("/assets");
    expect(safeInventoryReturnTo("//evil.example/assets")).toBe("/assets");
    expect(safeInventoryReturnTo("/settings")).toBe("/assets");
    expect(safeInventoryReturnTo("/assets?q=DM26-LAP")).toBe("/assets?q=DM26-LAP");
  });
});
