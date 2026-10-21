import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppPreferencesProvider } from "@/components/providers/app-preferences-provider";
import { getDict, interpolate, type Lang } from "@/lib/i18n";
import { EquipmentPhoto } from "./equipment-photo";
import { UnifiedInventoryTable, type UnifiedRow } from "./unified-inventory-table";

// Render the production components and installed Next Link/Image in the repo's
// existing Node React-server test environment. Media state is the only layout
// input replaced; handler wrappers below still render the original controls.
const observation = vi.hoisted(() => ({
  desktop: true,
  useRealMedia: false,
  mediaQueries: [] as string[],
  templateReads: 0,
  checkboxes: [] as {
    label: string; checked: boolean; indeterminate?: boolean;
    disabled?: boolean; onChange: () => void;
  }[],
  buttons: [] as { label: string | undefined; activate: (() => void) | undefined }[],
  signAttachment: vi.fn(),
}));

vi.mock("@/components/action-center/use-media-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/action-center/use-media-query")>();
  return {
    ...actual,
    useMediaQuery: (query: string) => {
      observation.mediaQueries.push(query);
      return observation.useRealMedia ? actual.useMediaQuery(query) : observation.desktop;
    },
  };
});
vi.mock("@/lib/asset-type-templates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/asset-type-templates")>();
  return {
    ...actual,
    getAssetTemplate: (...args: Parameters<typeof actual.getAssetTemplate>) => {
      observation.templateReads += 1;
      return actual.getAssetTemplate(...args);
    },
  };
});
vi.mock("@/lib/queries", () => ({ getAttachmentUrl: observation.signAttachment }));
vi.mock("./inventory-selection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inventory-selection")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    SelectCheckbox: (props: ComponentProps<typeof actual.SelectCheckbox>) => {
      observation.checkboxes.push(props);
      return createElement(actual.SelectCheckbox, props);
    },
  };
});
vi.mock("@/components/ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/button")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    Button: (props: ComponentProps<typeof actual.Button>) => {
      const callback = props.onClick;
      observation.buttons.push({
        label: props["aria-label"],
        // The table's actual quick-view closure takes no event. This invokes that
        // binding only; static rendering does not claim to test DOM dispatch.
        activate: callback ? () => { Reflect.apply(callback, undefined, []); } : undefined,
      });
      return createElement(actual.Button, props);
    },
  };
});

type TableProps = ComponentProps<typeof UnifiedInventoryTable>;
function assetRow(index: number): UnifiedRow {
  return {
    key: `a:TEST-${index}`, id: `TEST-${index}`, type: "asset",
    code: `TEST-${String(index).padStart(4, "0")}`, name: `TEST device ${index}`,
    categoryLabel: "TEST printers", location: "TEST office", company: "TEST company",
    holderOrQty: "TEST holder", href: `/assets/TEST-${index}`, assetStatus: "reserved",
    category_id: "TEST-category", location_id: "TEST-location", company_id: "TEST-company",
    searchHay: `test device ${index}`,
    equipment: {
      name: "TEST Epson device", category: { name: "Printer", name_ar: "طابعة" },
      special_attributes: { section: "Printers", printerType: "card", printCounter: 0 },
    },
  };
}
function consumableRow(index: number): UnifiedRow {
  return {
    key: `c:TEST-${index}`, id: `TEST-${index}`, type: "consumable",
    code: `TEST-C-${index}`, name: `TEST consumable ${index}`, categoryLabel: "TEST supplies",
    location: "TEST office", company: "TEST company", holderOrQty: "0 TEST units",
    href: `/consumables/TEST-${index}`, stock: "out", category_id: "TEST-supplies",
    location_id: "TEST-location", company_id: "TEST-company", searchHay: `test supplies ${index}`,
  };
}
function props(rows: UnifiedRow[], overrides: Partial<TableProps> = {}): TableProps {
  return {
    rows, loading: false, returnTo: "/assets?q=TEST&status=reserved&type=assets",
    selected: new Set<string>(), onToggle: vi.fn(), onToggleAll: vi.fn(),
    onQuickView: vi.fn(), ...overrides,
  };
}
function renderTable(properties: TableProps, lang: Lang = "en"): string {
  return renderToStaticMarkup(
    <AppPreferencesProvider initialLang={lang} initialTheme="light">
      <UnifiedInventoryTable {...properties} />
    </AppPreferencesProvider>,
  );
}
function images(html: string): number { return (html.match(/<img\b/g) ?? []).length; }
function anchors(html: string): number { return (html.match(/<a\b/g) ?? []).length; }
function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function resetObservations(): void {
  observation.mediaQueries.length = 0;
  observation.templateReads = 0;
  observation.checkboxes.length = 0;
  observation.buttons.length = 0;
}
beforeEach(() => {
  resetObservations(); observation.desktop = true; observation.useRealMedia = false;
  observation.signAttachment.mockReset();
});

describe("equipment photo's single template resolution", () => {
  it.each([
    { subtype: "card", file: "card-printer.png" },
    { subtype: "paper", file: "paper-printer.png" },
    { subtype: "label", file: "label-printer.png" },
    { subtype: "thermal", file: "receipt-printer.png" },
  ])("keeps the actual $subtype illustration with one classification", ({ subtype, file }) => {
    const html = renderToStaticMarkup(createElement(EquipmentPhoto, {
      asset: { name: "TEST Epson device", category: { name: "Printer" }, special_attributes: { printerType: subtype } },
    }));
    expect(observation.templateReads).toBe(1);
    expect(images(html)).toBe(1);
    expect(html).toContain(encodeURIComponent(`/studio-equipment/${file}`));
    expect(observation.signAttachment).not.toHaveBeenCalled();
  });
  it("preserves an explicit template override without consulting asset classification", () => {
    const html = renderToStaticMarkup(createElement(EquipmentPhoto, {
      asset: { name: "TEST printer", category: { name: "Printer" }, special_attributes: { printerType: "card" } },
      templateId: "laptop",
    }));
    expect(observation.templateReads).toBe(0);
    expect(images(html)).toBe(1);
    expect(html).toContain(encodeURIComponent("/studio-equipment/laptop.png"));
  });
  it.each([false, 0] as const)("retains historical opaque %s SIM fallback with one classification", (attributes) => {
    const html = renderToStaticMarkup(createElement(EquipmentPhoto, {
      asset: { name: "TEST opaque", category: { name: "Other" }, special_attributes: attributes },
    }));
    expect(observation.templateReads).toBe(1);
    expect(images(html)).toBe(0);
    expect(html).toContain("lucide-contact-round");
    expect(observation.signAttachment).not.toHaveBeenCalled();
  });
});

describe("unified inventory ready-row rendering", () => {
  it.each([
    { desktop: true, lang: "en" }, { desktop: true, lang: "ar" },
    { desktop: false, lang: "en" }, { desktop: false, lang: "ar" },
  ] as const)("renders 200 actual photos once for desktop=$desktop/$lang", ({ desktop, lang }) => {
    observation.desktop = desktop;
    const rows = Array.from({ length: 200 }, (_, index) => assetRow(index));
    const html = renderTable(props(rows), lang);
    expect(images(html)).toBe(200);
    expect(anchors(html)).toBe(200);
    expect(observation.templateReads).toBe(200);
    expect(observation.mediaQueries).toEqual(["(min-width: 768px)"]);
    expect(html).toContain('class="divide-y divide-line md:hidden"');
    expect(html).toContain('class="hidden overflow-x-auto md:block"');
    expect(html).toContain('tabindex="0"');
    expect(observation.checkboxes).toHaveLength(desktop ? 201 : 1);
    expect(observation.buttons).toHaveLength(desktop ? 200 : 0);
    const dict = getDict(lang);
    expect(html).toContain(escapeHtml(desktop ? dict.assets.headers.tagOrCode : dict.assets.badges.asset));
    expect(observation.signAttachment).not.toHaveBeenCalled();
  });
  it("keeps a mixed 100-asset/100-consumable page complete with override-based consumable icons", () => {
    const rows = [
      ...Array.from({ length: 100 }, (_, index) => assetRow(index)),
      ...Array.from({ length: 100 }, (_, index) => consumableRow(index)),
    ];
    const html = renderTable(props(rows));
    expect(observation.templateReads).toBe(100);
    expect(images(html)).toBe(100);
    expect(anchors(html)).toBe(200);
    expect(observation.checkboxes).toHaveLength(201);
    expect(html).toContain("TEST consumable 99");
    expect(html).toContain("0 TEST units");
    expect(html).toContain("lucide-package");
  });
  it("preserves desktop selection, return links and actual row/action callback bindings", () => {
    const rows = [assetRow(1), consumableRow(2)], selected = new Set([rows[0].key]);
    const onToggle = vi.fn(), onToggleAll = vi.fn(), onQuickView = vi.fn();
    const properties = props(rows, { selected, onToggle, onToggleAll, onQuickView });
    const html = renderTable(properties);
    expect((html.match(/aria-selected="true"/g) ?? [])).toHaveLength(1);
    expect(observation.checkboxes.map(value => value.checked)).toEqual([false, true, false]);
    expect(observation.checkboxes[0].indeterminate).toBe(true);
    expect(observation.checkboxes[0].disabled).toBe(false);
    expect(observation.checkboxes[1].label).toBe(interpolate(getDict("en").assets.listUx.selectRow, { tag: rows[0].code }));
    observation.checkboxes[0].onChange(); observation.checkboxes[1].onChange();
    expect(onToggleAll).toHaveBeenCalledOnce(); expect(onToggle).toHaveBeenCalledExactlyOnceWith(rows[0].key);
    expect(observation.buttons[0].label).toBe(interpolate(getDict("en").assets.listUx.quickView, { name: rows[0].name }));
    observation.buttons[0].activate?.(); expect(onQuickView).toHaveBeenCalledExactlyOnceWith(rows[0]);
    for (const row of rows) expect(html).toContain(`href="${row.href}?returnTo=${encodeURIComponent(properties.returnTo)}"`);
    expect([...selected]).toEqual([rows[0].key]);
  });
  it("retains mobile row links/content while the desktop's ready rows and quick-view controls are absent", () => {
    observation.desktop = false;
    const rows = [assetRow(1), consumableRow(2)], properties = props(rows);
    const html = renderTable(properties, "ar");
    for (const row of rows) {
      expect(html).toContain(`href="${row.href}?returnTo=${encodeURIComponent(properties.returnTo)}"`);
      expect(html).toContain(row.name); expect(html).toContain(row.holderOrQty);
    }
    expect(html).toContain(escapeHtml(getDict("ar").common.view));
    expect(html).toContain("TEST printers · TEST office");
    expect(observation.buttons).toHaveLength(0); expect(observation.checkboxes).toHaveLength(1);
    expect(html).not.toContain("aria-selected=");
  });
  it("leaves parent-owned selection unchanged across static mobile/desktop re-renders", () => {
    const rows = [assetRow(1), assetRow(2)], selected = new Set([rows[1].key]);
    const properties = props(rows, { selected });
    renderTable(properties);
    observation.desktop = false; resetObservations(); renderTable(properties);
    expect(observation.checkboxes).toHaveLength(1); expect([...selected]).toEqual([rows[1].key]);
    observation.desktop = true; resetObservations(); const desktop = renderTable(properties);
    expect(observation.checkboxes.map(value => value.checked)).toEqual([false, false, true]);
    expect((desktop.match(/aria-selected="true"/g) ?? [])).toHaveLength(1);
    expect([...selected]).toEqual([rows[1].key]);
  });
  it.each(["en", "ar"] as const)("preserves both loading placeholders/$lang without rendering ready rows", (lang) => {
    const html = renderTable(props([assetRow(1)], { loading: true }), lang);
    expect(images(html)).toBe(0); expect(anchors(html)).toBe(0); expect(observation.templateReads).toBe(0);
    expect((html.match(/animate-pulse/g) ?? [])).toHaveLength(14);
    expect(html).toContain('colSpan="10"');
    expect(observation.checkboxes).toHaveLength(1); expect(observation.checkboxes[0].disabled).toBe(true);
    expect(observation.buttons).toHaveLength(0);
  });
  it.each(["en", "ar"] as const)("preserves both empty states and clear-filter callbacks/$lang", (lang) => {
    const onClearFilters = vi.fn(), html = renderTable(props([], { onClearFilters }), lang);
    expect(images(html)).toBe(0); expect(anchors(html)).toBe(0); expect(observation.templateReads).toBe(0);
    expect(html.split(escapeHtml(getDict(lang).assets.emptyFiltered)).length - 1).toBe(2);
    expect(observation.checkboxes).toHaveLength(1); expect(observation.checkboxes[0].disabled).toBe(true);
    expect(observation.buttons).toHaveLength(2); observation.buttons[0].activate?.();
    expect(onClearFilters).toHaveBeenCalledOnce();
  });
  it("uses the existing real media hook's SSR snapshot without needing window or drawing both ready trees", () => {
    observation.useRealMedia = true;
    const html = renderTable(props([assetRow(1), assetRow(2)]));
    expect(images(html)).toBe(2); expect(anchors(html)).toBe(2); expect(observation.templateReads).toBe(2);
    expect(observation.checkboxes).toHaveLength(1); expect(observation.buttons).toHaveLength(0);
    expect(observation.mediaQueries).toEqual(["(min-width: 768px)"]);
  });
});
