import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const migration = fs.readFileSync(
  path.join(root, "migrations/20260727152842_capability_consistency_hardening.sql"),
  "utf8",
);
const settings = fs.readFileSync(
  path.join(root, "src/components/settings/permissions-settings.tsx"),
  "utf8",
);

describe("capability consistency hardening", () => {
  it("does not expose arbitrary-user capability lookup to authenticated users", () => {
    expect(migration).toMatch(
      /revoke all on function public\.has_capability\(uuid, text\)[\s\S]*from public, anon, authenticated;/,
    );
    expect(migration).toContain("function public.admin_user_has_capability");
    expect(migration).toContain("public.app_user_role() <> 'admin'");
    expect(migration).toContain("current_user_has_capability('user.manage')");
  });

  it("uses capabilities in RLS for the reviewed mismatch tables", () => {
    expect(migration).toContain("current_user_has_capability('asset.update')");
    expect(migration.match(/current_user_has_capability\('stocktake\.manage'\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(migration).toContain("current_user_has_capability('maintenance.manage')");
    expect(migration).toMatch(
      /r\.key = 'auditor'[\s\S]*p\.key = 'stocktake\.manage'/,
    );
  });

  it("drops its own capability policies before recreating them on retry", () => {
    for (const statement of [
      "drop policy if exists upd_capability on public.assets;",
      "drop policy if exists ins_capability on public.assets;",
      "drop policy if exists upd_capability on public.maintenance_records;",
      "drop policy if exists ins_capability on public.stocktakes;",
      "drop policy if exists upd_capability on public.stocktakes;",
      "drop policy if exists ins_capability on public.stocktake_items;",
      "drop policy if exists upd_capability on public.stocktake_items;",
    ]) {
      expect(migration).toContain(statement);
    }
  });

  it("separates move/custody from broad asset editing", () => {
    expect(migration).toContain("('asset.move', 'assets'");
    expect(migration).toContain("current_user_has_capability('asset.move')");
    expect(migration.match(/current_user_has_capability\('asset\.assign'\)/g)).toHaveLength(2);
    expect(migration).toContain("p.key = 'asset.update' and r.key in ('technician', 'warehouse_manager')");
  });

  it("shows warehouse manager in the permissions matrix", () => {
    expect(settings).toMatch(
      /const ROLES = \[[^\]]*"warehouse_manager"[^\]]*\] as const;/,
    );
  });
});
