import { canonHeader, TEMPLATE_HEADERS, type CanonField, type ImportRefs } from "./csv-import";

export type ColumnMapping = Array<CanonField | null>;

/** Match known headers once; duplicate aliases start ignored so no value is silently overwritten. */
export function inferColumnMapping(headers: readonly string[]): ColumnMapping {
  const used = new Set<CanonField>();
  return headers.map((header) => {
    const field = canonHeader(header);
    if (!field || used.has(field)) return null;
    used.add(field);
    return field;
  });
}

export function duplicateMappedFields(mapping: readonly (CanonField | null)[]): CanonField[] {
  return TEMPLATE_HEADERS.filter((field) => mapping.filter((target) => target === field).length > 1);
}

/** Feed the unchanged validator canonical headers. Ignored columns never enter its payload. */
export function mappedImportRecords(records: string[][], mapping: ColumnMapping): string[][] {
  if (records.length === 0) return [];
  if (mapping.length !== records[0].length || duplicateMappedFields(mapping).length > 0
    || mapping.some((field) => field !== null && !TEMPLATE_HEADERS.includes(field))) {
    throw new Error("invalid_column_mapping");
  }
  const fields = TEMPLATE_HEADERS.filter((field) => mapping.includes(field));
  return [fields, ...records.slice(1).map((row) => fields.map((field) => row[mapping.indexOf(field)] ?? ""))];
}

type TemplateRefs = Pick<ImportRefs, "locations" | "companies" | "suppliers"> & {
  categories: Array<ImportRefs["categories"][number] & { kind?: string }>;
};

/** Examples use names present in the current catalog; this never creates catalog references. */
export function importTemplateExamples(refs: TemplateRefs, labels: { asset: string; consumable: string }): string[][] {
  const company = refs.companies[0]?.name ?? "";
  const location = refs.locations[0]?.name ?? "";
  const supplier = refs.suppliers[0]?.name ?? "";
  const rows: string[][] = [];
  const assetCategory = refs.categories.find((category) => category.kind === "asset");
  const consumableCategory = refs.categories.find((category) => category.kind === "consumable");
  if (assetCategory) rows.push(["asset", labels.asset, assetCategory.name, company, supplier, location,
    "SN-EXAMPLE-1", "available", "", "", "", "", "", "", "", "", "", "", ""]);
  if (consumableCategory) rows.push(["consumable", labels.consumable, consumableCategory.name, company, supplier, location,
    "", "", "", "", "", "", "", "TONER-26A", "each", "10", "3", "", ""]);
  return rows;
}

export function issueRowsPage<T>(rows: readonly T[], requestedPage: number, pageSize = 50) {
  const size = Math.max(1, Math.floor(pageSize));
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(pages - 1, Math.max(0, Math.floor(requestedPage)));
  const start = page * size;
  return { rows: rows.slice(start, start + size), page, pages, from: rows.length ? start + 1 : 0, to: Math.min(rows.length, start + size) };
}
