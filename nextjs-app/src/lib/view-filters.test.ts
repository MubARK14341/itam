import { describe, expect, it } from "vitest";
import { encodePrivateViews, filterParams, parseReportView, reportViewValues, parsePortalView, portalViewValues, privateViewStorageKey, readPrivateViews } from "./view-filters";

const id = "10000000-0000-4000-8000-000000000001";
const normalizeReports = (values: Record<string, string>) => reportViewValues(parseReportView(filterParams(values), ["inventory", "custody"]));
const normalizePortal = (values: Record<string, string>) => portalViewValues(parsePortalView(filterParams(values)));

describe("report and portal filter URL contracts", () => {
  it("round trips report tab, identifiers, range and child toggles without carrying extra URL data", () => {
    const values = { tab: "inventory", category: id, status: "available", from: "2026-01-01", to: "2026-06-01", kind: "asset", source: "employee", low: "1", purchase_cost: "500", unrelated: "secret" };
    const parsed = parseReportView(filterParams(values));
    expect(parseReportView(filterParams(reportViewValues(parsed)))).toEqual(parsed);
    expect(reportViewValues(parsed)).not.toHaveProperty("purchase_cost");
    expect(reportViewValues(parsed)).not.toHaveProperty("unrelated");
    expect(parsed).toMatchObject({ tab: "inventory", category: id, kind: "asset", source: "employee", low: "1" });
  });
  it("revalidates an unavailable report tab and drops invalid IDs, statuses and calendar dates", () => {
    expect(parseReportView(new URLSearchParams("tab=executive&category=not-an-id&status=sold&from=2026-02-30&to=bad&kind=invalid"), ["custody"])).toMatchObject({ tab: "custody", category: "", status: "", from: "", to: "", kind: "all" });
    expect(parseReportView(new URLSearchParams("from=2026-07-02&to=2026-07-01"))).toMatchObject({ from: "2026-07-02", to: "2026-07-01" });
  });
  it("round trips all portal filters and allows only dashboard buckets and display statuses", () => {
    const state = parsePortalView(new URLSearchParams("q=Project+Alpha&bucket=pending_pm&status=pending_pm&from=2026-01-01&to=2026-02-01&view=open"));
    expect(parsePortalView(filterParams(portalViewValues(state)))).toEqual(state);
    expect(state).toMatchObject({ q: "Project Alpha", bucket: "pending_pm", status: "pending_pm", view: "open" });
    expect(parsePortalView(new URLSearchParams("bucket=arbitrary&status=ready_for_pickup&view=unknown"))).toMatchObject({ bucket: "", status: "", view: "all" });
  });
});

describe("private named views", () => {
  it("scopes storage separately by actor and surface and refuses an anonymous scope", () => {
    expect(privateViewStorageKey(null, "reports")).toBeNull();
    expect(new Set([privateViewStorageKey("alice", "reports"), privateViewStorageKey("bob", "reports"), privateViewStorageKey("alice", "portal-requests")]).size).toBe(3);
  });
  it("persists filters only and revalidates role visibility on restoration", () => {
    const encoded = encodePrivateViews([{ id, name: " My view ", filters: { tab: "executive", category: id, purchase_cost: "500", rows: "private" } }], normalizeReports);
    expect(encoded).not.toMatch(/purchase_cost|private|rows/);
    expect(readPrivateViews(encoded, normalizeReports)).toEqual([{ id, name: "My view", filters: normalizeReports({ tab: "executive", category: id }) }]);
    expect(readPrivateViews(encoded, normalizeReports)[0].filters.tab).toBe("inventory");
  });
  it("handles corrupt or foreign versions and rejects malformed view records without throwing", () => {
    expect(readPrivateViews("{", normalizePortal)).toEqual([]);
    expect(readPrivateViews('{"version":2,"views":[]}', normalizePortal)).toEqual([]);
    expect(readPrivateViews(JSON.stringify({ version: 1, views: [{ id: "not-id", name: "Bad", filters: {} }, { id, name: "Bad", filters: [] }] }), normalizePortal)).toEqual([]);
  });
  it("normalizes tampered stored filters and removes duplicate records", () => {
    const encoded = JSON.stringify({ version: 1, views: [{ id, name: "Portal", filters: { q: "x".repeat(300), view: "open", bucket: "closed", financial: "true", tab: "executive" } }, { id, name: "Duplicate", filters: {} }] });
    const views = readPrivateViews(encoded, normalizePortal);
    expect(views).toHaveLength(1);
    expect(views[0].filters.q).toHaveLength(200);
    expect(views[0].filters).toMatchObject({ view: "open", bucket: "" });
    expect(views[0].filters).not.toHaveProperty("financial");
    expect(views[0].filters).not.toHaveProperty("tab");
  });
});
