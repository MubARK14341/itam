import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { visibleLocations } from "../../studio/lib/locations";
import { createDemoStore } from "./store";
import { createDemoTransport } from "./transport";
import { DEMO_SUPABASE_ANON_KEY, DEMO_SUPABASE_URL } from "./auth";
import { demoId } from "./seed";

describe("canonical guided scan warehouse options", () => {
  it("exposes exactly one WH while preserving the six locations and linked inventory", async () => {
    const store = createDemoStore({ memory: true });
    await store.setActor("warehouse_manager");
    const client = createClient(DEMO_SUPABASE_URL, DEMO_SUPABASE_ANON_KEY, {
      global: { fetch: createDemoTransport(store) },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    // This is getFormOptions' exact SDK projection and its existing visibility
    // filter, followed by the scan page's exact warehouse selector.
    const result = await client.from("locations").select("id,name,name_ar,code").order("name");
    expect(result.error).toBeNull();
    const options = visibleLocations(result.data);
    const warehouse = options.find(location => location.code === "WH");
    expect(options).toHaveLength(6);
    expect(options.filter(location => location.code === "WH")).toHaveLength(1);
    expect(warehouse).toEqual({ id: demoId(5,1), name: "المستودع الرئيسي", name_ar: "المستودع الرئيسي", code: "WH" });
    expect(options.filter(location => location.id !== warehouse!.id).map(location => location.code).sort()).toEqual(["LOC-2", "LOC-3", "LOC-4", "LOC-5", "LOC-6"]);
    const state = await store.read();
    expect(state.tables.inventory_settings[0].default_location_id).toBe(warehouse!.id);
    expect(state.tables.stocktakes.find(stocktake => stocktake.id === demoId(26,1))?.location_id).toBe(warehouse!.id);
    expect(state.tables.consumables.every(consumable => consumable.location_id === warehouse!.id)).toBe(true);
    const asset = await client.from("assets").select("id,asset_tag,status,location_id").eq("id", demoId(11,101)).single();
    expect(asset.error).toBeNull();
    expect(asset.data).toEqual({ id: demoId(11,101), asset_tag: "LAP-0101", status: "available", location_id: warehouse!.id });
  });
});
