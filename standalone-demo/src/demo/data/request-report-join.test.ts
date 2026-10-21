import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createDemoStore } from "./store";
import { createDemoTransport } from "./transport";
import { DEMO_SUPABASE_ANON_KEY, DEMO_SUPABASE_URL } from "./auth";
import { demoId } from "./seed";

type ReportChild = { id: string; request_id: string; request: { id: string } };
const reportChildProjection = "id,request_id,request:requests!request_items_request_id_fkey!inner(id)";

async function setup() {
  const store = createDemoStore({ memory: true });
  await store.setActor("it_manager");
  const client = createClient(DEMO_SUPABASE_URL, DEMO_SUPABASE_ANON_KEY, {
    global: { fetch: createDemoTransport(store) },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const childPage = (from: number, to: number) => client.from("request_items")
    .select(reportChildProjection, { count: "exact" })
    .not("request.portal_approval_status", "in", "(pending_project_manager,rejected_by_project_manager)")
    .order("id").range(from, to).overrideTypes<ReportChild[], { merge: false }>();
  return { store, client, childPage };
}

describe("exact requests report parent FK join", () => {
  it("returns parent objects and complete item counts through source range/parent-filter reads", async () => {
    const { client, childPage } = await setup();
    const parents = await client.from("requests").select("id")
      .not("portal_approval_status", "in", "(pending_project_manager,rejected_by_project_manager)");
    expect(parents.error).toBeNull();
    expect(parents.data).toHaveLength(23);
    const first = await childPage(0, 4), rest = await childPage(5, 999);
    expect(first.error).toBeNull();
    expect(rest.error).toBeNull();
    expect(first.count).toBe(46);
    expect(rest.count).toBe(46);
    expect(first.data).toHaveLength(5);
    expect(rest.data).toHaveLength(41);
    const children = [...first.data!, ...rest.data!];
    expect(new Set(children.map(item => item.id)).size).toBe(46);
    const parentIds = new Set(parents.data!.map(parent => parent.id));
    const counts = new Map<string, number>();
    for (const item of children) {
      expect(item.request).toEqual({ id: item.request_id });
      expect(parentIds.has(item.request.id)).toBe(true);
      expect(Object.keys(item).sort()).toEqual(["id", "request", "request_id"]);
      counts.set(item.request_id, (counts.get(item.request_id) ?? 0) + 1);
    }
    expect(counts.size).toBe(23);
    expect([...counts.values()].every(count => count === 2)).toBe(true);
    expect(counts.has(demoId(16,13))).toBe(false);
  });

  it("preserves reverse arrays and excludes missing inner parents before exact count and range", async () => {
    const { store, client, childPage } = await setup();
    const reverse = await client.from("requests").select("id,request_items(id,request_id)")
      .eq("id", demoId(16,5)).single()
      .overrideTypes<{ id: string; request_items: { id: string; request_id: string }[] }, { merge: false }>();
    expect(reverse.error).toBeNull();
    expect(reverse.data).toEqual({ id: demoId(16,5), request_items: [
      { id: demoId(17,9), request_id: demoId(16,5) }, { id: demoId(17,10), request_id: demoId(16,5) },
    ] });
    const baselineFirst = await childPage(0, 0);
    expect(baselineFirst.error).toBeNull();
    expect(baselineFirst.data).toHaveLength(1);
    // A broken local reference must behave as an absent joined parent, rather
    // than enter the report's exact-count pagination as an empty array.
    await store.transact(store.capture(), state => {
      state.tables.request_items.unshift({ ...state.tables.request_items[0], id: demoId(17,0), request_id: demoId(16,999) });
    });
    const first = await childPage(0, 0), full = await childPage(0, 999);
    expect(first.error).toBeNull();
    expect(first.count).toBe(46);
    expect(first.data).toEqual(baselineFirst.data);
    expect(first.data?.[0].id).not.toBe(demoId(17,0));
    expect(full.error).toBeNull();
    expect(full.count).toBe(46);
    expect(full.data).toHaveLength(46);
    const outer = await client.from("request_items").select("id,request:request_id(id)")
      .eq("id", demoId(17,0)).single();
    expect(outer.error).toBeNull();
    expect(outer.data).toEqual({ id: demoId(17,0), request: null });
  });

  it("keeps employee parent/child ownership and financial guards on the joined projection", async () => {
    const { store, client, childPage } = await setup();
    const financial = await client.from("request_items").select("id,unit_price,total_price,request:requests!request_items_request_id_fkey!inner(id)")
      .eq("id", demoId(17,1)).single();
    expect(financial.error).toBeNull();
    expect(financial.data).toEqual({ id: demoId(17,1), unit_price: 125, total_price: 250, request: { id: demoId(16,1) } });
    await store.setActor("employee");
    const own = await childPage(0, 999);
    expect(own.error).toBeNull();
    expect(own.count).toBe(12);
    expect(own.data).toHaveLength(12);
    expect(new Set(own.data!.map(item => item.request.id))).toEqual(new Set(Array.from({ length: 6 }, (_, i) => demoId(16,i+1))));
    const foreign = await client.from("request_items").select(reportChildProjection, { count: "exact" }).eq("request_id", demoId(16,14));
    expect(foreign.error).toBeNull();
    expect(foreign.count).toBe(0);
    expect(foreign.data).toEqual([]);
    for (const persona of ["employee", "viewer", "auditor", "warehouse_manager", "technician"]) {
      await store.setActor(persona);
      const denied = await client.from("request_items").select("id,unit_price,request:requests!request_items_request_id_fkey!inner(id)").eq("id", demoId(17,1));
      expect(denied.error?.code, persona).toBe("42501");
      expect(denied.data).toBeNull();
      const masked = await client.rpc("request_items_financial", { p_request_ids: [demoId(16,1)] });
      expect(masked.error, persona).toBeNull();
      expect(masked.data, persona).toEqual([]);
    }
    await store.setActor("portal_requester");
    const portal = await childPage(0, 999);
    expect(portal.error?.code).toBe("42501");
    expect(portal.data).toBeNull();
  });
});
