import { describe, expect, it } from "vitest";
import { EQUIPMENT_PHOTOS, equipmentPhotoKind, latestCleanEquipmentPhoto } from "./equipment-photos";

describe("equipment photo selection", () => {
  it("maps structured printer subtypes without confusing equipment with consumables", () => {
    for (const [printerType, expected] of [["paper", "paper-printer"], ["card", "card-printer"], ["label", "label-printer"], ["receipt", "receipt-printer"], ["thermal", "receipt-printer"]]) {
      expect(equipmentPhotoKind({ name: "Epson L805", category: { name: "Printer" }, special_attributes: { printerType } })).toBe(expected);
    }
    expect(equipmentPhotoKind({ name: "حبر طابعة" })).toBeNull();
    expect(equipmentPhotoKind({ name: "طابعة ورقية Brother MFC-L8690", category: { name: "Paper Printer", name_ar: "طابعة ورقية" }, special_attributes: { printerType: "paper" } })).toBe("paper-printer");
    expect(equipmentPhotoKind({ name: "ورق طباعة Brother", category: { name: "Printer" } })).toBeNull();
    expect(equipmentPhotoKind({ name: "Dell Laptop", special_attributes: { printerType: "card" } })).toBe("laptop");
  });
  it("uses the existing detector and provides only the eleven approved device photos", () => {
    expect(Object.keys(EQUIPMENT_PHOTOS)).toHaveLength(11);
    expect(equipmentPhotoKind({ name: "Honeywell EDA51" })).toBe("scanner");
    expect(equipmentPhotoKind({ name: "TP-Link MR100" })).toBe("router");
    expect(equipmentPhotoKind(undefined, "laptop")).toBe("laptop");
    expect(equipmentPhotoKind(undefined, "sim")).toBeNull();
  });
  it("selects the latest clean nonfinancial image without changing the input or accepting pending/infected documents", () => {
    const clean = { kind: "asset_photo", classification: "internal", scan_status: "clean", mime_type: "image/png", storage_path: "asset/clean.png", created_at: "2026-10-01" };
    const rows = [
      clean,
      { ...clean, created_at: "2026-10-09", scan_status: "pending" },
      { ...clean, created_at: "2026-10-08", scan_status: "infected" },
      { ...clean, created_at: "2026-10-07", classification: "financial" },
      { ...clean, created_at: "2026-10-06", mime_type: "application/pdf" },
      { ...clean, created_at: "2026-10-05", kind: "purchase_invoice" },
    ];
    expect(latestCleanEquipmentPhoto(rows)).toBe(clean);
    expect(rows[0]).toBe(clean);
    expect(latestCleanEquipmentPhoto([])).toBeNull();
    expect(latestCleanEquipmentPhoto([...rows, { ...clean, storage_path: "asset/newer.jpg", created_at: "2026-10-02" }])?.storage_path).toBe("asset/newer.jpg");
  });
});
