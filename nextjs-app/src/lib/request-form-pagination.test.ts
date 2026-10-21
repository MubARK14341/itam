import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  rows: {} as Record<string, { id: string; name: string }[]>,
  failAssetsFrom: null as number | null,
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      let from = 0, to = 999;
      const query = {
        select: () => query, eq: () => query, is: () => query, order: () => query,
        range: (start: number, end: number) => { from = start; to = end; return query; },
        then: (resolve: (result: { data: { id: string; name: string }[] | null; error: { message: string } | null }) => unknown) =>
          Promise.resolve(fixture.failAssetsFrom !== null && table === "assets" && from >= fixture.failAssetsFrom
            ? { data: null, error: { message: "TEST later-page access failure" } }
            : { data: (fixture.rows[table] ?? []).slice(from, Math.min(to + 1, from + 1000)), error: null }).then(resolve),
      };
      return query;
    },
  }),
}));
import { getRequestFormData } from "./requests";

describe("request form data across the REST row limit", () => {
  beforeEach(() => {
    fixture.failAssetsFrom = null;
    fixture.rows = {
      assets: Array.from({ length: 5000 }, (_, index) => ({ id: String(index), name: `TEST asset ${index}` })),
      customers: [{ id: "customer", name: "TEST customer" }],
    };
  });
  it("keeps the last device available to request pickers beyond the first1000", async () => {
    const result = await getRequestFormData();
    expect(result.error).toBeNull();
    expect(result.assets).toHaveLength(5000);
    expect(new Set(result.assets.map(asset => asset.id)).size).toBe(5000);
    expect(result.assets.at(-1)).toMatchObject({ id: "4999", name: "TEST asset 4999" });
    expect(result.customers).toEqual(fixture.rows.customers);
  });
  it("returns the later-page error without exposing a misleading partial asset list", async () => {
    fixture.failAssetsFrom = 1000;
    const result = await getRequestFormData();
    expect(result.error).toBe("TEST later-page access failure");
    expect(result.assets).toEqual([]);
    expect(result.customers).toEqual(fixture.rows.customers);
  });
});
