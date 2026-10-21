import { describe, it, expect, vi } from "vitest";
import { buildCsvContent, downloadCSV } from "./export";

// M5 — تحقّق منطق توليد CSV (نص فقط، بلا DOM/تنزيل). التنزيل الفعلي يُتحقق يدويًا.
describe("buildCsvContent (M5 — CSV generation)", () => {
  it("prefixes a UTF-8 BOM and joins header + rows with newlines", () => {
    const out = buildCsvContent(["a", "b"], [[1, 2], [3, 4]]);
    expect(out.startsWith("﻿")).toBe(true);
    expect(out).toBe("﻿a,b\n1,2\n3,4");
  });

  it("neutralizes formula-injection payloads (=, @, +/- followed by non-digit, leading tab/CR) with a leading quote", () => {
    // ملاحظة: الحارس يحيّد +/- فقط إذا تلاها محرف غير رقمي (يُبقي +966…/-5 كأرقام عمدًا).
    const out = buildCsvContent(["h"], [["=SUM(A1:A9)"], ["@cmd"], ["+A1"], ["-cmd()"], ["\t=x"]]);
    expect(out).toContain("'=SUM(A1:A9)");
    expect(out).toContain("'@cmd");
    expect(out).toContain("'+A1");
    expect(out).toContain("'-cmd()");
    expect(out).toContain("'\t=x");
  });

  it("keeps genuine numbers (negative / decimal / phone) unescaped", () => {
    const out = buildCsvContent(["n"], [[-5], [3.2], ["+966500000000"]]);
    expect(out).toContain("\n-5");
    expect(out).toContain("\n3.2");
    expect(out).toContain("\n+966500000000");
  });

  it("quotes fields containing comma, double-quote, or newline", () => {
    const out = buildCsvContent(["x"], [["a,b"], ['he said "hi"'], ["line1\nline2"]]);
    expect(out).toContain('"a,b"');
    expect(out).toContain('"he said ""hi"""');
    expect(out).toContain('"line1\nline2"');
  });

  it("renders null / undefined as empty cells", () => {
    const out = buildCsvContent(["a", "b"], [[null, undefined]]);
    expect(out).toBe("﻿a,b\n,");
  });

  it("serializes unexpected object cells instead of emitting [object Object]", () => {
    const out = buildCsvContent(["value"], [[{ label: "عربي" } as any]]);
    expect(out).not.toContain("[object Object]");
    expect(out).toContain('"{""label"":""عربي""}"');
  });

  // (CSV-1) سلامة ترميز العربية: BOM بادئ + الحفاظ الحرفي على النص العربي عبر التوليد.
  it("preserves Arabic content verbatim behind the UTF-8 BOM (Excel-ar integrity)", () => {
    const out = buildCsvContent(["الوسم", "الحالة"], [["حاسوب محمول", "مُتاح"]]);
    expect(out.charCodeAt(0)).toBe(0xfeff); // BOM
    expect(out).toContain("الوسم,الحالة");
    expect(out).toContain("حاسوب محمول,مُتاح");
  });
});

describe("downloadCSV browser contract", () => {
  it("creates a non-empty UTF-8 CSV Blob and a valid download filename", () => {
    const blobs: Array<{ parts: unknown[]; type: string }> = [];
    const anchor = {
      href: "",
      download: "",
      style: {} as Record<string, string>,
      click: vi.fn(),
    };
    const appendChild = vi.fn();
    const removeChild = vi.fn();
    vi.stubGlobal("Blob", class {
      parts: unknown[];
      type: string;
      constructor(parts: unknown[], options: { type: string }) {
        this.parts = parts;
        this.type = options.type;
        blobs.push(this);
      }
    });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:uat-csv"),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("document", {
      body: { appendChild, removeChild },
      createElement: vi.fn(() => anchor),
    });

    try {
      expect(downloadCSV("inventory_report.csv", ["الاسم", "الحالة"], [["حاسوب", "=SUM(A1:A2)"]])).toBe(true);
      expect(blobs).toHaveLength(1);
      expect(blobs[0].type).toBe("text/csv;charset=utf-8;");
      expect(String(blobs[0].parts[0])).toContain("الاسم,الحالة");
      expect(String(blobs[0].parts[0])).toContain("'=SUM(A1:A2)");
      expect(anchor.download).toBe("inventory_report.csv");
      expect(anchor.href).toBe("blob:uat-csv");
      expect(anchor.click).toHaveBeenCalledOnce();
      expect(appendChild).toHaveBeenCalledWith(anchor);
      expect(removeChild).toHaveBeenCalledWith(anchor);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// (CSV-4) عقد أمان الأعمدة المالية في التصدير.
// الحارس الفعلي للتسريب هو قاعدة البيانات (revoke على أعمدة المبالغ + RPC *_financial المحكومة).
// الطبقة الثانية التجميلية في كل مستدعٍ هي النمط `fin ? [col] : []`. هذا الاختبار يُثبّت ذلك النمط
// كعقد قابل للانحدار. ملاحظة: المستدعيات الحقيقية (reports/page, consumables-panel, requests/page,
// customer-requests-tab) تبني الأعمدة داخل إغلاقات مجهولة؛ استخلاص دالة نقية مشتركة واختبارها
// مباشرةً توصية متابعة منخفضة الخطر (بدون ذلك يظل هذا اختبارَ نمطٍ لا اختبارَ المستدعي ذاته).
describe("CSV financial-column gating contract (fin ? [col] : [])", () => {
  // تمثيل مطابق لنمط المستدعي: عمود التكلفة يظهر فقط عندما fin=true.
  const assetHeaders = (fin: boolean) => ["الوسم", "التصنيف", "الحالة", ...(fin ? ["التكلفة (ر.س)"] : [])];
  const assetRow = (fin: boolean) => ["AST-1", "حاسوب", "مُتاح", ...(fin ? [1234.56] : [])];

  it("omits every financial column/value for a non-financial role (fin=false)", () => {
    const out = buildCsvContent(assetHeaders(false), [assetRow(false)]);
    expect(out).not.toMatch(/ر\.س|SAR|1234\.56|التكلفة|cost|price/i);
    expect(out).toBe("﻿الوسم,التصنيف,الحالة\nAST-1,حاسوب,مُتاح");
  });

  it("includes the financial column/value for a financial role (fin=true)", () => {
    const out = buildCsvContent(assetHeaders(true), [assetRow(true)]);
    expect(out).toContain("التكلفة (ر.س)");
    expect(out).toContain("1234.56");
  });
});
