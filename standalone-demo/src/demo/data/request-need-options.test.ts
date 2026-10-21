import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { assetMatchesNeed, groupAssetOptions, type GroupableAsset } from "../../studio/lib/request-options";
import { createDemoStore } from "./store";
import { createDemoTransport } from "./transport";
import { DEMO_SUPABASE_ANON_KEY, DEMO_SUPABASE_URL } from "./auth";
import { demoId } from "./seed";

describe("seeded request need labels use the source catalog contract", () => {
  it("offers an available replacement through the actual SDK projection and unchanged matcher", async () => {
    const store = createDemoStore({ memory: true });
    await store.setActor("warehouse_manager");
    const client = createClient(DEMO_SUPABASE_URL, DEMO_SUPABASE_ANON_KEY, {
      global: { fetch: createDemoTransport(store) },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    // Exact getRequestFormData projection, filters and stable pagination.
    const result = await client.from("assets").select("id,asset_tag,name,serial_number,status,pool_id,category_id,company_id,model_id, category:category_id(name,name_ar), company:company_id(name), model:model_id(brand,model_name), location:location_id(name,name_ar)")
      .eq("is_active", true).is("archived_at", null).order("asset_tag").order("id").range(0, 999)
      .overrideTypes<GroupableAsset[], { merge: false }>();
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(120);
    const assets = result.data!;
    const group = groupAssetOptions(assets).find(option => option.categoryId === demoId(4,1) && option.companyId === demoId(2,1) && option.modelLabel === "Dell Latitude 5450")!;
    expect(group).toMatchObject({ categoryLabel: "حاسب محمول", modelLabel: "Dell Latitude 5450", available_count: 3 });
    const state = await store.read();
    const request = state.tables.requests.find(row => row.id === demoId(16,5))!;
    const item = state.tables.request_items.find(row => row.request_id === request.id && row.asset_id === demoId(11,21))!;
    // These are precisely the three fields addItem persists from its selected group.
    expect(item).toMatchObject({ requested_category: group.categoryLabel, preferred_company_id: group.companyId, preferred_model: group.modelLabel });
    const need = { requested_category: String(item.requested_category), preferred_company_id: String(item.preferred_company_id), preferred_model: String(item.preferred_model) };
    const replacements = assets.filter(asset => asset.status === "available" && assetMatchesNeed(asset, need));
    expect(replacements.map(asset => asset.id).sort()).toEqual([demoId(11,41), demoId(11,81), demoId(11,101)].sort());
    const replacement = replacements.find(asset => asset.id === demoId(11,81))!;
    expect(replacement).toMatchObject({ status: "available", category: { name: "Laptop", name_ar: "حاسب محمول" }, company: { name: "Dell" }, model: { brand: "Dell", model_name: "Latitude 5450" } });
    expect(replacement.id).not.toBe(item.asset_id);
    expect(assetMatchesNeed(replacement, { ...need, requested_category: "Laptop", preferred_model: "Latitude 5450" })).toBe(false);
    expect(assets.filter(asset => assetMatchesNeed(asset, { ...need, preferred_company_id: demoId(2,2) }))).toHaveLength(0);
    expect(assets.filter(asset => assetMatchesNeed(asset, { ...need, requested_category: "شاشة" }))).toHaveLength(0);
    const durableNeeds = state.tables.request_items.filter(row => row.requested_kind === "existing_asset");
    expect(durableNeeds).toHaveLength(24);
    expect(durableNeeds.every(row => row.requested_category === group.categoryLabel && row.preferred_company_id === group.companyId && row.preferred_model === group.modelLabel)).toBe(true);
    expect(request.status).toBe("provisioned");
    expect(item).toMatchObject({ id: demoId(17,9), asset_id: demoId(11,21), quantity: 1, approved_quantity: 1, delivered_quantity: 0 });
    expect(state.tables.requests).toHaveLength(24);
    expect(state.tables.request_items).toHaveLength(48);
  });
});
