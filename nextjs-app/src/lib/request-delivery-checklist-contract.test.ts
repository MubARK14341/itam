import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const page = readFileSync(resolve(root, "app/(app)/requests/[id]/page.tsx"), "utf8");
const en = readFileSync(resolve(root, "lib/translations/en.ts"), "utf8");
const ar = readFileSync(resolve(root, "lib/translations/ar.ts"), "utf8");
const requests = readFileSync(resolve(root, "lib/requests.ts"), "utf8");

describe("delivery checklist contract", () => {
  it("renders each exact prepared allocation as an accessible checkbox", () => {
    expect(page).toContain('allocation.state === "prepared"');
    expect(page).toContain('type="checkbox"');
    expect(page).toContain("toggleDeliveryAsset(asset.asset_id)");
    expect(page).toContain("min-h-14");
    expect(page).not.toContain("deliverySelectAll");
  });

  it("combines manual checks and scans into one verified-asset state", () => {
    expect(page).toContain("setDeliveryVerifiedAssetIds");
    expect(page).toContain("deliveryVerifiedAssetIds.includes(asset.asset_id)");
    expect(page).toContain("await scanLookup(deliveryScanValue)");
    expect(page).toContain("tr.deliveryScanDuplicate");
    expect(page).toContain("tr.deliveryScanWrong");
    expect(page).toContain("tr.deliveryScanUnknown");
  });

  it("keeps confirmation guarded and submits the exact verified IDs to the existing RPC", () => {
    expect(page).toContain("deliveryVerifiedAssetIds.length !== preparedAssets.length");
    expect(page).toContain("verified_asset_ids: deliveryVerifiedAssetIds");
    expect(page).toContain("busyRef.current");
    expect(requests).toContain('requestRpc("request_deliver_with_proof"');
    expect(requests).toContain("p_operation_id: operationId");
  });

  it("keeps checklist and scan copy in Arabic and English", () => {
    for (const copy of [en, ar]) {
      expect(copy).toContain("deliveryVerifyTitle:");
      expect(copy).toContain("recipientPersonHint:");
      expect(copy).toContain("deliveryScanHint:");
      expect(copy).toContain("deliveryScanAction:");
      expect(copy).toContain("deliveryScanUnknown:");
      expect(copy).toContain("deliveryVerificationRequiredHint:");
    }
  });
});
