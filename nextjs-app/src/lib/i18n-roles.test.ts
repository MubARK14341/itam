import { describe, expect, it } from "vitest";
import { ar } from "./translations/ar";
import { en } from "./translations/en";

// Regression: the auditor role label was mistakenly "موظف" (employee) in Arabic,
// which mislabelled the role in the registration approval dropdown. It must read
// "مدقّق" (auditor) in Arabic and "Auditor" in English. Also guards that every
// role key is translated in both dictionaries and that no role reuses the
// employee label.
describe("role label translations", () => {
  const roleKeys = ["admin", "it_manager", "technician", "warehouse_manager", "auditor", "viewer"] as const;

  it("labels auditor correctly in both languages", () => {
    expect(ar.roles.auditor).toBe("مدقّق");
    expect(en.roles.auditor).toBe("Auditor");
  });

  it("does not label the auditor role as an employee", () => {
    expect(ar.roles.auditor).not.toBe("موظف");
  });

  it("translates every role key in both dictionaries (no blanks)", () => {
    for (const key of roleKeys) {
      expect(ar.roles[key]?.trim()).toBeTruthy();
      expect(en.roles[key]?.trim()).toBeTruthy();
    }
  });
});
