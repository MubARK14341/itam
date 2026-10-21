import { describe, expect, it } from "vitest";
import { normalizeImportDate, parseCsv, validateImport, type ImportRefs } from "./csv-import";
import { getDict } from "./i18n";

describe("CSV import calendar dates", () => {
  it("preserves ISO date-only values verbatim", () => {
    expect(normalizeImportDate("2026-07-13")).toBe("2026-07-13");
  });

  it("normalizes a locally parsed date using its calendar fields, not UTC slicing", () => {
    const normalized = normalizeImportDate("July 13, 2026");
    expect(normalized).toBe("2026-07-13");
  });
});

const refs: ImportRefs = {
  categories: [{ id: "asset-category", name: "Laptops", name_ar: "الحواسيب" }, { id: "consumable-category", name: "Toner", name_ar: "الحبر" }],
  companies: [{ id: "company", name: "Existing company" }],
  locations: [{ id: "location", name: "Existing store", name_ar: "المستودع" }],
  suppliers: [], existingSerials: new Set(), existingRfids: new Set(), existingSkus: new Set(),
};

describe.each(["en", "ar"] as const)("%s CSV asset creation requirements", (lang) => {
  const messages = getDict(lang).import.errors;
  const check = (csv: string) => validateImport(parseCsv(csv), refs, { canFinancial: false }, messages);
  it("blocks assets with absent columns or whitespace values before producing an RPC payload", () => {
    for (const csv of ["item_type,name,category\nasset,Laptop,Laptops", "item_type,name,category,company,location,serial_number\nasset,Laptop,Laptops, , , "]) {
      const result = check(csv);
      expect(result.headerError).toBeNull();
      expect(result.error).toBe(1);
      expect(result.rows[0].normalized).toBeNull();
      expect(result.rows[0].errors).toEqual([messages.missingCompany, messages.missingLocation, messages.missingSerial]);
    }
  });
  it("accepts a complete asset beside a consumable with no optional references", () => {
    const result = check("item_type,name,category,company,location,serial_number,quantity\nasset,Laptop,Laptops,Existing company,Existing store,SN-1,\nconsumable,Toner,Toner,,,,0");
    expect(result.error).toBe(0);
    expect(result.valid).toBe(2);
    expect(result.rows[0].normalized).toMatchObject({ company_id: "company", location_id: "location", serial_number: "SN-1" });
    expect(result.rows[1].normalized).toMatchObject({ item_type: "consumable", company_id: null, location_id: null, quantity: 0 });
  });
  it("retains unknown reference errors instead of reporting a nonblank value as missing", () => {
    const result = check("item_type,name,category,company,location,serial_number\nasset,Laptop,Laptops,Other company,Other store,SN-1");
    expect(result.rows[0].normalized).toBeNull();
    expect(result.rows[0].errors).toEqual([
      messages.unknownCompany.replace("{v}", "Other company"), messages.unknownLocation.replace("{v}", "Other store"),
    ]);
  });
});
