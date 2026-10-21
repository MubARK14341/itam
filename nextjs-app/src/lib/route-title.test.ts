import { describe, expect, it } from "vitest";
import { ar } from "./translations/ar";
import { en } from "./translations/en";
import { routeDocumentTitle } from "./route-title";

describe("routeDocumentTitle", () => {
  it("names primary routes in the active language", () => {
    expect(routeDocumentTitle("/assets", en)).toBe("Assets · IT Asset Management");
    expect(routeDocumentTitle("/reports", ar)).toBe("التقارير · نظام إدارة الأصول التقنية");
  });

  it("uses stable titles for dynamic detail routes", () => {
    expect(routeDocumentTitle("/assets/asset-id", en)).toBe("Asset data · IT Asset Management");
    expect(routeDocumentTitle("/client-portal/requests/request-id", ar)).toContain("تفاصيل الطلب");
  });

  it("falls back to the product title for unknown routes", () => {
    expect(routeDocumentTitle("/unknown", en)).toBe(en.app.title);
  });
});
