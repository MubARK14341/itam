import { describe, expect, it } from "vitest";
import { parseCsv, validateImport, TEMPLATE_HEADERS, type ImportMessages, type ImportRefs } from "./csv-import";
import { inferColumnMapping, mappedImportRecords, duplicateMappedFields, importTemplateExamples, issueRowsPage } from "./csv-column-mapping";

const refs: ImportRefs = {
  categories: [{ id: "c", name: "Existing laptops", name_ar: null }], locations: [{ id: "l", name: "Existing store", name_ar: null }],
  companies: [{ id: "b", name: "Existing company" }], suppliers: [], existingSerials: new Set(), existingRfids: new Set(), existingSkus: new Set(),
};
const messages: ImportMessages = {
  missingHeaders: "missing {cols}", missingItemType: "missing type", invalidItemType: "invalid type {v}", missingName: "missing name", missingCategory: "missing category",
  missingCompany: "missing company", missingLocation: "missing location", missingSerial: "missing serial",
  unknownCategory: "unknown category {v}", unknownLocation: "unknown location {v}", unknownCompany: "unknown company {v}", unknownSupplier: "unknown supplier {v}",
  invalidStatus: "invalid status {v}", invalidDate: "invalid date {v}", invalidNumber: "invalid number {v}", missingQuantity: "missing quantity",
  dupSerialFile: "duplicate serial {v}", dupSerialDb: "existing serial {v}", dupRfidFile: "duplicate RFID {v}", dupRfidDb: "existing RFID {v}", dupSkuFile: "duplicate SKU {v}", dupSkuDb: "existing SKU {v}", financialIgnored: "financial ignored",
};

describe("CSV column mapping before the existing dry run", () => {
  it("maps reordered custom headers and ignores a column without altering quoted cells", () => {
    const records = parseCsv('Description,Discard,Kind,Class,Serial,Brand,Store\n"Laptop, with dock",secret,asset,Existing laptops,SN-1,Existing company,Existing store');
    const mapped = mappedImportRecords(records, ["name", null, "item_type", "category", "serial_number", "company", "location"]);
    const result = validateImport(mapped, refs, { canFinancial: false }, messages);
    expect(result.error).toBe(0);
    expect(result.rows[0].normalized).toMatchObject({ item_type: "asset", name: "Laptop, with dock", category_id: "c", serial_number: "SN-1" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("infers aliases only once and refuses two source columns aimed at the same field", () => {
    expect(inferColumnMapping(["النوع", "name", "الاسم", "unknown", "category"])).toEqual(["item_type", "name", null, null, "category"]);
    expect(duplicateMappedFields(["name", "name"])).toEqual(["name"]);
    expect(() => mappedImportRecords([["A", "B"], ["a", "b"]], ["name", "name"])).toThrow("invalid_column_mapping");
  });
  it.each(["constructor", "__proto__"])("treats inherited key %s as a custom header that can be ignored or mapped", (header) => {
    const records = parseCsv(`${header},Type,Category,Serial,Brand,Location\nLaptop,asset,Existing laptops,SN-1,Existing company,Existing store`);
    const inferred = inferColumnMapping(records[0]);
    expect(inferred).toEqual([null, "item_type", "category", "serial_number", "company", "location"]);
    expect(() => mappedImportRecords(records, inferred)).not.toThrow();
    inferred[0] = "name";
    const result = validateImport(mappedImportRecords(records, inferred), refs, { canFinancial: false }, messages);
    expect(result.error).toBe(0);
    expect(result.rows[0].normalized).toMatchObject({ item_type: "asset", name: "Laptop", serial_number: "SN-1" });
  });
  it("removing a required mapping blocks import instead of treating ignored input as a default", () => {
    const mapped = mappedImportRecords([["Type", "Name", "Category"], ["asset", "Laptop", "Existing laptops"]], ["item_type", "name", null]);
    const result = validateImport(mapped, refs, { canFinancial: true }, messages);
    expect(result.headerError).toBe("missing category");
    expect(result.rows).toEqual([]);
  });
  it.each(["company", "location", "serial_number"] as const)("ignoring an asset's required %s column blocks its import", (field) => {
    const records = parseCsv("Kind,Item,Group,Serial,Brand,Store\nasset,Laptop,Existing laptops,SN-1,Existing company,Existing store");
    const mapping = ["item_type", "name", "category", "serial_number", "company", "location"] as const;
    const mapped = mappedImportRecords(records, mapping.map((target) => target === field ? null : target));
    const result = validateImport(mapped, refs, { canFinancial: false }, messages);
    expect(result.error).toBe(1);
    expect(result.rows[0].normalized).toBeNull();
    expect(result.rows[0].errors).toEqual([field === "serial_number" ? messages.missingSerial : field === "company" ? messages.missingCompany : messages.missingLocation]);
  });
  it("keeps unknown references as validation errors and preserves duplicate identifier detection", () => {
    const mapped = mappedImportRecords([["Kind", "Item", "Group", "Serial"], ["asset", "First", "New category", "SN-1"], ["asset", "Second", "Existing laptops", "SN-1"]], ["item_type", "name", "category", "serial_number"]);
    const result = validateImport(mapped, refs, { canFinancial: true }, messages);
    expect(result.rows[0].errors).toContain("unknown category New category");
    expect(result.rows[1].errors).toContain("duplicate serial SN-1");
    expect(result.rows.every((row) => row.normalized === null)).toBe(true);
  });
  it("uses only catalog references in template examples and does not invent a missing category", () => {
    const templateRefs = { ...refs, categories: [{ ...refs.categories[0], kind: "asset" }, { id: "cc", name: "Existing toner", name_ar: null, kind: "consumable" }] };
    const examples = importTemplateExamples(templateRefs, { asset: "Example asset", consumable: "Example consumable" });
    expect(examples).toHaveLength(2);
    expect(examples.every((row) => row.length === TEMPLATE_HEADERS.length)).toBe(true);
    expect(examples.map((row) => row[2])).toEqual(["Existing laptops", "Existing toner"]);
    expect(examples.every((row) => row[3] === "Existing company" && row[5] === "Existing store")).toBe(true);
    expect(importTemplateExamples({ ...templateRefs, categories: [] }, { asset: "A", consumable: "C" })).toEqual([]);
  });
  it("makes every issue reachable beyond 200 rows and clamps a page after the file shrinks", () => {
    const rows = Array.from({ length: 251 }, (_, row) => row + 1);
    const all = Array.from({ length: 6 }, (_, page) => issueRowsPage(rows, page).rows).flat();
    expect(all).toEqual(rows);
    expect(issueRowsPage(rows, 5)).toMatchObject({ from: 251, to: 251, page: 5, pages: 6 });
    expect(issueRowsPage(rows.slice(0, 2), 5)).toMatchObject({ rows: [1, 2], page: 0, pages: 1 });
  });
});
