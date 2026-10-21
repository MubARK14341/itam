import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../migrations/20260810024000_exact_asset_fulfillment_allocation_reconciliation.sql", import.meta.url),
  "utf8",
);

describe("exact allocation fulfillment reconciliation", () => {
  it("creates the canonical allocation when custom fulfillment selects an asset", () => {
    expect(migration).toContain("create or replace function public.request_item_fulfill");
    expect(migration).toContain("insert into public.request_asset_allocations");
    expect(migration).toContain("v_request.id, p_item_id, p_asset_id, 'selected', auth.uid()");
  });

  it("repairs only deterministic active one-to-one reservation orphans", () => {
    expect(migration).toContain("ri.quantity = 1");
    expect(migration).toContain("r.status in ('approved', 'provisioned', 'preparing')");
    expect(migration).toContain("a.status = 'reserved'");
    expect(migration).toContain("not exists (\n    select 1\n    from public.request_asset_allocations allocation\n    where allocation.request_item_id = ri.id");
  });

  it("keeps authorization and RLS boundaries intact", () => {
    expect(migration).toContain("v_role is null or v_role not in");
    expect(migration).toContain("revoke all on function public.request_item_fulfill(uuid, uuid, uuid) from public, anon");
    expect(migration).toContain("grant execute on function public.request_item_fulfill(uuid, uuid, uuid) to authenticated");
    expect(migration).toContain("set search_path to 'public'");
  });
});
