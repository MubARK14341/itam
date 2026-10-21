import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: mocks.createClient }));
import { getAsset, listAssetsPage } from "./queries";
import { collectCursorPages, type AscTextCursor } from "./pagination";
import { isAssetInventoryRow } from "./asset-inventory-row";
import { ASSET_VIEWS } from "./alert-predicates";
import { computeCompleteness } from "./asset-completeness";
import { getAssetTemplate, readSpecialAttribute } from "./asset-type-templates";
import { equipmentPhotoKind } from "./equipment-photos";
import { buildUnifiedRows } from "@/components/assets/unified-inventory-table";
import { quickViewFromAsset } from "@/components/assets/inventory-quick-view";
import type { AssetInventoryRow, AssetRow } from "./types";

const LIST_SELECT = "id,asset_tag,qr_token,name,serial_number,status,category_id,location_id,company_id,special_attributes,pool_id,last_return_condition,category:category_id(name,name_ar),model:model_id(brand,model_name),location:location_id(name,name_ar),holder:assigned_to_employee_id(full_name,full_name_ar),company:company_id(name),pool:pool_id(name,name_ar)";
type FullFixture = Omit<AssetRow, "model" | "special_attributes"> & {
  model: AssetInventoryRow["model"]; special_attributes: unknown;
  last_return_condition: string | null; notes: string;
  department: { name: string; name_ar: string | null }; supplier: { name: string; name_ar: string | null } };
function fullAsset(index = 0, overrides: Partial<FullFixture> = {}): FullFixture {
  return { id: `TEST-asset-${index}`, asset_tag: `TEST-${String(index).padStart(5, "0")}`, qr_token: `TEST-qr-${index}`,
    name: "TEST Epson L805", serial_number: `TEST-serial-${index}`, status: "in_maintenance",
    category_id: "TEST-category", location_id: "TEST-location", company_id: "TEST-company", pool_id: "TEST-pool",
    category: { name: "Printer", name_ar: "طابعة" }, model: { brand: "TEST brand", model_name: "TEST model" },
    location: { name: "TEST office", name_ar: "مكتب تجريبي" }, company: { name: "TEST company" },
    holder: { full_name: "TEST holder", full_name_ar: "مستلم تجريبي" }, pool: { name: "TEST pool", name_ar: "مجموعة تجريبية" },
    special_attributes: { section: "Printers", printerType: "card", printCounter: 0, purchaseCost: 0, optionalBoolean: false, optionalNull: null },
    purchase_cost: 0, purchase_date: "2026-01-01", currency: "SAR", warranty_end: "2027-01-01",
    condition_grade: "A", rfid_tag: "TEST-rfid", last_return_condition: "needs_maintenance", notes: "TEST detail notes",
    department: { name: "TEST department", name_ar: null }, supplier: { name: "TEST supplier", name_ar: null }, ...overrides };
}
function inventoryAsset(asset: FullFixture): AssetInventoryRow {
  return { id: asset.id, asset_tag: asset.asset_tag, qr_token: asset.qr_token, name: asset.name, serial_number: asset.serial_number,
    status: asset.status, category_id: asset.category_id, location_id: asset.location_id, company_id: asset.company_id,
    special_attributes: asset.special_attributes, pool_id: asset.pool_id, last_return_condition: asset.last_return_condition,
    category: asset.category, model: asset.model, location: asset.location, holder: asset.holder, company: asset.company, pool: asset.pool };
}

// These independent outcomes pin the existing classifier, including historical
// false/0 truthiness behavior, rather than merely comparing two new readers.
const opaqueAttributes: { value: unknown; template: "other" | "sim" | "printer"; photo: "paper-printer" | "card-printer" | null }[] = [
  { value: null, template: "other", photo: null },
  { value: false, template: "sim", photo: null },
  { value: true, template: "other", photo: null },
  { value: 0, template: "sim", photo: null },
  { value: 42, template: "other", photo: null },
  { value: "", template: "other", photo: null },
  { value: "TEST opaque", template: "other", photo: null },
  { value: [], template: "other", photo: null },
  { value: ["Printers", 0, false, null, { msisdn: "TEST nested SIM" }], template: "other", photo: null },
  { value: { section: ["Printers"], printerType: "card", printCounter: 0, optionalBoolean: false, optionalNull: null }, template: "printer", photo: "card-printer" },
  { value: { section: "Printers", printerType: "paper", printCounter: 0, nested: [false, 0, null, { other: "TEST" }] }, template: "printer", photo: "paper-printer" },
  { value: { section: 0, msisdn: false, expiryDate: null }, template: "sim", photo: null },
  { value: { section: null, msisdn: 0, monthlyCost: 0 }, template: "sim", photo: null },
];
function opaqueAsset(index: number, attributes: unknown): FullFixture {
  return fullAsset(index, { name: "TEST device", serial_number: "TEST opaque serial", category: { name: "Other", name_ar: null },
    model: { brand: null, model_name: "TEST brandless model" }, special_attributes: attributes });
}

describe("operational asset inventory projection through the installed SDK", () => {
  let requests: { url: URL; signal: AbortSignal | null | undefined; prefer: string | null }[];
  let source: FullFixture[];
  const NO_MALFORMATION = Symbol("TEST normal collection response");
  let malformed: unknown;
  let malformedAfter: string | null;
  let responses: { status: number; bodyWasNull: boolean; rowCount: number | null }[];
  let beforeResponse: ((signal: AbortSignal | null | undefined) => Promise<void>) | null;
  beforeEach(() => {
    requests = []; source = Array.from({ length: 1105 }, (_, index) => fullAsset(index));
    malformed = NO_MALFORMATION; malformedAfter = null; responses = []; beforeResponse = null;
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      requests.push({ url, signal: init?.signal, prefer: headers.get("prefer") });
      if (beforeResponse) await beforeResponse(init?.signal);
      if (url.pathname !== "/rest/v1/assets") throw new Error("Unexpected TEST source: operational inventory must not call a financial RPC");
      const select = url.searchParams.get("select");
      if (select !== LIST_SELECT) {
        expect(url.searchParams.get("id")).toBe(`eq.${source[0].id}`);
        expect(select).toContain("department:department_id(name,name_ar)");
        expect(select).toContain("supplier:supplier_id(name,name_ar)");
        const { purchase_cost: _financial, ...detail } = source[0];
        return new Response(JSON.stringify(detail), { headers: { "content-type": "application/json" } });
      }
      const after = url.searchParams.get("asset_tag")?.slice(3);
      const eligible = source.filter(row => !after || (row.asset_tag !== null && row.asset_tag > after));
      const limit = Number(url.searchParams.get("limit"));
      const rows = eligible.slice(0, limit).map(inventoryAsset);
      const count = headers.get("prefer")?.includes("count=exact") ? `/${eligible.length}` : "/*";
      const body = malformed !== NO_MALFORMATION && (malformedAfter === null || after === malformedAfter) ? malformed : rows;
      const status = body === null || rows.length === 0 ? 200 : 206;
      responses.push({ status, bodyWasNull: body === null, rowCount: Array.isArray(body) ? body.length : null });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json",
        "content-range": rows.length === 0 ? `*${count}` : `0-${rows.length - 1}${count}` } });
    };
    mocks.createClient.mockReturnValue(createSupabaseClient("http://localhost:65421", "TEST-anon", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport },
    }));
  });

  it("selects every inventory field without loading unused detail joins or financial sources", async () => {
    const page = await listAssetsPage({ pageSize: 2 });
    expect(page.error).toBeNull(); expect(page.rows).toEqual(source.slice(0, 2).map(inventoryAsset));
    expect(requests).toHaveLength(1); expect(requests[0].url.searchParams.get("select")).toBe(LIST_SELECT);
    expect(page.rows[0]).not.toHaveProperty("purchase_cost");
    expect(page.rows[0]).not.toHaveProperty("notes");
    expect(page.rows[0]).not.toHaveProperty("supplier");
    expect(page.rows[0]).not.toHaveProperty("department");
    expect(page.rows[0].special_attributes).toEqual(source[0].special_attributes);
  });

  it("retains first-page exact count, unique-tag cursor and one lookahead row", async () => {
    const first = await listAssetsPage({ pageSize: 100 });
    expect(first.total).toBe(1105); expect(first.rows).toHaveLength(100);
    expect(first.nextCursor).toEqual({ value: "TEST-00099", id: "TEST-asset-99" });
    const second = await listAssetsPage({ pageSize: 100, cursor: first.nextCursor });
    expect(second.total).toBeNull(); expect(second.rows[0].id).toBe("TEST-asset-100");
    expect(requests.map(row => row.url.searchParams.get("limit"))).toEqual(["101", "101"]);
    expect(requests.map(row => row.url.searchParams.get("order"))).toEqual(["asset_tag.asc", "asset_tag.asc"]);
    expect(requests[0].prefer).toContain("count=exact"); expect(requests[1].prefer ?? "").not.toContain("count=exact");
  });

  it("keeps all canonical filters and stable unsound-return predicates", async () => {
    await listAssetsPage({ filters: { categoryId: "TEST-category", locationId: "TEST-location", companyId: "TEST-company",
      poolId: "TEST-pool", status: "in_maintenance", view: "unsound_return", q: "TEST (printer), serial" } });
    const query = requests[0].url.searchParams;
    for (const [key, expected] of [["is_active", "eq.true"], ["archived_at", "is.null"], ["category_id", "eq.TEST-category"],
      ["location_id", "eq.TEST-location"], ["company_id", "eq.TEST-company"], ["pool_id", "eq.TEST-pool"]]) expect(query.get(key)).toBe(expected);
    expect(query.getAll("status")).toEqual(["eq.in_maintenance", "eq.in_maintenance"]);
    expect(query.get("last_return_condition")).toBe("in.(unsound,needs_maintenance)");
    expect(query.get("or")).toContain("serial_number.ilike.");
    expect(query.get("or")).toContain("TEST (printer), serial");
  });

  it("still collects all 1105 work-queue rows in stable order for the existing full CSV", async () => {
    const full = await collectCursorPages<AssetInventoryRow, AscTextCursor>((cursor) => listAssetsPage({ cursor, pageSize: 250,
      filters: { view: "unsound_return" } }));
    expect(full.error).toBeNull(); expect(full.rows.map(row => row.id)).toEqual(source.map(row => row.id));
    expect(full.rows.every(ASSET_VIEWS.unsound_return)).toBe(true); expect(requests).toHaveLength(5);
    const csv = full.rows.map(row => [row.asset_tag, row.name, row.category?.name_ar ?? row.category?.name,
      row.status, row.location?.name_ar ?? row.location?.name, row.holder?.full_name_ar ?? row.holder?.full_name]);
    expect(csv).toEqual(source.map(row => [row.asset_tag, row.name, row.category?.name_ar ?? row.category?.name,
      row.status, row.location?.name_ar ?? row.location?.name, row.holder?.full_name_ar ?? row.holder?.full_name]));
  });

  it("keeps a legitimate NULL catalog brand on whole SDK pages and all 1105 exported rows", async () => {
    for (const index of [0, 100, 1000, 1104]) source[index] = fullAsset(index, { model: { brand: null, model_name: `TEST brandless ${index}` } });
    const first = await listAssetsPage({ pageSize: 100 });
    expect(first.error).toBeNull(); expect(first.total).toBe(1105); expect(first.rows).toHaveLength(100);
    expect(first.rows.map(row => row.id)).toEqual(source.slice(0, 100).map(row => row.id));
    expect(first.rows[0].model).toEqual({ brand: null, model_name: "TEST brandless 0" });
    requests.length = 0;
    const complete = await collectCursorPages<AssetInventoryRow, AscTextCursor>(cursor => listAssetsPage({ cursor, pageSize: 250 }));
    expect(complete.error).toBeNull(); expect(complete.rows).toHaveLength(1105); expect(requests).toHaveLength(5);
    expect(complete.rows.map(row => row.id)).toEqual(source.map(row => row.id));
    expect(complete.rows.filter(row => row.model?.brand === null).map(row => row.id)).toEqual([0, 100, 1000, 1104].map(index => source[index].id));
    const exportFields = (row: AssetInventoryRow) => [row.asset_tag, row.name, row.category?.name_ar ?? row.category?.name,
      row.status, row.location?.name_ar ?? row.location?.name, row.holder?.full_name_ar ?? row.holder?.full_name];
    expect(complete.rows.map(exportFields)).toEqual(source.map(exportFields));
  });

  it("preserves every opaque JSON kind through SDK pages and complete CSV collection", async () => {
    for (const [index, sample] of opaqueAttributes.entries()) {
      source[index] = opaqueAsset(index, sample.value);
      source[1000 + index] = opaqueAsset(1000 + index, sample.value);
    }
    const first = await listAssetsPage({ pageSize: 100 });
    expect(first.error).toBeNull(); expect(first.rows).toHaveLength(100); expect(first.total).toBe(1105);
    expect(first.rows.slice(0, opaqueAttributes.length).map(row => row.special_attributes)).toEqual(opaqueAttributes.map(sample => sample.value));
    requests.length = 0;
    const complete = await collectCursorPages<AssetInventoryRow, AscTextCursor>(cursor => listAssetsPage({ cursor, pageSize: 250 }));
    expect(complete.error).toBeNull(); expect(complete.rows.map(row => row.id)).toEqual(source.map(row => row.id));
    expect(complete.rows.map(row => row.special_attributes)).toEqual(source.map(row => row.special_attributes));
    expect(requests).toHaveLength(5);
    const exportFields = (row: AssetInventoryRow) => [row.asset_tag, row.name, row.category?.name_ar ?? row.category?.name,
      row.status, row.location?.name_ar ?? row.location?.name, row.holder?.full_name_ar ?? row.holder?.full_name];
    expect(complete.rows.map(exportFields)).toEqual(source.map(exportFields));
  });

  it("rejects a missing selected attributes field without rejecting valid opaque JSON", async () => {
    const { special_attributes: _missing, ...withoutAttributes } = inventoryAsset(source[1]);
    malformed = [inventoryAsset(source[0]), withoutAttributes];
    const missing = await listAssetsPage();
    expect(missing.error).toBe("asset_inventory_shape_invalid"); expect(missing.rows).toEqual([]);
    expect(missing.nextCursor).toBeNull(); expect(missing.total).toBeNull();
    malformed = [inventoryAsset(source[0]), { ...inventoryAsset(source[1]), special_attributes: undefined }];
    const undefinedField = await listAssetsPage(); // JSON omits undefined: it is still a missing field on the wire.
    expect(undefinedField.error).toBe("asset_inventory_shape_invalid"); expect(undefinedField.rows).toEqual([]);
  });

  it("passes cancellation to the real SDK without exposing late partial rows", async () => {
    let started!: () => void;
    const reached = new Promise<void>(resolve => { started = resolve; });
    beforeResponse = signal => new Promise<void>((_resolve, reject) => {
      if (!signal) { reject(new Error("TEST caller signal missing")); return; }
      signal.addEventListener("abort", () => reject(new DOMException("TEST aborted", "AbortError")), { once: true }); started();
    });
    const controller = new AbortController(), pending = listAssetsPage({ signal: controller.signal });
    await reached; controller.abort();
    const page = await pending;
    expect(requests[0].signal).toBe(controller.signal); expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull(); expect(page.error).not.toBeNull(); expect(requests).toHaveLength(1);
  });

  it("rejects malformed scalar/null FK shapes instead of asserting full absent detail data", async () => {
    malformed = [{ ...inventoryAsset(source[0]), holder: [source[0].holder] }];
    const page = await listAssetsPage();
    expect(page.rows).toEqual([]); expect(page.nextCursor).toBeNull(); expect(page.total).toBeNull();
    expect(page.error).toBe("asset_inventory_shape_invalid");
  });

  it("rejects a successful non-array response without throwing or returning partial data", async () => {
    malformed = { ...inventoryAsset(source[0]) };
    const page = await listAssetsPage();
    expect(page.rows).toEqual([]); expect(page.error).toBe("asset_inventory_shape_invalid");
    expect(page.nextCursor).toBeNull(); expect(page.total).toBeNull();
  });

  it("rejects an initial HTTP 200 JSON null collection through the real SDK and export collector", async () => {
    malformed = null;
    const page = await listAssetsPage();
    expect(page.error).toBe("asset_inventory_shape_invalid"); expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull(); expect(page.total).toBeNull();
    const complete = await collectCursorPages<AssetInventoryRow, AscTextCursor>(cursor => listAssetsPage({ cursor, pageSize: 250 }));
    expect(complete.error).toBe("asset_inventory_shape_invalid"); expect(complete.rows).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(responses).toEqual([{ status: 200, bodyWasNull: true, rowCount: null }, { status: 200, bodyWasNull: true, rowCount: null }]);
  });

  it("discards all earlier export rows when the last SDK cursor response is HTTP 200 JSON null", async () => {
    malformed = null; malformedAfter = "TEST-00999";
    const complete = await collectCursorPages<AssetInventoryRow, AscTextCursor>(cursor => listAssetsPage({ cursor, pageSize: 250 }));
    expect(complete.error).toBe("asset_inventory_shape_invalid"); expect(complete.rows).toEqual([]);
    expect(requests).toHaveLength(5);
    expect(requests.map(request => request.url.searchParams.get("asset_tag"))).toEqual([
      null, "gt.TEST-00249", "gt.TEST-00499", "gt.TEST-00749", "gt.TEST-00999",
    ]);
    expect(responses.slice(0, 4)).toEqual(Array.from({ length: 4 }, () => ({ status: 206, bodyWasNull: false, rowCount: 251 })));
    expect(responses[4]).toEqual({ status: 200, bodyWasNull: true, rowCount: null });
  });

  it("accepts genuine HTTP 200 empty arrays with exact zero count and complete empty export", async () => {
    source = [];
    const page = await listAssetsPage();
    expect(page).toEqual({ rows: [], nextCursor: null, total: 0, error: null });
    const complete = await collectCursorPages<AssetInventoryRow, AscTextCursor>(cursor => listAssetsPage({ cursor, pageSize: 250 }));
    expect(complete).toEqual({ rows: [], error: null }); expect(requests).toHaveLength(2);
    expect(responses).toEqual([{ status: 200, bodyWasNull: false, rowCount: 0 }, { status: 200, bodyWasNull: false, rowCount: 0 }]);
    for (const request of requests) expect(request.prefer).toContain("count=exact");
  });

  it("leaves full detail joins and nonfinancial detail fields untouched", async () => {
    const detail = await getAsset(source[0].id, false);
    expect(detail.error).toBeNull(); expect(detail.asset).toMatchObject({ notes: source[0].notes,
      department: source[0].department, supplier: source[0].supplier, warranty_end: source[0].warranty_end,
      condition_grade: source[0].condition_grade, purchase_date: source[0].purchase_date });
    expect(requests).toHaveLength(1); expect(requests[0].url.searchParams.get("select")).not.toBe(LIST_SELECT);
  });
});

describe("reduced inventory presentation preserves full-row behavior", () => {
  it("keeps template/photo/completeness, model search, holder and selected CSV fields across categories", () => {
    const examples = [
      fullAsset(0),
      fullAsset(1, { name: "TEST Honeywell EDA51", special_attributes: { section: "Scanners", scannerType: "TEST", hasCharger: false, readingStatus: null } }),
      fullAsset(2, { name: "TEST router", special_attributes: { section: "Routers", msisdn: "TEST SIM", monthlyCost: 0, expiryDate: null, renewalReminder: false } }),
      fullAsset(3, { name: "TEST device", category: { name: "Other", name_ar: null }, serial_number: "TEST-LAPTOP", special_attributes: null,
        holder: null, model: null, location: null, company: null, pool: null, pool_id: null, location_id: null, company_id: null }),
      ...["paper", "card", "label", "receipt", "thermal"].map((printerType, index) => fullAsset(index + 4, { special_attributes: { printerType, section: "Printers" } })),
    ];
    for (const full of examples) {
      const lean = inventoryAsset(full); expect(isAssetInventoryRow(lean)).toBe(true);
      expect(getAssetTemplate(lean).id).toBe(getAssetTemplate(full).id);
      expect(equipmentPhotoKind(lean)).toBe(equipmentPhotoKind(full));
      if (readSpecialAttribute(lean, "msisdn")) {
        const noFin = computeCompleteness(lean, { canSeeFinancial: false, canWrite: true });
        const fin = computeCompleteness(lean, { canSeeFinancial: true, canWrite: true });
        expect(fin.filled).toBe(noFin.filled + 1); // legitimate monthlyCost=0 is present only for authorized completeness.
        expect(fin.missingKeys).not.toContain("monthlyCost"); expect(fin.missingKeys).toContain("expiryDate");
      }
      if (readSpecialAttribute(lean, "hasCharger") === false) {
        const result = computeCompleteness(lean, { canSeeFinancial: false, canWrite: true });
        expect(result.missingKeys).not.toContain("hasCharger"); expect(result.missingKeys).toContain("readingStatus");
      }
      for (const opts of [{ canSeeFinancial: false, canWrite: false }, { canSeeFinancial: true, canWrite: true }]) {
        expect(computeCompleteness(lean, opts)).toEqual(computeCompleteness(full, opts));
      }
      for (const lang of ["ar", "en"] as const) {
        const { equipment: _fullEquipment, ...before } = quickViewFromAsset(full, lang);
        const { equipment: _leanEquipment, ...after } = quickViewFromAsset(lean, lang);
        expect(after).toEqual(before);
      }
      const { equipment: _fullEquipment, ...before } = buildUnifiedRows([full], [], [])[0];
      const { equipment: _leanEquipment, ...after } = buildUnifiedRows([lean], [], [])[0];
      expect(after).toEqual(before);
      expect(after.searchHay).toContain(full.serial_number?.toLowerCase() ?? "");
      expect(after.holderOrQty).toBe(full.holder?.full_name_ar ?? full.holder?.full_name ?? "—");
      const selectedCsv = (row: typeof after) => [row.type, row.code, row.name, row.categoryLabel, row.assetStatus, row.location, row.holderOrQty, row.company];
      expect(selectedCsv(after)).toEqual(selectedCsv(before));
      for (const predicate of Object.values(ASSET_VIEWS)) expect(predicate(lean)).toBe(predicate(full));
    }
  });

  it("preserves NULL-brand quick view, unified search and selected CSV presentation", () => {
    const full = fullAsset(0, { model: { brand: null, model_name: "TEST brandless model" } });
    const lean = inventoryAsset(full);
    expect(isAssetInventoryRow(lean)).toBe(true);
    for (const lang of ["ar", "en"] as const) {
      const { equipment: _fullEquipment, ...before } = quickViewFromAsset(full, lang);
      const { equipment: _leanEquipment, ...after } = quickViewFromAsset(lean, lang);
      expect(after).toEqual(before); expect(after.model).toBe("null TEST brandless model"); // existing display, unchanged by this proposal.
    }
    const { equipment: _fullEquipment, ...before } = buildUnifiedRows([full], [], [])[0];
    const { equipment: _leanEquipment, ...after } = buildUnifiedRows([lean], [], [])[0];
    expect(after).toEqual(before); expect(after.searchHay).toContain("test brandless model");
    const selectedCsv = (row: typeof after) => [row.type, row.code, row.name, row.categoryLabel, row.assetStatus, row.location, row.holderOrQty, row.company];
    expect(selectedCsv(after)).toEqual(selectedCsv(before));
  });

  it("pins opaque JSON classification and preserves full-versus-lean photo/completeness/presentation", () => {
    for (const [index, sample] of opaqueAttributes.entries()) {
      const full = opaqueAsset(index, sample.value), lean = inventoryAsset(full);
      expect(isAssetInventoryRow(lean)).toBe(true); expect(lean.special_attributes).toBe(full.special_attributes);
      for (const asset of [full, lean]) {
        expect(getAssetTemplate(asset).id).toBe(sample.template);
        expect(equipmentPhotoKind(asset)).toBe(sample.photo);
        if (sample.value === null || typeof sample.value !== "object" || Array.isArray(sample.value)) {
          expect(readSpecialAttribute(asset, "section")).toBeUndefined();
          expect(readSpecialAttribute(asset, "msisdn")).toBeUndefined();
          expect(readSpecialAttribute(asset, "printerType")).toBeUndefined();
          const completeness = computeCompleteness(asset, { canSeeFinancial: true, canWrite: true });
          expect(completeness.filled).toBe(0); expect(completeness.templateId).toBe(sample.template);
        }
      }
      for (const opts of [{ canSeeFinancial: false, canWrite: false }, { canSeeFinancial: true, canWrite: true }]) {
        expect(computeCompleteness(lean, opts)).toEqual(computeCompleteness(full, opts));
      }
      for (const lang of ["ar", "en"] as const) {
        const { equipment: _fullEquipment, ...before } = quickViewFromAsset(full, lang);
        const { equipment: _leanEquipment, ...after } = quickViewFromAsset(lean, lang);
        expect(after).toEqual(before);
      }
      const { equipment: _fullEquipment, ...before } = buildUnifiedRows([full], [], [])[0];
      const { equipment: _leanEquipment, ...after } = buildUnifiedRows([lean], [], [])[0];
      expect(after).toEqual(before);
    }
    const mixed = opaqueAsset(99, { printCounter: 0, hasCharger: false, optionalNull: null });
    expect(readSpecialAttribute(mixed, "printCounter")).toBe(0);
    expect(readSpecialAttribute(mixed, "hasCharger")).toBe(false);
    expect(readSpecialAttribute(mixed, "optionalNull")).toBeNull();
  });

  it("validates required list fields with legitimate NULLs and opaque attributes, without string coercion", () => {
    const row = inventoryAsset(fullAsset());
    expect(isAssetInventoryRow({ ...row, name: null, asset_tag: null, serial_number: null, category: null, model: null,
      holder: null, location: null, company: null, pool: null, special_attributes: null })).toBe(true);
    for (const change of [{ id: undefined }, { company: [] }, { status: { toString: null } }, { pool_id: undefined }, { last_return_condition: undefined },
      { model: { brand: undefined, model_name: "TEST" } }, { model: { brand: 0, model_name: "TEST" } },
      { model: { brand: null, model_name: null } }, { special_attributes: undefined }]) {
      expect(isAssetInventoryRow({ ...row, ...change })).toBe(false);
    }
    expect(readSpecialAttribute(row, "purchaseCost")).toBe(0); expect(readSpecialAttribute(row, "optionalBoolean")).toBe(false);
    expect(readSpecialAttribute(row, "optionalNull")).toBeNull();
  });
});
