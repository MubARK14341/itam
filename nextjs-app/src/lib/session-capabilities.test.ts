import { describe, expect, it } from "vitest";
import {
  canCreateAsset, canManageActionCenter, canManageAssetRecords, canManageAssets, canManageConsumableCatalog, canManageConsumables,
  canManageMaintenance, canManagePurchaseRequests, canManageRequestAttachments,
  canSeeFinancial, canUseScan, type Role,
} from "./session";

describe("operational capability matrix", () => {
  const expected = {
    admin:       { create: true,  manage: true,  maintenance: true,  actionCenter: true,  scan: true,  financial: true },
    it_manager:  { create: true,  manage: true,  maintenance: true,  actionCenter: true,  scan: true,  financial: true },
    technician:  { create: false, manage: true,  maintenance: true,  actionCenter: true,  scan: true,  financial: false },
    warehouse_manager: { create: false, manage: false, maintenance: true, actionCenter: true, scan: true, financial: false },
    auditor:     { create: false, manage: false, maintenance: false, actionCenter: false, scan: false, financial: false },
    viewer:      { create: false, manage: false, maintenance: false, actionCenter: false, scan: false, financial: false },
  } as const;

  it.each(Object.entries(expected))("matches %s", (roleKey, rule) => {
    const role = roleKey as Role;
    expect(canCreateAsset(role)).toBe(rule.create);
    expect(canManageAssets(role)).toBe(rule.manage);
    expect(canManageAssetRecords(role)).toBe(rule.create);
    expect(canManageMaintenance(role)).toBe(rule.maintenance);
    expect(canManageConsumables(role)).toBe(rule.manage);
    expect(canManageConsumableCatalog(role)).toBe(rule.create);
    expect(canManagePurchaseRequests(role)).toBe(rule.manage);
    expect(canManageActionCenter(role)).toBe(rule.actionCenter);
    expect(canManageRequestAttachments(role)).toBe(rule.manage);
    expect(canUseScan(role)).toBe(rule.scan);
    expect(canSeeFinancial(role)).toBe(rule.financial);
  });
});
