// ===========================================================================
// Asset Type Templates / Dynamic Asset Attributes
// ---------------------------------------------------------------------------
// نظام قوالب مركزي: لكل نوع أصل حقيقي (SIM / Router / Printer / Laptop / Scanner
// / Tablet / POS / Display / Camera / Scooter / Accessory / Consumable / Other)
// مجموعة حقول إضافية تُخزَّن داخل عمود special_attributes الموجود أصلًا — بدون أي
// تعديل على قاعدة البيانات أو الـ Schema أو الـ RLS.
//
// هذا الملف لا يحتوي JSX ولا نصوصًا مكتوبة مباشرة (hardcoded). كل التسميات تُحلّ
// عبر مفاتيح i18n: t.assetTemplates.* / t.assetTemplateFields.* /
// t.assetTemplateOptions.* / t.assetTemplateWarnings.*
// ===========================================================================

export type TemplateId =
  | "sim"
  | "router"
  | "printer"
  | "laptop"
  | "scanner"
  | "tablet"
  | "pos"
  | "display"
  | "camera"
  | "scooter"
  | "accessory"
  | "consumable"
  | "other";

export type FieldType =
  | "text"
  | "number"
  | "select"
  | "date"
  | "boolean"
  | "textarea"
  | "multiSelect";

export interface TemplateOption {
  /** القيمة المخزّنة في special_attributes (رمز ثابت من مفرداتنا، يُترجَم للعرض). */
  value: string;
  /** مفتاح داخل t.assetTemplateOptions */
  labelKey: string;
}

export interface TemplateField {
  /** مفتاح التخزين داخل special_attributes، وأيضًا مفتاح التسمية في t.assetTemplateFields. */
  key: string;
  type: FieldType;
  options?: TemplateOption[];
  required?: boolean;
  /** حقل مالي — يُعرض فقط لمن لديه canSeeFinancial. */
  financial?: boolean;
  /** حقل حساس غير مالي — يُعرض فقط لمن لديه canWrite (مخفي عن viewer/auditor). */
  sensitive?: boolean;
  /** هل يظهر في قسم تفاصيل الأصل؟ الافتراضي true. */
  visibleInDetails?: boolean;
  /** قيمة موجزة قد تظهر في جدول الأصول (تلميح فقط). */
  visibleInTable?: boolean;
  /** أدخل النص باتجاه LTR (للأرقام/المعرّفات/الشبكة). */
  ltr?: boolean;
  placeholderKey?: string;
  helperKey?: string;
}

export interface AssetTemplate {
  id: TemplateId;
  fields: TemplateField[];
  /** أصل يبدو كمستهلك (يُفضَّل إدارته من صفحة المستهلكات) — يعرض تنبيهًا فقط. */
  consumableLike?: boolean;
  /** يحتاج تصنيف (لم يُطابق قالبًا معروفًا). */
  needsReview?: boolean;
}

// ---------- مفاتيح special_attributes القديمة المحميّة (لا تُحذف أو تُفرَّغ أبدًا) ----------
export const RESERVED_ATTR_KEYS: ReadonlySet<string> = new Set([
  "source",
  "excel_import",
  "asana_task_id",
  "section",
  "msisdn",
]);

// ---------- اختصارات لبناء الخيارات ----------
const opt = (value: string): TemplateOption => ({ value, labelKey: value });
const opts = (...values: string[]): TemplateOption[] => values.map(opt);

// مجموعات خيارات مشتركة
const CARRIER = opts("stc", "mobily", "zain", "salam", "virgin", "lebara", "other");
const PROVIDER = opts("stc", "mobily", "zain", "salam", "other");
const NETWORK_TYPE = opts("4g", "5g", "fiber", "other");
const BILLING = opts("monthly", "yearly", "prepaid");
const SIM_STATUS = opts("active", "suspended", "expired", "needs_renewal");
const PRINTER_TYPE = opts("card", "label", "receipt", "paper", "thermal", "other");
const PRINTER_BRAND = opts("epson", "matica", "swiftcolor", "hiti", "brother", "zenius", "other");
const PRINTER_CONSUMABLE = opts("ink", "ribbon", "roll", "toner", "maintenance_kit");
const CONN_PRINTER = opts("usb", "network", "wifi", "bluetooth");
const CONN_SCANNER = opts("usb", "bluetooth", "wifi");
const CONN_POS = opts("sim", "wifi", "lan");
const STORAGE_TYPE = opts("ssd", "hdd", "nvme");
const PREPARED_FOR = opts("rent", "sale", "internal");
const CONDITION_GRADE = opts("excellent", "good", "needs_maintenance", "broken");
const SCANNER_TYPE = opts("barcode", "rfid", "qr", "mobile_computer", "other");
const SCANNER_BRAND = opts("honeywell", "zebra", "acs", "other");
const MDM_STATUS = opts("enrolled", "not_enrolled", "unknown");
const DISPLAY_TYPE = opts("lcd", "led", "oled", "other");
const MOUNT_TYPE = opts("wall", "stand", "ceiling", "other");
const CAMERA_TYPE = opts("ip", "analog", "ptz", "other");
const RECORDING_STATUS = opts("recording", "not_recording", "unknown");
const CONSUMABLE_KIND = opts("ink", "ribbon", "roll", "toner", "maintenance_kit", "paper", "badge", "other");
const UNIT = opts("piece", "box", "roll", "pack");
const OPENED_STATUS = opts("sealed", "opened");

// ===========================================================================
//                                القوالب
// ===========================================================================
export const TEMPLATES: Record<TemplateId, AssetTemplate> = {
  // A) SIM Card
  sim: {
    id: "sim",
    fields: [
      { key: "carrier", type: "select", options: CARRIER },
      { key: "msisdn", type: "text", ltr: true, visibleInTable: true },
      { key: "iccid", type: "text", ltr: true, sensitive: true },
      { key: "planType", type: "text" },
      { key: "dataLimit", type: "text" },
      { key: "billingCycle", type: "select", options: BILLING },
      { key: "monthlyCost", type: "number", ltr: true, financial: true },
      { key: "activationDate", type: "date", ltr: true },
      { key: "expiryDate", type: "date", ltr: true },
      { key: "renewalReminder", type: "boolean" },
      { key: "linkedDevice", type: "text" },
      { key: "projectOrClient", type: "text" },
      { key: "simStatus", type: "select", options: SIM_STATUS, visibleInTable: true },
    ],
  },

  // B) Router / Modem
  router: {
    id: "router",
    fields: [
      { key: "networkType", type: "select", options: NETWORK_TYPE, visibleInTable: true },
      { key: "provider", type: "select", options: PROVIDER },
      { key: "imei", type: "text", ltr: true },
      { key: "macAddress", type: "text", ltr: true },
      { key: "ipAddress", type: "text", ltr: true },
      { key: "linkedSim", type: "text", ltr: true },
      { key: "ssid", type: "text", ltr: true },
      { key: "hasCharger", type: "boolean" },
      { key: "hasAntenna", type: "boolean" },
      { key: "projectOrClient", type: "text" },
      { key: "lastSignalTest", type: "date", ltr: true },
      { key: "adminCredentialNote", type: "text", sensitive: true, helperKey: "credentialNoteHelper" },
    ],
  },

  // C) Printer
  printer: {
    id: "printer",
    fields: [
      { key: "printerType", type: "select", options: PRINTER_TYPE, visibleInTable: true },
      { key: "brand", type: "select", options: PRINTER_BRAND, visibleInTable: true },
      { key: "modelName", type: "text" },
      { key: "consumableType", type: "select", options: PRINTER_CONSUMABLE },
      { key: "compatibleConsumables", type: "text" },
      { key: "printCounter", type: "number", ltr: true },
      { key: "connectionType", type: "select", options: CONN_PRINTER },
      { key: "ipAddress", type: "text", ltr: true },
      { key: "macAddress", type: "text", ltr: true },
      { key: "hasPowerCable", type: "boolean" },
      { key: "hasUsbCable", type: "boolean" },
      { key: "lastMaintenanceDate", type: "date", ltr: true },
      { key: "printHeadStatus", type: "text" },
      { key: "paperOrCardType", type: "text" },
      { key: "extraNotes", type: "textarea" },
    ],
  },

  // D) Laptop / Workstation
  laptop: {
    id: "laptop",
    fields: [
      { key: "cpu", type: "text", visibleInTable: true },
      { key: "ram", type: "text", visibleInTable: true },
      { key: "storage", type: "text" },
      { key: "storageType", type: "select", options: STORAGE_TYPE },
      { key: "operatingSystem", type: "text" },
      { key: "osVersion", type: "text", ltr: true },
      { key: "hostname", type: "text", ltr: true },
      { key: "windowsLicense", type: "text", ltr: true, sensitive: true },
      { key: "batteryHealth", type: "text" },
      { key: "hasCharger", type: "boolean" },
      { key: "installedSoftware", type: "textarea" },
      { key: "preparedFor", type: "select", options: PREPARED_FOR },
      { key: "conditionGrade", type: "select", options: CONDITION_GRADE },
    ],
  },

  // E) Scanner / RFID / Honeywell / Zebra
  scanner: {
    id: "scanner",
    fields: [
      { key: "scannerType", type: "select", options: SCANNER_TYPE, visibleInTable: true },
      { key: "brand", type: "select", options: SCANNER_BRAND, visibleInTable: true },
      { key: "modelName", type: "text" },
      { key: "connectionType", type: "select", options: CONN_SCANNER },
      { key: "firmwareVersion", type: "text", ltr: true },
      { key: "batteryHealth", type: "text" },
      { key: "hasDock", type: "boolean" },
      { key: "hasCharger", type: "boolean" },
      { key: "readingStatus", type: "text" },
      { key: "lastCalibrationDate", type: "date", ltr: true },
      { key: "assignedAppOrSystem", type: "text" },
      { key: "screenCondition", type: "text" },
      { key: "buttonCondition", type: "text" },
    ],
  },

  // F) Tablet / iPad / Mobile
  tablet: {
    id: "tablet",
    fields: [
      { key: "brand", type: "text", visibleInTable: true },
      { key: "modelName", type: "text" },
      { key: "imei", type: "text", ltr: true },
      { key: "storage", type: "text" },
      { key: "operatingSystem", type: "text" },
      { key: "osVersion", type: "text", ltr: true },
      { key: "linkedSim", type: "text", ltr: true },
      { key: "mdmStatus", type: "select", options: MDM_STATUS },
      { key: "hasCharger", type: "boolean" },
      { key: "hasCase", type: "boolean" },
      { key: "hasHolder", type: "boolean" },
      { key: "screenCondition", type: "text" },
      { key: "batteryHealth", type: "text" },
      { key: "accountNote", type: "text", sensitive: true, helperKey: "noPasswordHelper" },
    ],
  },

  // G) POS System
  pos: {
    id: "pos",
    fields: [
      { key: "provider", type: "text", visibleInTable: true },
      { key: "terminalId", type: "text", ltr: true },
      { key: "merchantId", type: "text", ltr: true, sensitive: true },
      { key: "connectionType", type: "select", options: CONN_POS },
      { key: "linkedSim", type: "text", ltr: true },
      { key: "receiptPrinterStatus", type: "text" },
      { key: "lastSettlementTest", type: "date", ltr: true },
      { key: "hasCharger", type: "boolean" },
      { key: "hasPaperRoll", type: "boolean" },
      { key: "bankOrProcessor", type: "text" },
      { key: "projectOrClient", type: "text" },
    ],
  },

  // H) Display / TV / Screen
  display: {
    id: "display",
    fields: [
      { key: "screenSize", type: "text", visibleInTable: true },
      { key: "resolution", type: "text" },
      { key: "displayType", type: "select", options: DISPLAY_TYPE },
      { key: "ports", type: "text" },
      { key: "hasRemote", type: "boolean" },
      { key: "hasStand", type: "boolean" },
      { key: "mountType", type: "select", options: MOUNT_TYPE },
      { key: "installationLocation", type: "text" },
      { key: "screenCondition", type: "text" },
    ],
  },

  // I) Camera / DVR
  camera: {
    id: "camera",
    fields: [
      { key: "cameraType", type: "select", options: CAMERA_TYPE, visibleInTable: true },
      { key: "resolution", type: "text" },
      { key: "ipAddress", type: "text", ltr: true },
      { key: "macAddress", type: "text", ltr: true },
      { key: "storageCapacity", type: "text" },
      { key: "recordingStatus", type: "select", options: RECORDING_STATUS },
      { key: "locationCovered", type: "text" },
      { key: "hasPowerAdapter", type: "boolean" },
      { key: "lastTestDate", type: "date", ltr: true },
    ],
  },

  // J) Scooter
  scooter: {
    id: "scooter",
    fields: [
      { key: "scooterBrand", type: "text", visibleInTable: true },
      { key: "batteryHealth", type: "text" },
      { key: "chargerIncluded", type: "boolean" },
      { key: "tireCondition", type: "text" },
      { key: "brakeCondition", type: "text" },
      { key: "maxSpeed", type: "text", ltr: true },
      { key: "lastSafetyCheck", type: "date", ltr: true },
      { key: "assignedProject", type: "text" },
    ],
  },

  // K) Accessory
  accessory: {
    id: "accessory",
    fields: [
      { key: "accessoryType", type: "text", visibleInTable: true },
      { key: "compatibleWith", type: "text" },
      { key: "quantityIfBulk", type: "number", ltr: true },
      { key: "isSerialized", type: "boolean" },
      { key: "condition", type: "text" },
      { key: "assignedWithAsset", type: "text" },
      { key: "extraNotes", type: "textarea" },
    ],
  },

  // L) Consumable-like Asset (تنبيه فقط — لا نقل بيانات)
  consumable: {
    id: "consumable",
    consumableLike: true,
    fields: [
      { key: "consumableType", type: "select", options: CONSUMABLE_KIND, visibleInTable: true },
      { key: "quantity", type: "number", ltr: true, visibleInTable: true },
      { key: "unit", type: "select", options: UNIT },
      { key: "compatiblePrinter", type: "text" },
      { key: "expiryDate", type: "date", ltr: true },
      { key: "reorderLevel", type: "number", ltr: true },
      { key: "unitCost", type: "number", ltr: true, financial: true },
      { key: "storageLocation", type: "text" },
      { key: "openedStatus", type: "select", options: OPENED_STATUS },
    ],
  },

  // M) Other / Needs Review
  other: {
    id: "other",
    needsReview: true,
    fields: [
      { key: "reviewCategory", type: "text" },
      { key: "suggestedTemplate", type: "text" },
      { key: "needsClassification", type: "boolean" },
      { key: "extraNotes", type: "textarea" },
    ],
  },
};

export const ALL_TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];

// ---------------------------------------------------------------------------
// طبقة عرض فقط: حقول «مهمة» لكل نوع + مفاتيح بيانات الاستيراد التقنية.
// لا تؤثر على التخزين/الكشف/القاعدة — تُستخدم في صفحة تفاصيل الأصل فقط لإظهار
// الحقول الناقصة كـ «غير مدخل» وحساب اكتمال البيانات، وإخفاء بيانات الاستيراد.
// ---------------------------------------------------------------------------

/**
 * الحقول «المهمة» لكل نوع — تُعرض دائمًا في تفاصيل الأصل حتى لو كانت فارغة،
 * وتُحتسب ضمن مؤشّر «اكتمال بيانات النوع». (كلها مفاتيح موجودة في TEMPLATES أعلاه.)
 */
export const IMPORTANT_FIELDS: Record<TemplateId, ReadonlySet<string>> = {
  sim: new Set([
    "carrier", "msisdn", "iccid", "planType", "dataLimit", "billingCycle",
    "monthlyCost", "activationDate", "expiryDate", "renewalReminder",
    "linkedDevice", "projectOrClient", "simStatus",
  ]),
  router: new Set([
    "networkType", "provider", "imei", "macAddress", "ipAddress",
    "linkedSim", "ssid", "hasCharger", "hasAntenna",
  ]),
  printer: new Set([
    "printerType", "brand", "modelName", "consumableType",
    "compatibleConsumables", "printCounter", "connectionType",
  ]),
  laptop: new Set([
    "cpu", "ram", "storage", "operatingSystem", "hostname",
    "batteryHealth", "hasCharger",
  ]),
  scanner: new Set([
    "scannerType", "brand", "modelName", "connectionType",
    "batteryHealth", "hasDock", "hasCharger", "readingStatus",
  ]),
  tablet: new Set([
    "brand", "modelName", "imei", "storage", "operatingSystem",
    "linkedSim", "mdmStatus", "batteryHealth",
  ]),
  pos: new Set([
    "provider", "terminalId", "connectionType", "linkedSim",
    "receiptPrinterStatus", "bankOrProcessor",
  ]),
  display: new Set([
    "screenSize", "resolution", "displayType", "mountType",
    "installationLocation", "screenCondition",
  ]),
  camera: new Set([
    "cameraType", "resolution", "ipAddress", "storageCapacity",
    "recordingStatus", "locationCovered",
  ]),
  scooter: new Set([
    "scooterBrand", "batteryHealth", "tireCondition", "brakeCondition", "maxSpeed",
  ]),
  accessory: new Set([
    "accessoryType", "compatibleWith", "condition", "assignedWithAsset",
  ]),
  consumable: new Set([
    "consumableType", "quantity", "unit", "compatiblePrinter", "expiryDate", "reorderLevel",
  ]),
  other: new Set([
    "reviewCategory", "suggestedTemplate", "needsClassification",
  ]),
};

/**
 * مفاتيح بيانات الاستيراد التقنية — تُخفى من العرض الرئيسي وتُجمَّع في أكورديون
 * «بيانات الاستيراد» يظهر لـ admin / it_manager فقط (لا تُحذف من القاعدة أبدًا).
 */
export const IMPORT_META_KEYS: ReadonlySet<string> = new Set([
  "source", "excel_import", "asana_task_id", "section", "dup_serial_of",
]);

/** كل مفاتيح الحقول التي يملكها أي قالب معروف — تُستخدم لتمييز المفاتيح "المعروفة" عن القديمة المجهولة. */
const ALL_TEMPLATE_FIELD_KEYS: ReadonlySet<string> = new Set(
  ALL_TEMPLATE_IDS.flatMap((id) => TEMPLATES[id].fields.map((f) => f.key)),
);

// ===========================================================================
//                             كشف القالب (Mapping)
// ===========================================================================
const CLASSIFICATION_TOKENS = {
  chair: ["chair", "كرسي"],
  chargingParts: ["charging plug", "charging wire", "charging cable", "charging adapter"],
  router: ["router", "modem", "moder", "راوتر", "مودم", "huawei b535", "tp-link", "tplink", "tl-mr"],
  printer: ["printer", "epson", "matica", "swift", "hiti", "brother", "broather", "zenius", "zenus", "طابعة"],
  laptop: ["laptop", "workstation", "work station", "macbook", "لابتوب", "محطة عمل"],
  scanner: ["honeywell", "eda51", "zebra", "scanner", "scan device", "scan_", "rfid", "acr122", "acr1220", "lasercode", "usb hid", "ماسح"],
  tablet: ["ipad", "آيباد", "iphone", "آيفون", "ايفون", "tablet", "تابلت", "galax", "honor", "samsung", "huawei tap", "mobile", "جوال"],
  pos: ["pos", "n910", "نقطة بيع", "نقاط بيع"],
  display: ["display", "signage", "شاشة", "screen"],
  camera: ["camera", "dvr", "كاميرا", "رسيفر", "cctv"],
  scooter: ["scooter", "scotter", "سكوتر"],
  accessory: ["mouse", "keyboard", "charger", "holder", "lanyard", "wrist", "flashlight", "electrical", "stanley", "cup", "seal", "ختم", "pump", "فأرة", "لوحة مفاتيح", "شاحن", "سوار"],
  sim: ["sim card", "شريحة"],
  consumable: ["rebon", "ribbon", "toner", "maintenance kit", "badge", "punch badge", "film", "حبر", "ريبون", "شارة", "بادج"],
} as const;

function norm(v: unknown): string {
  return (v == null ? "" : String(v)).toLowerCase();
}
function has(hay: string, tokens: readonly string[]): boolean {
  for (const token of tokens) {
    if (hay.includes(token)) return true;
  }
  return false;
}

/**
 * مصنّف الأجهزة لنص واحد (اسم الأصل، أو سلّة القسم/التصنيف). يُعيد القالب أو null إن لم يُطابق.
 * يبدأ بتجاوزات «ليست جهازًا» (كرسي / أجزاء شحن) حتى لا تُسحب لقالب الجهاز الأب.
 */
function classifyDevice(text: string): TemplateId | null {
  // تجاوزات: أثاث وأجزاء/كوابل شحن تُعامل كملحقات حتى لو حملت اسم الجهاز الأب
  if (has(text, CLASSIFICATION_TOKENS.chair)) return "accessory";
  if (has(text, CLASSIFICATION_TOKENS.chargingParts)) return "accessory";

  if (has(text, CLASSIFICATION_TOKENS.router)) return "router";
  if (has(text, CLASSIFICATION_TOKENS.printer)) return "printer";
  if (has(text, CLASSIFICATION_TOKENS.laptop)) return "laptop";
  if (has(text, CLASSIFICATION_TOKENS.scanner) || /\bscan\b/.test(text)) return "scanner";
  if (has(text, CLASSIFICATION_TOKENS.tablet) || /\btap\b/.test(text)) return "tablet";
  if (has(text, CLASSIFICATION_TOKENS.pos)) return "pos";
  if (has(text, CLASSIFICATION_TOKENS.display) || /\btv\b/.test(text)) return "display";
  if (has(text, CLASSIFICATION_TOKENS.camera)) return "camera";
  if (has(text, CLASSIFICATION_TOKENS.scooter)) return "scooter";
  if (has(text, CLASSIFICATION_TOKENS.accessory)) return "accessory";
  return null;
}

/**
 * يحدّد نوع القالب. القرار في طبقة العرض فقط — لا يُعدّل التصنيف في القاعدة.
 * الأولوية: SIM → Consumable (من أي حقل) → الاسم أولًا → ثم القسم/التصنيف/التسلسلي → Other.
 * تفضيل الاسم على القسم يمنع «تلوّث القسم» (قسم يحمل اسم مشروع فيه ماركة، مثل "...SWIFTCOLOR..."
 * يجعل ماسح Honeywell يُصنَّف طابعةً). الاستهلاكيات تُكتشف من أي حقل لأن أسماءها قد تكون ماركة طابعة.
 */
export function getTemplateByCategoryOrSection(
  categoryName?: string | null,
  categoryNameAr?: string | null,
  section?: unknown,
  name?: string | null,
  serial?: string | null,
  attrs?: unknown,
): TemplateId {
  const nameText = norm(name);
  const fallbackText = [section, categoryName, categoryNameAr, serial].map(norm).join("  ");
  const hay = nameText + "  " + fallbackText;
  const rawName = (name ?? "").trim();

  // 1) SIM — رقم الشريحة موجود، أو الاسم رقم جوال، أو رمز SIM/شريحة
  const msisdn = attrs && readSpecialAttribute({ special_attributes: attrs }, "msisdn");
  if (msisdn != null && String(msisdn).trim() !== "") return "sim";
  if (/^\+?\d[\d\s-]{5,}$/.test(rawName)) return "sim";
  if (has(hay, CLASSIFICATION_TOKENS.sim) || /\bsim\b/.test(hay)) return "sim";

  // 2) Consumable-like — إشارة نوع قوية من أي حقل (يلتقط ريبون/حبر/فيلم باسم ماركة طابعة)
  // «ink» تُطابَق بحدّ كلمة (\bink\b) لا substring، وإلا فإن «TP-LINK» (L-INK) تُصنَّف مستهلكًا خطأً.
  if (/\bink\b/i.test(hay)) return "consumable";
  // «roll» تُطابَق بحدّ كلمة (\broll\b) لا substring، وإلا فإن controller/enrollment/payroll/stroller تُصنَّف مستهلكًا خطأً.
  if (/\broll\b/.test(hay)) return "consumable";
  if (has(hay, CLASSIFICATION_TOKENS.consumable)) return "consumable";
  // Match the material word, not the adjective in «طابعة ورقية».
  if (/(?:^|[^\p{L}])(?:ال)?ورق(?:$|[^\p{L}])/u.test(hay)) return "consumable";
  // «paper» إشارة ضعيفة جدًا: قسم مثل "Printer Paper" مرتبط بطابعات حقيقية (Epson L805 / Canon / HP).
  // لذا نلتقطها من اسم الأصل فقط — لا من القسم/التصنيف — حتى لا تُصنَّف طابعةٌ حقيقية كمستهلك.
  if (/\bpaper\b/.test(nameText)) return "consumable";

  // 3) الاسم أولًا (أوثق إشارة للنوع)، ثم القسم/التصنيف/التسلسلي كاحتياط
  return classifyDevice(nameText) ?? classifyDevice(fallbackText) ?? "other";
}

function isSpecialAttributeObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** يستخرج مدخلات الكشف من كائن الأصل (كما يعود من getAsset أو قائمة الأصول). */
export function getAssetTemplate(asset: {
  name?: string | null;
  serial_number?: string | null;
  category?: { name?: string | null; name_ar?: string | null } | null;
  special_attributes?: unknown;
} | null | undefined): AssetTemplate {
  if (!asset) return TEMPLATES.other;
  const section = readSpecialAttribute(asset, "section");
  const id = getTemplateByCategoryOrSection(
    asset.category?.name,
    asset.category?.name_ar,
    section ?? null,
    asset.name,
    asset.serial_number,
    asset.special_attributes,
  );
  return TEMPLATES[id];
}

export function getTemplateFields(id: TemplateId): TemplateField[] {
  return TEMPLATES[id].fields;
}

// ===========================================================================
//                    قراءة / دمج آمن لـ special_attributes
// ===========================================================================
export function readSpecialAttribute(
  asset: { special_attributes?: unknown } | null | undefined,
  key: string,
): unknown {
  const attributes = asset?.special_attributes;
  return isSpecialAttributeObject(attributes) ? Reflect.get(attributes, key) : undefined;
}

/** دمج سطحي: القيم الجديدة تغلب، ولا يُحذف أي مفتاح قديم لم يُستبدل. */
export function mergeSpecialAttributes(
  oldAttrs: Record<string, unknown> | null | undefined,
  newAttrs: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return { ...(oldAttrs ?? {}), ...(newAttrs ?? {}) };
}

/**
 * يُعيد المفاتيح القديمة التي لا يملكها القالب الحالي (قديمة/مجهولة) لتُحمَل كما هي.
 * تضمن عدم فقدان أي مفتاح غير مُدار عبر الحقول المنظَّمة.
 */
export function preserveUnknownSpecialAttributes(
  oldAttrs: Record<string, unknown> | null | undefined,
  templateId: TemplateId,
): Record<string, unknown> {
  const ownedKeys = new Set(TEMPLATES[templateId].fields.map((f) => f.key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(oldAttrs ?? {})) {
    if (!ownedKeys.has(k)) out[k] = v;
  }
  return out;
}

/** هل هذا المفتاح "غير معروف/قديم" (لا يملكه أي قالب)؟ */
export function isUnknownAttrKey(key: string): boolean {
  return !ALL_TEMPLATE_FIELD_KEYS.has(key);
}

/** تحويل قيمة الحقل من نص الواجهة إلى نوعها المناسب قبل التخزين. */
export function coerceFieldValue(type: FieldType, val: unknown): unknown {
  if (type === "number") {
    if (val === "" || val == null) return undefined;
    const n = Number(val);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === "boolean") {
    return val === true || val === "true";
  }
  if (type === "multiSelect") {
    if (Array.isArray(val)) return val;
    if (typeof val === "string") return val.split(",").map((s) => s.trim()).filter(Boolean);
    return [];
  }
  return val == null ? "" : String(val);
}

/**
 * يبني كائن special_attributes النهائي للحفظ بشكل آمن:
 *   1) يحمل كل مفتاح قديم لا يملكه القالب (قديم/مجهول) كما هو — لا يُحذف أبدًا.
 *   2) يطبّق تعديلات "الحقول الأخرى" (الشبكة العامة) لغير مفاتيح القالب.
 *   3) يطبّق قيم الحقول المنظَّمة للقالب (مع نوعها). تفريغ حقل يحذف مفتاحه،
 *      إلا إن كان مفتاحًا محميًّا (RESERVED) له قيمة قديمة → يُحفظ كما هو.
 */
export function buildSpecialAttributesForSave(
  original: Record<string, unknown> | null | undefined,
  template: AssetTemplate,
  structuredValues: Record<string, unknown>,
  otherRows: { k: string; v: string }[],
): Record<string, unknown> {
  const templateKeys = new Set(template.fields.map((f) => f.key));
  const result: Record<string, unknown> = {};

  // 1) المفاتيح القديمة التي لا يملكها القالب — تُحمَل كما هي
  for (const [k, v] of Object.entries(original ?? {})) {
    if (!templateKeys.has(k)) result[k] = v;
  }

  // 2) صفوف «حقول أخرى» المضافة يدويًا (مفاتيح خارج القالب فقط)
  //    لا تسمح أبدًا باستبدال مفتاح محميّ له قيمة قديمة عبر هذه الشبكة.
  for (const { k, v } of otherRows) {
    const key = k.trim();
    if (!key || templateKeys.has(key)) continue;
    const oldVal = original?.[key];
    if (RESERVED_ATTR_KEYS.has(key) && oldVal != null && String(oldVal).trim() !== "") continue;
    result[key] = v;
  }

  // 3) الحقول المنظَّمة للقالب
  for (const field of template.fields) {
    const raw = structuredValues[field.key];
    const isEmpty = raw == null || raw === "" || (Array.isArray(raw) && raw.length === 0);
    if (!isEmpty) {
      const coerced = coerceFieldValue(field.type, raw);
      if (coerced !== undefined) result[field.key] = coerced;
      // قيمة قديمة لا تُحوَّل لنوع الحقل (مثل printCounter:"N/A") ولم يُعدّلها المستخدم → احفظها كما هي بدل حذفها
      else if (original?.[field.key] != null) result[field.key] = original[field.key];
      else delete result[field.key];
    } else {
      // فارغ: احذف المفتاح، إلا أن يكون محميًّا وله قيمة قديمة غير فارغة
      const oldVal = original?.[field.key];
      if (RESERVED_ATTR_KEYS.has(field.key) && oldVal != null && String(oldVal).trim() !== "") {
        result[field.key] = oldVal;
      } else {
        delete result[field.key];
      }
    }
  }

  return result;
}
