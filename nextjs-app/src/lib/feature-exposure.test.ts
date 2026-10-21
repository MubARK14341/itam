import { describe, expect, it } from "vitest";
import { FEATURE_EXPOSURE_PREVIEW_ROLES, isFeatureVisible } from "./feature-exposure";

describe("Feature Exposure preview roles", () => {
  it("includes warehouse_manager without granting a new feature", () => {
    expect(FEATURE_EXPOSURE_PREVIEW_ROLES).toContain("warehouse_manager");
    expect(new Set(FEATURE_EXPOSURE_PREVIEW_ROLES).size).toBe(FEATURE_EXPOSURE_PREVIEW_ROLES.length);
  });

  it("keeps every required primary report and export available to a Manager", () => {
    for (const feature of ["reports.executive", "reports.requests", "reports.assets", "reports.maintenance", "reports.custody", "reports.csv"] as const) {
      expect(isFeatureVisible(feature, "it_manager", { level: 50 })).toBe(true);
    }
  });

  it("keeps account-registration review available to a Manager", () => {
    expect(isFeatureVisible("settings.registration", "it_manager", { level: 50 })).toBe(true);
  });

  it("keeps email automation controls available to a Manager", () => {
    expect(isFeatureVisible("settings.notifications", "it_manager", { level: 50 })).toBe(true);
  });
});
