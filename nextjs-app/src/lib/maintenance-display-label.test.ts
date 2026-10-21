import { describe, expect, it } from "vitest";
import { maintenanceDisplayLabel } from "./maintenance";

describe("maintenanceDisplayLabel", () => {
  it("translates legacy maintenance codes without rewriting their records", () => {
    expect(maintenanceDisplayLabel("employee_reported", "ar", "employee_reported")).toBe("بلاغ موظف");
    expect(maintenanceDisplayLabel("normal", "en", "normal")).toBe("Normal");
    expect(maintenanceDisplayLabel("not_ready", "ar", "not_ready")).toBe("غير جاهز للتسليم");
    expect(maintenanceDisplayLabel("Printer", "en", "Printer")).toBe("Print / scan issue");
  });

  it("does not conceal an unknown value that still needs a translation", () => {
    expect(maintenanceDisplayLabel("future_code", "ar", "future_code")).toBe("future_code");
  });
});
