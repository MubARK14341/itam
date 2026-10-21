import { describe, expect, it } from "vitest";
import {
  buildRequestQueuePath,
  requestDetailNavigation,
  requestQueueStateFromSearch,
  safeRequestReturnTo,
  withRequestQueueContext,
} from "./request-navigation";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("request operational navigation", () => {
  it("round-trips validated queue filters and drops invalid values", () => {
    const parsed = requestQueueStateFromSearch(`?view=warehouse&q=REQ-1&source=portal&status=preparing&customer=${A}&responsible=bad&overdue=1`);
    expect(parsed).toMatchObject({ view: "warehouse", q: "REQ-1", source: "portal", status: "preparing", customer: A, responsible: "", overdueOnly: true });
    expect(buildRequestQueuePath(parsed, A)).toBe(`/requests?q=REQ-1&status=preparing&source=portal&customer=${A}&overdue=1&view=warehouse#request-${A}`);
  });

  it("accepts only canonical internal request-list return URLs", () => {
    expect(safeRequestReturnTo("https://evil.example/requests?view=warehouse")).toBe("/requests");
    expect(safeRequestReturnTo("//evil.example/requests")).toBe("/requests");
    expect(safeRequestReturnTo("/requests?view=warehouse&unknown=1")).toBe("/requests?view=warehouse");
    expect(safeRequestReturnTo("/assets?q=REQ")).toBe("/requests");
  });

  it("keeps a bounded validated queue and advances without automatic mutation", () => {
    const href = withRequestQueueContext(A, `/requests?q=REQ&view=warehouse#request-${A}`, [A, B, C, "bad"]);
    const search = href.slice(href.indexOf("?"));
    const nav = requestDetailNavigation(search, A);
    expect(nav.returnTo).toBe(`/requests?q=REQ&view=warehouse#request-${A}`);
    expect(nav.nextId).toBe(B);
    expect(nav.nextHref).toContain(`/requests/${B}?`);
    expect(nav.nextHref).toContain(encodeURIComponent(`#request-${B}`));
  });
});
