import { MAINT_STATUS_TONE, PRIORITY_TONE, STAGE_TONE, toneStyles } from "./tone";
// ثوابت الصيانة المركزية — تُستخدم في: إضافة/تعديل الصيانة، الفلاتر، التقارير، نافذة الصيانة.
// problem_type / workflow_stage / priority كلها حقول نصية (text) في القاعدة — تغيير القيم آمن بلا ENUM.

// ---- نوع المشكلة (problem_type) — خيارات عملية مفهومة للموظف ----
export const PROBLEM_TYPE_OPTS: [string, string][] = [
  ["not_working", "لا يعمل"],
  ["broken", "كسر / تلف"],
  ["missing_parts", "أجزاء ناقصة"],
  ["performance", "ضعف أداء"],
  ["operation", "مشكلة تشغيل"],
  ["printing_scanning", "مشكلة طباعة / مسح"],
  ["charging_battery", "مشكلة شحن / بطارية"],
  ["needs_check", "يحتاج فحص"],
  ["other", "أخرى"],
];
export const DEFAULT_PROBLEM_TYPE = "not_working";

export const PROBLEM_TYPE_AR: Record<string, string> = {
  not_working: "لا يعمل", broken: "كسر / تلف", missing_parts: "أجزاء ناقصة",
  performance: "ضعف أداء", operation: "مشكلة تشغيل", printing_scanning: "مشكلة طباعة / مسح",
  charging_battery: "مشكلة شحن / بطارية", needs_check: "يحتاج فحص", other: "أخرى",
  // قيم قديمة (للعرض فقط إن وُجدت سجلات سابقة) — تُعرض بالعربية المنطقية
  hardware: "عتاد", software: "برمجيات", network: "شبكة", printer: "طابعة", accessory: "ملحقات",
};
export const problemTypeAr = (v: string | null | undefined) => (v ? PROBLEM_TYPE_AR[v] ?? v : "—");

// ---- الأولوية ----
export const PRIORITY_OPTS: [string, string][] = [["low", "منخفضة"], ["medium", "متوسطة"], ["high", "عالية"], ["critical", "حرجة"]];
export const PRIORITY_AR: Record<string, string> = { low: "منخفضة", medium: "متوسطة", high: "عالية", critical: "حرجة" };
export const PRIORITY_STYLE: Record<string, string> = toneStyles(PRIORITY_TONE);

// ---- مرحلة العمل (workflow_stage) ----
export const STAGE_OPTS: [string, string][] = [
  ["open", "مفتوحة"], ["investigating", "قيد الفحص"], ["awaiting_parts", "بانتظار قطع"],
  ["at_vendor", "عند المورد"], ["completed", "مكتملة"], ["unrepairable", "غير قابلة للإصلاح"],
];
export const STAGE_AR: Record<string, string> = {
  open: "مفتوحة", investigating: "قيد الفحص", awaiting_parts: "بانتظار قطع",
  at_vendor: "عند المورد", completed: "مكتملة", unrepairable: "غير قابلة للإصلاح",
};
export const STAGE_STYLE: Record<string, string> = toneStyles(STAGE_TONE);
export const stageAr = (v: string | null | undefined) => (v ? STAGE_AR[v] ?? v : "—");

// ---- نوع الصيانة (type — ENUM في القاعدة: corrective/preventive/inspection) ----
export const MTYPE_OPTS: [string, string][] = [["corrective", "إصلاحية"], ["preventive", "وقائية"], ["inspection", "فحص"]];
export const MTYPE_AR: Record<string, string> = { corrective: "إصلاحية", preventive: "وقائية", inspection: "فحص" };

// ---- الحالة العامة (status — ENUM: open/in_progress/completed/cancelled) ----
export const MAINT_STATUS_AR: Record<string, string> = { open: "مفتوحة", in_progress: "جارية", completed: "مكتملة", cancelled: "ملغاة" };
export const MAINT_STATUS_STYLE: Record<string, string> = toneStyles(MAINT_STATUS_TONE);

// Legacy records remain immutable, but their historical machine values must
// never leak into ordinary operational UI. Unknown future values intentionally
// fall through so they can be noticed and translated rather than mislabelled.
const LEGACY_DISPLAY: Record<"ar" | "en", Record<string, string>> = {
  ar: {
    employee_reported: "بلاغ موظف",
    normal: "عادية",
    reported: "تم الإبلاغ",
    not_ready: "غير جاهز للتسليم",
    ready_for_custody: "جاهز لتسليم العهدة",
    power: "مشكلة طاقة",
    printer: "مشكلة طباعة / مسح",
    network: "مشكلة شبكة",
    display: "مشكلة شاشة",
    battery: "مشكلة بطارية",
  },
  en: {
    employee_reported: "Employee-reported issue",
    normal: "Normal",
    reported: "Reported",
    not_ready: "Not ready for handoff",
    ready_for_custody: "Ready for custody handoff",
    power: "Power issue",
    printer: "Print / scan issue",
    network: "Network issue",
    display: "Display issue",
    battery: "Battery issue",
  },
};

export function maintenanceDisplayLabel(value: string | null | undefined, lang: "ar" | "en", fallback = "—") {
  if (!value) return fallback;
  return LEGACY_DISPLAY[lang][value.trim().toLowerCase()] ?? fallback;
}
