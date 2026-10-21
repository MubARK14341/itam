import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: supabaseMock.createClient,
}));

import {
  createDepreciationRule,
  setDepreciationRuleActive,
  updateDepreciationRule,
  type DepreciationRuleInput,
} from "./queries";

const root = resolve(import.meta.dirname, "../..");
const migration = readFileSync(
  resolve(root, "migrations/20260817181912_depreciation_rule_rpc_boundary.sql"),
  "utf8",
);
const queries = readFileSync(resolve(root, "src/lib/queries.ts"), "utf8");
const settings = readFileSync(
  resolve(root, "src/components/settings/depreciation-settings.tsx"),
  "utf8",
);

const input: DepreciationRuleInput = {
  category_id: null,
  asset_type: null,
  method: "straight_line",
  annual_rate: 18,
  salvage_rate: 10,
  is_active: true,
  company_id: null,
  useful_life_years: 5,
  alert_before_days: 30,
  priority: 100,
};

describe("depreciation rule RPC boundary", () => {
  beforeEach(() => {
    supabaseMock.createClient.mockReset();
  });

  it("routes create, update, and activation through narrow RPCs", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
    supabaseMock.createClient.mockReturnValue({ rpc });

    await expect(createDepreciationRule(input)).resolves.toBeNull();
    await expect(updateDepreciationRule("rule-1", input)).resolves.toBeNull();
    await expect(setDepreciationRuleActive("rule-1", false)).resolves.toBeNull();

    expect(rpc).toHaveBeenNthCalledWith(1, "depreciation_rule_save_atomic", {
      p_rule_id: null,
      p_input: input,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "depreciation_rule_save_atomic", {
      p_rule_id: "rule-1",
      p_input: input,
    });
    expect(rpc).toHaveBeenNthCalledWith(3, "depreciation_rule_set_active", {
      p_rule_id: "rule-1",
      p_is_active: false,
    });
    expect(queries).not.toMatch(/from\(["']depreciation_rules["']\)[\s\S]{0,100}\.(insert|update|delete)\(/);
  });

  it("preserves RPC and transport failures", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { ok: false, error: "not_authorized" }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "network_failed" } });
    supabaseMock.createClient.mockReturnValue({ rpc });

    await expect(createDepreciationRule(input)).resolves.toBe("not_authorized");
    await expect(updateDepreciationRule("rule-1", input)).resolves.toBe("network_failed");
  });

  it("self-authorizes financial settings and removes all browser DML", () => {
    expect(migration).toContain("current_user_has_capability('settings.manage')");
    expect(migration).toContain("or not public.is_financial_viewer()");
    expect(migration).toMatch(
      /revoke insert, update, delete on public\.depreciation_rules\s+from anon, authenticated;/,
    );
    for (const policy of ["ins_mgr", "upd_mgr", "del_mgr"]) {
      expect(migration).toContain(`drop policy if exists ${policy} on public.depreciation_rules;`);
    }
    expect(migration).toMatch(/revoke all on function public\.depreciation_rule_save_atomic/);
    expect(migration).toMatch(/grant execute on function public\.depreciation_rule_save_atomic/);
  });

  it("validates bounded inputs and derives the annual rate under database control", () => {
    expect(migration).toContain("p_input->>'method' is distinct from 'straight_line'");
    expect(migration).toContain("v_annual_rate := round((100 - v_salvage_rate) / v_useful_life, 6)");
    expect(migration).toContain("v_alert_days > 36500");
    expect(migration).toContain("v_priority > 1000000");
    expect(settings).toContain("category_id: f.category_id || null");
    expect(settings).toContain("placeholder={td.anyCategory}");
    expect(settings).not.toMatch(/<Field label=\{td\.category\} required/);
    expect(settings).toContain("parseStrictInteger(f.alert_before_days");
  });

  it("audits changes while redacting both financial percentages", () => {
    expect(migration).toMatch(/annual\[_-\]\?rate\|salvage\[_-\]\?rate/);
    expect(migration).toContain("after insert or update or delete on public.depreciation_rules");
    expect(migration).toContain("execute function public._audit_row_change()");
  });

  it("uses the safe base projection when lifecycle column grants are unavailable", () => {
    expect(queries).toContain('.select("id,category_id,asset_type,method,is_active")');
    expect(queries).toContain("lifecycleAvailable: false");
    expect(settings).toContain("projectionUnavailableTitle");
    expect(settings).toContain("lifecycleAvailable &&");
  });
});
