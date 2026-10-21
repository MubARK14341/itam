import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: mocks.createClient }));
import { getReportData } from "./queries";
import { reportAssetCacheKey, reportLoadPlan } from "./report-load-plan";
import type { ReportTab } from "./report-layout";
import { getTemplateByCategoryOrSection } from "./asset-type-templates";
import { computeDepreciation, pickRule, type DepreciationRule } from "./depreciation";

const purchaseCosts = [0, null, 1000];
const assets = [0, 1, 2].map((index) => ({
  id: `TEST-asset-${index}`, status: "reserved", purchase_date: "2026-01-01", currency: "SAR",
  asset_tag: `TEST-${index}`, name: `TEST asset ${index}`, company_id: "TEST-company",
  category: { id: "TEST-category", name: "Laptop", name_ar: "حاسب" },
  location: { id: "TEST-location", name: "Office", name_ar: "مكتب" },
  department: { id: "TEST-department", name: "IT", name_ar: "تقنية" },
  company: { id: "TEST-company", name: "TEST company" },
  holder: { id: "TEST-holder", full_name: "TEST employee", full_name_ar: "موظف تجريبي" },
  serial_number: `TEST-serial-${index}`, special_attributes: index === 2
    ? { section: "laptops", msisdn: "TEST-SIM-identity" } : { section: "laptops", processor: "TEST" },
  model_id: "TEST-model", pool_id: "TEST-pool", warranty_end: "2027-01-01",
}));

describe("report asset projections through the installed Data API client", () => {
  let requests: { path: string; select: string; signal: AbortSignal | null | undefined }[];

  beforeEach(() => {
    requests = [];
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const select = url.searchParams.get("select") ?? "";
      requests.push({ path: url.pathname, select, signal: init?.signal });
      if (url.pathname === "/rest/v1/assets") {
        const from = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? assets.length);
        const rows = assets.slice(from, from + limit).map((asset) => Object.fromEntries(
          Object.entries(asset).filter(([key]) => select.includes(key)),
        ));
        return new Response(JSON.stringify(rows), { headers: {
          "content-type": "application/json", "content-range": `${from}-${from + rows.length - 1}/${assets.length}`,
        } });
      }
      if (url.pathname === "/rest/v1/rpc/assets_financial") {
        const { p_ids: ids } = JSON.parse(String(init?.body)) as { p_ids: string[] };
        return new Response(JSON.stringify(ids.map((id) => ({ id, purchase_cost: purchaseCosts[assets.findIndex(asset => asset.id === id)] }))), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("Unexpected TEST Data API request");
    };
    mocks.createClient.mockReturnValue(createSupabaseClient("http://localhost:65421", "TEST-anon", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: transport },
    }));
  });

  it("keeps inventory CSV/filter and financial fields while excluding executive/custody-only payload", async () => {
    const signal = new AbortController().signal;
    const result = await getReportData(true, { datasets: ["assets"], assetProjection: "inventory", signal });
    expect(result.error).toBeNull();
    expect(result.assets).toEqual(assets.map(({ holder: _holder, serial_number: _serial, special_attributes: _attributes,
      model_id: _model, pool_id: _pool, warranty_end: _warranty, ...asset }, index) => ({ ...asset, purchase_cost: purchaseCosts[index] })));
    expect(requests[0].select).toBe("id,status,purchase_date,currency,asset_tag,name,company_id,category:category_id(id,name,name_ar),location:location_id(id,name,name_ar),department:department_id(id,name,name_ar),company:company_id(id,name)");
    const linked = requests[0].signal;
    expect(linked).toBeInstanceOf(AbortSignal); expect(linked).not.toBe(signal);
    expect(requests.every((request) => request.signal === linked)).toBe(true);
  });

  it("preserves the full legacy projection when no projection option is supplied", async () => {
    const result = await getReportData(false, { datasets: ["assets"] });
    expect(result.error).toBeNull();
    expect(result.assets).toEqual(assets);
    expect(requests[0].select).toContain("special_attributes");
    expect(requests[0].select).toContain("holder:assigned_to_employee_id(id,full_name,full_name_ar)");
    expect(requests).toHaveLength(1);
  });

  it("preserves executive template, filter and depreciation inputs independently of the full custody projection", async () => {
    const executive = await getReportData(true, { datasets: ["assets"], assetProjection: reportLoadPlan("executive").assetProjection });
    const full = await getReportData(true, { datasets: ["assets"] });
    const summarize = (row: typeof executive.assets[number]) => {
      const template = getTemplateByCategoryOrSection(row.category?.name, row.category?.name_ar,
        row.special_attributes?.section ?? null, row.name, row.serial_number, row.special_attributes);
      const rules: DepreciationRule[] = [{ id: "TEST-rule", category_id: "TEST-category", asset_type: template,
        annual_rate: 25, salvage_rate: 10, method: "straight_line", is_active: true }];
      return { template, currency: row.currency, company: row.company, location: row.location, department: row.department,
        status: row.status, depreciation: computeDepreciation(row.purchase_cost, row.purchase_date,
          pickRule(rules, row.category?.id, template), new Date("2026-10-09T00:00:00Z")) };
    };
    expect(executive.error).toBeNull();
    expect(executive.assets.map(summarize)).toEqual(full.assets.map(summarize));
    expect(summarize(executive.assets[2]).template).toBe("sim");
    expect(summarize(executive.assets[2]).depreciation.currentValue).toBeGreaterThan(0);
    expect(summarize(executive.assets[2]).depreciation.currentValue).toBeLessThan(1000);
    expect(executive.assets[0]).toMatchObject({ serial_number: assets[0].serial_number, special_attributes: assets[0].special_attributes });
    for (const field of ["holder", "warranty_end", "model_id", "pool_id"]) expect(executive.assets[0]).not.toHaveProperty(field);
  });

  it("isolates inventory, executive and nonfinancial custody data in the shared mounted-cache key", async () => {
    const cache = new Map<string, Awaited<ReturnType<typeof getReportData>>>();
    const loadAssets = async (tab: ReportTab, scope = "TEST-user|approved|TEST-epoch") => {
      const plan = reportLoadPlan(tab), financial = tab !== "custody";
      const key = reportAssetCacheKey(scope, financial, plan.assetProjection);
      const cached = cache.get(key);
      if (cached) return cached;
      const result = await getReportData(financial, { datasets: ["assets"], assetProjection: plan.assetProjection });
      expect(result.error).toBeNull(); cache.set(key, result); return result;
    };

    expect((await loadAssets("inventory")).assets[0]).not.toHaveProperty("special_attributes");
    const executive = await loadAssets("executive");
    expect(executive.assets[0].special_attributes).toEqual(assets[0].special_attributes);
    expect(executive.assets[0].serial_number).toBe(assets[0].serial_number);
    expect(executive.assets[0].purchase_cost).toBe(0);
    expect(executive.assets[0]).not.toHaveProperty("holder");
    const beforeCustody = requests.length;
    const custody = await loadAssets("custody");
    expect(custody.assets[0].holder).toEqual(assets[0].holder);
    expect(custody.assets[0]).not.toHaveProperty("purchase_cost");
    expect(requests.slice(beforeCustody).map((request) => request.path)).toEqual(["/rest/v1/assets"]);
    const beforeReturning = requests.length;
    expect((await loadAssets("inventory")).assets[0]).not.toHaveProperty("holder");
    expect(requests).toHaveLength(beforeReturning);
    expect(requests.filter((request) => request.path === "/rest/v1/assets")).toHaveLength(3);
    await loadAssets("inventory", "TEST-other-user|approved|TEST-epoch");
    await loadAssets("inventory", "TEST-user|approved|TEST-new-epoch");
    expect(requests.filter((request) => request.path === "/rest/v1/assets")).toHaveLength(5);
  });

  it("preserves every NOFIN executive operational filter/group/CSV input without transporting unused depreciation attributes", async () => {
    const executive = await getReportData(false, { datasets: ["assets"], assetProjection: "executive" });
    const full = await getReportData(false, { datasets: ["assets"] });
    const operational = (row: typeof executive.assets[number]) => ({
      id: row.id, tag: row.asset_tag, name: row.name, status: row.status,
      purchaseDate: row.purchase_date, currency: row.currency, companyId: row.company_id,
      category: row.category, location: row.location, department: row.department, company: row.company,
    });
    expect(executive.error).toBeNull(); expect(full.error).toBeNull();
    expect(executive.assets.map(operational)).toEqual(full.assets.map(operational));
    expect(executive.assets.map(row => row.category?.id)).toEqual(assets.map(row => row.category.id));
    expect(executive.assets.map(row => row.location?.id)).toEqual(assets.map(row => row.location.id));
    expect(executive.assets.map(row => row.department?.id)).toEqual(assets.map(row => row.department.id));
    expect(executive.assets.map(row => row.company_id)).toEqual(assets.map(row => row.company_id));
    for (const row of executive.assets) {
      for (const field of ["purchase_cost", "special_attributes", "serial_number", "holder", "warranty_end", "model_id", "pool_id"]) expect(row).not.toHaveProperty(field);
    }
    expect(full.assets[0].special_attributes).toEqual(assets[0].special_attributes);
    expect(full.assets[0].serial_number).toBe(assets[0].serial_number);
    expect(requests.every(request => request.path === "/rest/v1/assets")).toBe(true);
  });
});
