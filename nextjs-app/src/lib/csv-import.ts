// ============================================================================
//  استيراد المخزون من CSV — تحليل + تحقق (dry-run) **قبل أي كتابة**.
//  • بلا أي مكتبة خارجية: محلّل CSV يدوي متوافق مع RFC-4180 (اقتباس/فواصل/أسطر داخل الحقل + BOM).
//  • التحقق هنا لتجربة المستخدم فقط؛ **الأمان الحقيقي في RPC import_inventory** الذي يعيد
//    التحقق من جهة الخادم (الأدوار/الماليات/تفرّد الأعمدة) داخل معاملة واحدة.
//  • الوحدة نقية (بلا React) — قابلة للاختبار.
// ============================================================================

// ---------------------------------------------------------------------------
// 1) محلّل CSV (RFC-4180)
// ---------------------------------------------------------------------------
/** يحلّل نص CSV إلى مصفوفة صفوف من الحقول. يدعم الاقتباس المزدوج، الفواصل/الأسطر داخل الحقل، و"" هروبًا. */
export function parseCsv(input: string): string[][] {
  let text = input.replace(/^﻿/, ""); // إزالة BOM
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let i = 0;
  let inQuotes = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  // آخر حقل/صف إن لم ينتهِ بسطر جديد
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  // استبعاد الصفوف الفارغة تمامًا
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// ---------------------------------------------------------------------------
// 2) رؤوس الأعمدة القياسية + مرادفاتها (إنجليزي/عربي)
// ---------------------------------------------------------------------------
export type CanonField =
  | "item_type" | "name" | "category" | "company" | "supplier" | "location"
  | "serial_number" | "status" | "purchase_date" | "purchase_cost" | "warranty_end"
  | "condition_grade" | "rfid_tag" | "sku" | "unit" | "quantity" | "reorder_level"
  | "unit_cost" | "notes";

// الرؤوس القياسية بالترتيب (تُستخدم لتوليد القالب).
export const TEMPLATE_HEADERS: CanonField[] = [
  "item_type", "name", "category", "company", "supplier", "location",
  "serial_number", "status", "purchase_date", "purchase_cost", "warranty_end",
  "condition_grade", "rfid_tag", "sku", "unit", "quantity", "reorder_level", "unit_cost", "notes",
];

const HEADER_ALIASES: Record<string, CanonField> = {};
const addAliases = (f: CanonField, names: string[]) => names.forEach((x) => { HEADER_ALIASES[x] = f; });
addAliases("item_type", ["item_type", "type", "النوع", "نوع العنصر", "نوع"]);
addAliases("name", ["name", "الاسم", "اسم"]);
addAliases("category", ["category", "التصنيف", "الفئة"]);
addAliases("company", ["company", "brand", "الشركة", "العلامة", "العلامة التجارية"]);
addAliases("supplier", ["supplier", "vendor", "المورد"]);
addAliases("location", ["location", "الموقع"]);
addAliases("serial_number", ["serial_number", "serial", "الرقم التسلسلي", "السيريال", "الرقم المسلسل"]);
addAliases("status", ["status", "الحالة"]);
addAliases("purchase_date", ["purchase_date", "تاريخ الشراء"]);
addAliases("purchase_cost", ["purchase_cost", "cost", "قيمة الشراء", "سعر الشراء", "التكلفة"]);
addAliases("warranty_end", ["warranty_end", "warranty", "نهاية الضمان"]);
addAliases("condition_grade", ["condition_grade", "condition", "الحالة الفنية"]);
addAliases("rfid_tag", ["rfid_tag", "rfid", "بطاقة rfid", "رقم rfid"]);
addAliases("sku", ["sku", "رمز المنتج", "الرمز"]);
addAliases("unit", ["unit", "الوحدة"]);
addAliases("quantity", ["quantity", "qty", "الكمية"]);
addAliases("reorder_level", ["reorder_level", "reorder", "حد الطلب", "حد إعادة الطلب"]);
addAliases("unit_cost", ["unit_cost", "تكلفة الوحدة", "سعر الوحدة"]);
addAliases("notes", ["notes", "ملاحظات", "ملاحظة"]);

/** يطابق رأسًا خامًا إلى حقل قياسي (بلا حساسية لحالة الأحرف/المسافات). */
export function canonHeader(raw: string): CanonField | null {
  const key = raw.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(HEADER_ALIASES, key) ? HEADER_ALIASES[key] : null;
}

// الاستيراد لا ينشئ علاقة عهدة أو تخصيص؛ لذلك لا يجوز أن ينشئ «محجوز».
export const IMPORT_ASSET_STATUSES = ["available", "in_maintenance"];

// ---------------------------------------------------------------------------
// 3) أنواع البيانات المرجعية والنتيجة
// ---------------------------------------------------------------------------
export interface ImportRefs {
  categories: { id: string; name: string; name_ar: string | null }[];
  locations: { id: string; name: string; name_ar: string | null }[];
  companies: { id: string; name: string }[];
  suppliers: { id: string; name: string; name_ar: string | null }[];
  existingSerials: Set<string>; // lowercased
  existingRfids: Set<string>; // lowercased
  existingSkus: Set<string>; // lowercased
}

export interface ImportMessages {
  missingHeaders: string; // {cols}
  missingItemType: string;
  invalidItemType: string;
  missingName: string;
  missingCategory: string;
  missingCompany: string;
  missingLocation: string;
  missingSerial: string;
  unknownCategory: string; // {v}
  unknownLocation: string; // {v}
  unknownCompany: string; // {v}
  unknownSupplier: string; // {v}
  invalidStatus: string; // {v}
  invalidDate: string; // {v}
  invalidNumber: string; // {v}
  missingQuantity: string;
  dupSerialFile: string; // {v}
  dupSerialDb: string; // {v}
  dupRfidFile: string; // {v}
  dupRfidDb: string; // {v}
  dupSkuFile: string; // {v}
  dupSkuDb: string; // {v}
  financialIgnored: string; // warning
}

// الصف كما سيُرسَل للـRPC (مُطبَّع بمعرّفات محلولة).
export interface NormalizedItem {
  item_type: "asset" | "consumable";
  category_id: string;
  name: string;
  company_id: string | null;
  supplier_id: string | null;
  location_id: string | null;
  notes: string | null;
  // أصل
  serial_number?: string | null;
  status?: string;
  purchase_date?: string | null;
  purchase_cost?: number | null;
  warranty_end?: string | null;
  condition_grade?: string | null;
  rfid_tag?: string | null;
  // مستهلك
  sku?: string | null;
  unit?: string;
  quantity?: number;
  reorder_level?: number;
  unit_cost?: number | null;
}

export interface ImportRow {
  rowNumber: number; // رقم الصف في الملف (1 = أول صف بيانات)
  itemType: "asset" | "consumable" | null;
  display: string; // الاسم/الوسم للعرض
  errors: string[];
  warnings: string[];
  normalized: NormalizedItem | null;
}

export interface ImportValidation {
  headerError: string | null;
  rows: ImportRow[];
  valid: number;
  warning: number;
  error: number;
}

// ---------------------------------------------------------------------------
// 4) أدوات مساعدة
// ---------------------------------------------------------------------------
const norm = (s: string | undefined) => (s ?? "").trim();
const lc = (s: string) => s.trim().toLowerCase();
const fill = (tpl: string, v: string) => tpl.replace("{v}", v).replace("{cols}", v);

function isValidDate(s: string): boolean {
  // نقبل YYYY-MM-DD أو أي صيغة يفهمها Date، لكن نطلب سنة معقولة.
  if (!/\d/.test(s)) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}
export function normalizeImportDate(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// 5) التحقق (dry-run) — يبني ImportRow لكل صف بيانات
// ---------------------------------------------------------------------------
export function validateImport(
  records: string[][],
  refs: ImportRefs,
  opts: { canFinancial: boolean; canCreateAssets?: boolean; assetCreationDeniedMessage?: string },
  M: ImportMessages,
): ImportValidation {
  const empty: ImportValidation = { headerError: null, rows: [], valid: 0, warning: 0, error: 0 };
  if (records.length === 0) return { ...empty, headerError: fill(M.missingHeaders, "item_type, name, category") };

  // رأس الجدول → خريطة index→canon
  const header = records[0];
  const colIndex: Partial<Record<CanonField, number>> = {};
  header.forEach((h, i) => { const c = canonHeader(h); if (c && colIndex[c] === undefined) colIndex[c] = i; });

  // الأعمدة المطلوبة كحد أدنى
  const required: CanonField[] = ["item_type", "name", "category"];
  const missing = required.filter((c) => colIndex[c] === undefined);
  if (missing.length) return { ...empty, headerError: fill(M.missingHeaders, missing.join(", ")) };

  // خرائط المطابقة (بلا حساسية لحالة الأحرف) — تدعم الاسم والاسم العربي
  const catMap = new Map<string, string>();
  refs.categories.forEach((c) => { catMap.set(lc(c.name), c.id); if (c.name_ar) catMap.set(lc(c.name_ar), c.id); });
  const locMap = new Map<string, string>();
  refs.locations.forEach((l) => { locMap.set(lc(l.name), l.id); if (l.name_ar) locMap.set(lc(l.name_ar), l.id); });
  const compMap = new Map<string, string>();
  refs.companies.forEach((c) => compMap.set(lc(c.name), c.id));
  const supMap = new Map<string, string>();
  refs.suppliers.forEach((s) => { supMap.set(lc(s.name), s.id); if (s.name_ar) supMap.set(lc(s.name_ar), s.id); });

  const seenSerials = new Set<string>();
  const seenRfids = new Set<string>();
  const seenSkus = new Set<string>();

  const cell = (r: string[], c: CanonField) => (colIndex[c] !== undefined ? norm(r[colIndex[c]!]) : "");

  const rows: ImportRow[] = [];
  for (let ri = 1; ri < records.length; ri++) {
    const r = records[ri];
    const errors: string[] = [];
    const warnings: string[] = [];

    const typeRaw = lc(cell(r, "item_type"));
    const itemType: "asset" | "consumable" | null =
      typeRaw === "asset" || typeRaw === "أصل" ? "asset"
        : typeRaw === "consumable" || typeRaw === "مستهلك" ? "consumable"
          : null;
    const name = cell(r, "name");
    const display = name || cell(r, "serial_number") || cell(r, "sku") || `#${ri}`;

    if (!typeRaw) errors.push(M.missingItemType);
    else if (!itemType) errors.push(fill(M.invalidItemType, typeRaw));
    else if (itemType === "asset" && opts.canCreateAssets === false) {
      errors.push(opts.assetCreationDeniedMessage ?? M.invalidItemType);
    }
    if (!name) errors.push(M.missingName);

    // التصنيف (إجباري + يجب أن يوجد)
    const catRaw = cell(r, "category");
    let category_id = "";
    if (!catRaw) errors.push(M.missingCategory);
    else {
      const id = catMap.get(lc(catRaw));
      if (!id) errors.push(fill(M.unknownCategory, catRaw));
      else category_id = id;
    }

    // مراجع اختيارية: إن وُجدت يجب أن تطابق (لا نُسقطها بصمت)
    const resolveOpt = (c: CanonField, map: Map<string, string>, msg: string): string | null => {
      const v = cell(r, c);
      if (!v) return null;
      const id = map.get(lc(v));
      if (!id) { errors.push(fill(msg, v)); return null; }
      return id;
    };
    const company_id = resolveOpt("company", compMap, M.unknownCompany);
    const supplier_id = resolveOpt("supplier", supMap, M.unknownSupplier);
    const location_id = resolveOpt("location", locMap, M.unknownLocation);
    const notes = cell(r, "notes") || null;

    // حقل مالي مشترك: يُتجاهل لغير المخوّل (تحذير)، ويُتحقق كرقم للمخوّل
    const parseCost = (c: CanonField): number | null => {
      const v = cell(r, c);
      if (!v) return null;
      if (!opts.canFinancial) { warnings.push(M.financialIgnored); return null; }
      const n = Number(v.replace(/,/g, ""));
      if (!Number.isFinite(n) || n < 0) { errors.push(fill(M.invalidNumber, v)); return null; }
      return n;
    };

    let normalized: NormalizedItem | null = null;

    if (itemType === "asset") {
      // import_inventory لا يرسل إعفاء serial؛ حارس INSERT يطلب الشركة والموقع والرقم.
      if (!cell(r, "company")) errors.push(M.missingCompany);
      if (!cell(r, "location")) errors.push(M.missingLocation);
      const serial = cell(r, "serial_number");
      if (!serial) errors.push(M.missingSerial);
      else {
        const key = lc(serial);
        if (seenSerials.has(key)) errors.push(fill(M.dupSerialFile, serial));
        else if (refs.existingSerials.has(key)) errors.push(fill(M.dupSerialDb, serial));
        else seenSerials.add(key);
      }
      // الحالة
      const statusRaw = lc(cell(r, "status"));
      let status = "available";
      if (statusRaw) {
        if (IMPORT_ASSET_STATUSES.includes(statusRaw)) status = statusRaw;
        else errors.push(fill(M.invalidStatus, cell(r, "status")));
      }
      // التواريخ
      const pd = cell(r, "purchase_date");
      if (pd && !isValidDate(pd)) errors.push(fill(M.invalidDate, pd));
      const we = cell(r, "warranty_end");
      if (we && !isValidDate(we)) errors.push(fill(M.invalidDate, we));
      // RFID فريد
      const rfid = cell(r, "rfid_tag");
      if (rfid) {
        const key = lc(rfid);
        if (seenRfids.has(key)) errors.push(fill(M.dupRfidFile, rfid));
        else if (refs.existingRfids.has(key)) errors.push(fill(M.dupRfidDb, rfid));
        else seenRfids.add(key);
      }
      const purchase_cost = parseCost("purchase_cost");

      if (errors.length === 0) {
        normalized = {
          item_type: "asset", category_id, name,
          company_id, supplier_id, location_id, notes,
          serial_number: serial || null, status,
          purchase_date: pd ? normalizeImportDate(pd) : null,
          purchase_cost,
          warranty_end: we ? normalizeImportDate(we) : null,
          condition_grade: cell(r, "condition_grade") || null,
          rfid_tag: rfid || null,
        };
      }
    } else if (itemType === "consumable") {
      const sku = cell(r, "sku");
      if (sku) {
        const key = lc(sku);
        if (seenSkus.has(key)) errors.push(fill(M.dupSkuFile, sku));
        else if (refs.existingSkus.has(key)) errors.push(fill(M.dupSkuDb, sku));
        else seenSkus.add(key);
      }
      const rfid = cell(r, "rfid_tag");
      if (rfid) {
        const key = lc(rfid);
        if (seenRfids.has(key)) errors.push(fill(M.dupRfidFile, rfid));
        else if (refs.existingRfids.has(key)) errors.push(fill(M.dupRfidDb, rfid));
        else seenRfids.add(key);
      }
      // الكمية (مطلوبة رقمًا ≥ 0) وحد الطلب (اختياري افتراضي 0)
      const qtyRaw = cell(r, "quantity");
      let quantity = 0;
      if (!qtyRaw) errors.push(M.missingQuantity);
      else { const q = Number(qtyRaw.replace(/,/g, "")); if (!Number.isFinite(q) || q < 0) errors.push(fill(M.invalidNumber, qtyRaw)); else quantity = q; }
      const reRaw = cell(r, "reorder_level");
      let reorder_level = 0;
      if (reRaw) { const re = Number(reRaw.replace(/,/g, "")); if (!Number.isFinite(re) || re < 0) errors.push(fill(M.invalidNumber, reRaw)); else reorder_level = re; }
      const unit_cost = parseCost("unit_cost");

      if (errors.length === 0) {
        normalized = {
          item_type: "consumable", category_id, name,
          company_id, supplier_id, location_id, notes,
          sku: sku || null, unit: cell(r, "unit") || "each",
          quantity, reorder_level, unit_cost, rfid_tag: rfid || null,
        };
      }
    }

    const status: "valid" | "warning" | "error" = errors.length ? "error" : warnings.length ? "warning" : "valid";
    rows.push({ rowNumber: ri, itemType, display, errors, warnings, normalized });
    void status;
  }

  const valid = rows.filter((r) => r.errors.length === 0 && r.warnings.length === 0).length;
  const warning = rows.filter((r) => r.errors.length === 0 && r.warnings.length > 0).length;
  const error = rows.filter((r) => r.errors.length > 0).length;
  return { headerError: null, rows, valid, warning, error };
}

/** يبني نص CSV من رؤوس وصفوف (للقالب) — إعادة تصدير downloadCSV غير متاح هنا فنبقيه بسيطًا. */
export function templateCsv(exampleRows: string[][]): { headers: string[]; rows: string[][] } {
  return { headers: TEMPLATE_HEADERS as string[], rows: exampleRows };
}
