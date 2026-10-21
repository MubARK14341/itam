import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: supabaseMock.createClient,
}));

import { getSystemInventoryReport } from "./stocktakes";

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../migrations/20260816162807_stocktake_inventory_report_status_counts.sql",
  ),
  "utf8",
);

describe("stocktake registered-assets report", () => {
  beforeEach(() => {
    supabaseMock.createClient.mockReset();
  });

  it("uses the guarded aggregate RPC instead of collapsing delivery into reserved status", async () => {
    const report = {
      registered: 50,
      available: 7,
      reserved: 5,
      delivered: 38,
      inMaintenance: 2,
      dataIssues: 1,
    };
    const rpc = vi.fn().mockResolvedValue({ data: report, error: null });
    supabaseMock.createClient.mockReturnValue({ rpc });

    await expect(getSystemInventoryReport("location-1")).resolves.toEqual({
      report,
      error: null,
    });
    expect(rpc).toHaveBeenCalledWith("stocktake_system_inventory_report", {
      p_location_id: "location-1",
    });
  });

  it("keeps reserved inventory disjoint from delivered allocations and active custody", () => {
    expect(migration).toContain("ra.state = 'delivered'");
    expect(migration).toContain("aa.status = 'active'");
    expect(migration).toContain("and not i.is_delivered");
    expect(migration).toContain("where i.status = 'reserved' and i.is_delivered");
    expect(migration).toContain("public._stocktake_can_read()");
    expect(migration).toContain("set search_path to 'public'");
    expect(migration).toContain("from public, anon, authenticated");
  });
});
