import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../../migrations/20260808180000_revoke_trigger_guard_execute.sql"),
  "utf8",
);

describe("internal trigger guard grants", () => {
  it("does not expose the exact-readiness trigger function as an RPC", () => {
    expect(migration).toContain("revoke all on function public.request_exact_assets_ready_guard() from public, anon, authenticated;");
  });
});
