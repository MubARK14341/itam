import { describe, it, expect } from "vitest";
import {
  groupAssetOptions, assetModelLabel, assetMatchesNeed, assetBrandFacet, brandOptionsForCategory,
  mergeRequestDraftLine, requestHasItems, validateRequestQuantity, type GroupableAsset,
} from "./request-options";

const asset = (over: Partial<GroupableAsset>): GroupableAsset => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  name: null,
  status: "available",
  category_id: "cat-cam",
  company_id: "co-logi",
  model_id: "m-brio",
  category: { name: "Camera", name_ar: "كاميرا" },
  company: { name: "Logitech" },
  model: { brand: "Logitech", model_name: "BRIO 500" },
  ...over,
});

describe("groupAssetOptions", () => {
  it("يجمع الأجهزة المتطابقة في خيار واحد (الموديل يظهر مرة واحدة)", () => {
    const rows = [asset({ id: "1" }), asset({ id: "2" }), asset({ id: "3", status: "rented" })];
    const out = groupAssetOptions(rows);
    expect(out).toHaveLength(1);
    expect(out[0].modelLabel).toBe("Logitech BRIO 500");
    expect(out[0].total_count).toBe(3);
    expect(out[0].available_count).toBe(2);
  });

  it("يفصل حسب التصنيف/الشركة/الموديل", () => {
    const rows = [
      asset({ id: "1" }),
      asset({ id: "2", category_id: "cat-mon", category: { name: "Monitor", name_ar: "شاشة" }, company_id: "co-dell", company: { name: "Dell" }, model: { brand: "Dell", model_name: "24 inch" } }),
      asset({ id: "3", model: { brand: "Logitech", model_name: "C920" } }),
    ];
    const out = groupAssetOptions(rows);
    expect(out).toHaveLength(3);
  });

  it("أصل بلا موديل/شركة يستخدم اسمه الحر ولا يُدمج مع موديل معرّف", () => {
    const rows = [
      asset({ id: "1" }),
      asset({ id: "2", model_id: null, model: null, company_id: null, company: null, name: "طابعة قديمة" }),
    ];
    const out = groupAssetOptions(rows);
    expect(out).toHaveLength(2);
    const free = out.find((g) => g.modelLabel === "طابعة قديمة")!;
    expect(free.companyId).toBeNull();
    expect(free.available_count).toBe(1);
  });

  it("يعدّ المتاح فقط لحالة available (reserved/assigned لا تُحسب)", () => {
    const rows = [asset({ id: "1", status: "reserved" }), asset({ id: "2", status: "assigned" })];
    const out = groupAssetOptions(rows);
    expect(out[0].available_count).toBe(0);
    expect(out[0].total_count).toBe(2);
  });
});

describe("assetModelLabel", () => {
  it("يفضّل brand+model_name ثم اسم الأصل ثم شرطة", () => {
    expect(assetModelLabel({ name: "x", model: { brand: "HP", model_name: "LaserJet" } })).toBe("HP LaserJet");
    expect(assetModelLabel({ name: "جهاز مخصص", model: null })).toBe("جهاز مخصص");
    expect(assetModelLabel({ name: null, model: null })).toBe("—");
  });
});

describe("assetMatchesNeed", () => {
  const a = asset({ id: "1" });
  it("يطابق عند تطابق التصنيف والشركة والموديل", () => {
    expect(assetMatchesNeed(a, { requested_category: "كاميرا", preferred_company_id: "co-logi", preferred_model: "Logitech BRIO 500" })).toBe(true);
  });
  it("يرفض عند اختلاف التصنيف أو الشركة", () => {
    expect(assetMatchesNeed(a, { requested_category: "شاشة", preferred_company_id: null, preferred_model: null })).toBe(false);
    expect(assetMatchesNeed(a, { requested_category: "كاميرا", preferred_company_id: "co-dell", preferred_model: null })).toBe(false);
  });
  it("الحقول الفارغة لا تُقيّد (null = أي قيمة)", () => {
    expect(assetMatchesNeed(a, { requested_category: null, preferred_company_id: null, preferred_model: null })).toBe(true);
  });
});

// أصل بلا FK/موديل معرّف — الماركة تُشتقّ من الاسم الحر
const nameOnly = (name: string, over: Partial<GroupableAsset> = {}): GroupableAsset =>
  asset({ company_id: null, company: null, model_id: null, model: null, name, ...over });

describe("assetBrandFacet", () => {
  it("يفضّل FK companies إن وُجد", () => {
    const f = assetBrandFacet(asset({ company_id: "co-logi", company: { name: "Logitech" } }));
    expect(f).toEqual({ key: "id:co-logi", label: "Logitech", companyId: "co-logi" });
  });

  it("يستخدم model.brand إن غاب FK", () => {
    const f = assetBrandFacet(asset({ company_id: null, company: null, model: { brand: "HP", model_name: "X" } }));
    expect(f).toEqual({ key: "b:hp", label: "HP", companyId: null });
  });

  it("يشتقّ الماركة من الاسم الحر بصيغه المتعددة", () => {
    expect(assetBrandFacet(nameOnly("laptop -hp-(15-bs151nx)")).label).toBe("HP");
    expect(assetBrandFacet(nameOnly("Laptop (Lenovo)")).label).toBe("Lenovo");
    expect(assetBrandFacet(nameOnly("laptop acer(N16Q6)")).label).toBe("Acer");
    expect(assetBrandFacet(nameOnly("Laptop Asus(X515E)")).label).toBe("ASUS");
    expect(assetBrandFacet(nameOnly("LAPTOP DELL(Latitude 5480)")).label).toBe("Dell");
    expect(assetBrandFacet(nameOnly("Mac Book Air")).label).toBe("Apple");
  });

  it("اسم بلا ماركة معروفة ⇒ غير محدد (label=null, key=unspec)", () => {
    const f = assetBrandFacet(nameOnly("laptop 12345"));
    expect(f).toEqual({ key: "unspec", label: null, companyId: null });
  });

  it("لا مطابقة زائفة داخل كلمة (حدود الرمز)", () => {
    // «acer» مضمّنة في «spacer» لكن بلا حدود كلمة ⇒ لا تُطابَق
    expect(assetBrandFacet(nameOnly("desk spacer unit")).key).toBe("unspec");
    // «hp» ليست كلمة مستقلة في «champion»
    expect(assetBrandFacet(nameOnly("champion device")).key).toBe("unspec");
  });
});

describe("groupAssetOptions — تجميع بالماركة المشتقّة من الاسم", () => {
  it("يفصل ماركتين مختلفتين من نفس التصنيف (company_id فارغ)", () => {
    const rows = [
      nameOnly("laptop -hp-(15)", { id: "1", category_id: "cat-lap", category: { name: "Laptop", name_ar: "لابتوب" } }),
      nameOnly("Laptop (Lenovo)", { id: "2", category_id: "cat-lap", category: { name: "Laptop", name_ar: "لابتوب" } }),
    ];
    const out = groupAssetOptions(rows);
    expect(out).toHaveLength(2);
    expect(out.map((g) => g.companyLabel).sort()).toEqual(["HP", "Lenovo"]);
  });

  it("يدمج نفس الاسم/الماركة ويعدّ المتاح", () => {
    const rows = [
      nameOnly("Laptop Asus(X515E)", { id: "1", category_id: "cat-lap", category: { name: "Laptop", name_ar: "لابتوب" } }),
      nameOnly("Laptop Asus(X515E)", { id: "2", category_id: "cat-lap", category: { name: "Laptop", name_ar: "لابتوب" }, status: "rented" }),
    ];
    const out = groupAssetOptions(rows);
    expect(out).toHaveLength(1);
    expect(out[0].companyLabel).toBe("ASUS");
    expect(out[0].total_count).toBe(2);
    expect(out[0].available_count).toBe(1);
  });
});

describe("brandOptionsForCategory", () => {
  const rows = [
    nameOnly("laptop -hp-(15)", { id: "1", category_id: "cat-lap", category: { name: "Laptop", name_ar: "لابتوب" } }),
    nameOnly("Laptop (Lenovo)", { id: "2", category_id: "cat-lap", category: { name: "Laptop", name_ar: "لابتوب" } }),
    nameOnly("laptop 999", { id: "3", category_id: "cat-lap", category: { name: "Laptop", name_ar: "لابتوب" } }),
    nameOnly("Printer HP", { id: "4", category_id: "cat-prn", category: { name: "Printer", name_ar: "طابعة" } }),
  ];
  const groups = groupAssetOptions(rows);

  it("يُرجع ماركات التصنيف المختار فقط، «غير محدد» أخيرًا", () => {
    const opts = brandOptionsForCategory(groups, "cat-lap");
    expect(opts.map((o) => o.label)).toEqual(["HP", "Lenovo", null]);
  });

  it("لا يخلط ماركات تصنيف آخر", () => {
    const opts = brandOptionsForCategory(groups, "cat-prn");
    expect(opts.map((o) => o.label)).toEqual(["HP"]);
  });
});

describe("request quantity limits", () => {
  it("rejects an empty request draft", () => {
    expect(requestHasItems([])).toBe(false);
    expect(requestHasItems([{ key: "item-1" }])).toBe(true);
  });

  it("accepts quantities from one through the current available count", () => {
    expect(validateRequestQuantity("1", 0, 1)).toMatchObject({ quantity: 1, total: 1, error: null });
    expect(validateRequestQuantity(3, 0, 3)).toMatchObject({ total: 3, error: null });
  });

  it("rejects empty, fractional, zero, unavailable, and over-limit quantities", () => {
    expect(validateRequestQuantity("", 0, 3).error).toBe("invalid");
    expect(validateRequestQuantity(1.5, 0, 3).error).toBe("invalid");
    expect(validateRequestQuantity(0, 0, 3).error).toBe("invalid");
    expect(validateRequestQuantity(1, 0, 0).error).toBe("unavailable");
    expect(validateRequestQuantity(2, 2, 3).error).toBe("exceeds_available");
  });

  it("merges a duplicate catalog line and rejects a merged total above availability", () => {
    const first = [{ key: "cat|brand|model", quantity: 1, label: "Model" }];
    const merged = mergeRequestDraftLine(first, { key: "cat|brand|model", quantity: 2, label: "Model" }, 3);
    expect(merged.error).toBeNull();
    expect(merged.rows).toEqual([{ key: "cat|brand|model", quantity: 3, label: "Model" }]);
    const rejected = mergeRequestDraftLine(merged.rows, { key: "cat|brand|model", quantity: 1, label: "Model" }, 3);
    expect(rejected.error).toBe("exceeds_available");
    expect(rejected.rows).toBe(merged.rows);
  });
});
