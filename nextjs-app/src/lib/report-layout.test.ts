import { describe, expect, it } from "vitest";
import {
  REPORT_TAB_KEYS,
  REMOVED_REPORT_TAB_KEYS,
  hasDuplicateReportTabs,
} from "./report-layout";

describe("merged report layout", () => {
  it("keeps exactly the five executive report areas", () => {
    expect(REPORT_TAB_KEYS).toEqual(["executive", "requests", "inventory", "maintenance", "custody"]);
    expect(REPORT_TAB_KEYS.filter((key) => key === "requests")).toHaveLength(1);
    expect(REPORT_TAB_KEYS.filter((key) => key === "inventory")).toHaveLength(1);
    expect(hasDuplicateReportTabs(REPORT_TAB_KEYS)).toBe(false);
  });

  it("does not expose the superseded duplicate tabs", () => {
    for (const key of REMOVED_REPORT_TAB_KEYS) {
      expect(REPORT_TAB_KEYS).not.toContain(key);
    }
  });
});
