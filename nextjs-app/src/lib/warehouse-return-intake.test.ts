import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(import.meta.dirname, "../../migrations/20260804103000_six_role_tasks_and_return_intake.sql"), "utf8");

describe("warehouse employee return intake", () => {
  it("uses a warehouse-only idempotent transition rather than a client-side custody update", () => {
    expect(migration).toContain("warehouse_employee_return_queue()");
    expect(migration).toContain("warehouse_receive_employee_return(");
    expect(migration).toContain("primary key (actor_id, operation_id)");
    expect(migration).toContain("for update");
    expect(migration).toContain("custody_mismatch");
    expect(migration).toContain("set status = 'returned'");
    expect(migration).toContain("insert into public.asset_movements");
  });

  it("uses the same stocktake.manage capability in the read policy and UI", () => {
    expect(migration).toContain("current_user_has_capability('stocktake.manage')");
  });
});
