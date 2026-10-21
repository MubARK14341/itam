import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = resolve(__dirname, "..");
const source = (relativePath: string) => readFileSync(resolve(appRoot, relativePath), "utf8");

describe("shared bilingual accessibility contract", () => {
  it("localizes dialog close controls and exposes toast announcements", () => {
    const dialog = source("components/ui/dialog.tsx");
    const toast = source("components/ui/toast.tsx");

    expect(dialog).toContain("closeLabel ?? t.common.close");
    expect(dialog).not.toContain('closeLabel = "Close dialog"');
    expect(dialog).toContain("createPortal(");
    expect(dialog).toContain("document.body");
    expect(toast).toContain('role={ok ? "status" : "alert"}');
    expect(toast).toContain('aria-live={ok ? "polite" : "assertive"}');
    expect(toast).toContain('aria-atomic="true"');
  });

  it("keeps shared search controls labeled and direction-aware", () => {
    const form = source("components/ui/form.tsx");
    const consumers = [
      "components/settings/suppliers-settings.tsx",
      "components/settings/companies-settings.tsx",
      "app/(app)/maintenance/page-client.tsx",
      "app/(app)/activity/page-client.tsx",
    ].map(source).join("\n");

    expect(form).toContain('type="search"');
    expect(form).toContain("aria-label={label}");
    expect(form).toContain("absolute start-3");
    expect(form).toContain("ps-9");
    expect(form).toContain('onClear ? "pe-11" : "pe-3"');
    expect(consumers.match(/<SearchInput/g)).toHaveLength(4);
    expect(consumers).not.toMatch(/\b(right-3|pr-9|pl-3)\b/);
  });

  it("announces route and portal loading states in the active language", () => {
    const appLoading = source("app/(app)/loading.tsx");
    const portalLayout = source("app/(portal)/client-portal/layout.tsx");

    expect(appLoading).toContain("{t.common.loading}");
    expect(portalLayout).toContain('role="status"');
    expect(portalLayout).toContain("{t.common.loading}");
    expect(portalLayout).toContain('theme === "dark" ? t.prefs.light : t.prefs.dark');
  });

  it("keeps stocktake next-review navigation independent of active filters", () => {
    const stocktakes = source("app/(app)/stocktakes/page.tsx");

    expect(stocktakes).toContain("const next = varianceItems.find((item) => !item.review_decision)");
    expect(stocktakes).toContain('setVarianceType("all")');
    expect(stocktakes).toContain('setResolutionFilter("unresolved")');
    expect(stocktakes).toContain("window.requestAnimationFrame");
  });
});
