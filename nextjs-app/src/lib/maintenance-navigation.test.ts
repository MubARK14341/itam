import { describe, expect, it } from "vitest";
import { buildMaintenancePath, maintenanceStateFromSearch } from "./maintenance-navigation";

const ID = "11111111-1111-4111-8111-111111111111";

describe("maintenance operational navigation", () => {
  it("round-trips the filters and focused record used by the queue", () => {
    const parsed = maintenanceStateFromSearch(`?q=battery&status=in_progress&type=corrective&problem=charging_battery&view=followup&mine=1&m=${ID}`);
    expect(parsed).toEqual({ q: "battery", status: "in_progress", type: "corrective", problemType: "charging_battery", view: "followup", mineOnly: true, focusId: ID });
    expect(buildMaintenancePath(parsed)).toBe(`/maintenance?q=battery&status=in_progress&type=corrective&problem=charging_battery&view=followup&mine=1&m=${ID}`);
  });

  it("drops values that are not represented by existing maintenance contracts", () => {
    expect(maintenanceStateFromSearch("?status=urgent&type=ai_fix&problem=unknown&view=vip&mine=yes&m=bad"))
      .toEqual({ q: "", status: "", type: "", problemType: "", view: "", mineOnly: false, focusId: "" });
  });
});
