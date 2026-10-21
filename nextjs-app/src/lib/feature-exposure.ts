// =============================================================================
// Feature Exposure — نظام الإظهار التدريجي للواجهة (Phase 1: ثوابت فقط، بلا DB)
// =============================================================================
// طبقة "تجميل/تبسيط" فوق الواجهة فقط: تُخفي عناصر UI حسب مستوى نضج لكل دور.
// ليست نظام أمان إطلاقًا — RBAC (canWrite/canSeeFinancial/...) + RLS + RPC
// تبقى مصدر الحقيقة الوحيد. هذه الدوال تُخفي ولا تمنح أبدًا:
// أي عنصر يظهر هنا يجب أن يظل خلفه فحص الدور القائم كما هو دون أي تعديل.
//
// قواعد غير قابلة للتفاوض (من تقرير الدراسة):
// 1) admin يرى 100% دائمًا.
// 2) المستوى لكل دور (per-role) وليس رقمًا عامًا.
// 3) الحقول/التقارير المالية تبقى محكومة بالدور حصرًا — هذا النظام لا يلمسها
//    (استثناء وحيد مسموح: تأخير تبويب التقرير التنفيذي المالي عن it_manager).
// 4) أدوات الاعتماد لا تُخفى عن admin/it_manager أبدًا (alwaysOnForRoles).
// 5) استثناء الطلب النشط: أزرار دورة طلبٍ غير منتهٍ لا تُخفى أبدًا (activeWorkflowExempt).
// 6) التحذيرات الحرجة (نفاد مخزون/طلب متأخر/صيانة مستحقة/حجب المسح/أخطاء النماذج)
//    لا تُربط بهذا النظام.
// 7) صفحة QR العامة (/a/[token]) خارج النظام كليًا (زائر مجهول بلا جلسة).
// 8) Asset Pools تبقى مخفية بسياسة مستقلة (asset-pools-visibility) — ليست ضمن هذا السجل.
// 9) EXPOSURE_ENABLED=false ⇒ سلوك مطابق تمامًا لليوم.
// 10) عند المستوى 100 ⇒ سلوك مطابق تمامًا لليوم.

import type { Role } from "@/lib/session";

export type ExposureLevel = 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100;

export type KnownRole = Exclude<Role, null>;

export const FEATURE_EXPOSURE_PREVIEW_ROLES: readonly KnownRole[] = [
  "admin", "it_manager", "technician", "warehouse_manager", "auditor", "viewer",
];

// مفتاح الإيقاف الكلي (kill switch): false ⇒ كل شيء ظاهر حسب الدور، مثل اليوم تمامًا.
export const EXPOSURE_ENABLED = true;

// المستويات الافتراضية لكل دور (Phase 1: ثوابت — لا تخزين في DB بعد).
// admin مثبّت على 100 برمجيًا في getExposureLevelForRole بغض النظر عن هذه القيمة.
export const DEFAULT_EXPOSURE_BY_ROLE: Record<KnownRole, ExposureLevel> = {
  admin: 100,
  it_manager: 50,
  // 30 وليس 20: عمل الفني اليومي (إدخال/إخراج المسح، صرف/توريد المستهلكات،
  // تسليم/إرجاع/نقل العُهد) يبدأ من مستوى 30 — انظر تقرير اختبار QA (توصية الإطلاق).
  technician: 30,
  // مدير المستودع: دور تشغيلي (تجهيز/تسليم/إرجاع/فحص) — نفس مستوى الفني.
  warehouse_manager: 30,
  viewer: 20,
  auditor: 20,
  employee: 10,
};

// ملاحظة: publicQr.page مُسجَّل توثيقًا فقط — الصفحة عامة بلا جلسة ولا يُستدعى
// هذا النظام فيها أبدًا. requests.timeline و dashboard.financialKpis و
// assets.depreciation مُسجَّلة بمستوى 10 توثيقًا: الأولى لا تُخفى أبدًا،
// والأخيرتان ماليتان محكومتان بالدور حصرًا (كودها لم يُمس).
export type FeatureKey =
  | "dashboard.basicKpis"
  | "dashboard.financialKpis"
  | "dashboard.advancedKpis"
  | "dashboard.lowStock"
  | "dashboard.advancedFilters"
  | "dashboard.smartAlerts"
  | "dashboard.notificationAlerts"
  | "dashboard.charts.basic"
  | "dashboard.charts.maintenance"
  | "dashboard.tables.recent"
  | "dashboard.activityFeed"
  | "assets.list"
  | "assets.filters"
  | "assets.details.basic"
  | "assets.details.movements"
  | "assets.details.maintenanceTab"
  | "assets.details.assignments"
  | "assets.details.assign"
  | "assets.details.return"
  | "assets.details.move"
  | "assets.details.changeStatus"
  | "assets.details.edit"
  | "assets.add"
  | "assets.import"
  | "assets.documents"
  | "assets.extraDetails"
  | "assets.depreciation"
  | "consumables.list"
  | "consumables.issue"
  | "consumables.supply"
  | "consumables.addEdit"
  | "consumables.details"
  | "consumables.history"
  | "maintenance.list"
  | "maintenance.stats"
  | "maintenance.create"
  | "maintenance.update"
  | "maintenance.vendorFields"
  | "scan.search"
  | "scan.entryExit"
  | "scan.history"
  | "scan.csv"
  | "requests.list"
  | "requests.filters.basic"
  | "requests.filters.advanced"
  | "requests.create"
  | "requests.employeeRequests"
  | "requests.managerApproval"
  | "requests.prepareDeliverReturn"
  | "requests.customers"
  | "requests.csv"
  | "requests.timeline"
  | "requests.attachments"
  | "reports.alerts"
  | "reports.requests"
  | "reports.customerRequests"
  | "reports.assets"
  | "reports.maintenance"
  | "reports.consumables"
  | "reports.custody"
  | "reports.risk"
  | "reports.activity"
  | "reports.executive"
  | "reports.csv"
  | "settings.general"
  | "settings.users"
  | "settings.registration"
  | "settings.suppliers"
  | "settings.companies"
  | "settings.inventory"
  | "settings.depreciation"
  | "settings.notifications"
  | "settings.featureRollout"
  | "settings.permissions"
  | "activity.page"
  | "activity.advancedFilters"
  | "actionCenter.page"
  | "purchaseRequests.page"
  | "publicQr.page";

export interface FeatureRule {
  // أدنى مستوى يظهر عنده العنصر (للأدوار غير المذكورة في minLevelByRole).
  minLevel: ExposureLevel;
  // تخصيص أدنى مستوى لدور معيّن (مثال: activity.page مبكرة للمدير، متأخرة للبقية).
  minLevelByRole?: Partial<Record<KnownRole, ExposureLevel>>;
  // أدوار يظهر لها العنصر دائمًا مهما انخفض مستواها (أدوات الاعتماد للمدراء...).
  alwaysOnForRoles?: KnownRole[];
  // استثناء الطلب النشط: إن كان السجل في حالة غير منتهية، يظهر الإجراء دائمًا.
  activeWorkflowExempt?: boolean;
}

const MANAGERS: KnownRole[] = ["admin", "it_manager"];

export const FEATURES: Record<FeatureKey, FeatureRule> = {
  // ---- Dashboard ----
  "dashboard.basicKpis": { minLevel: 10 },
  // مالي — بالدور حصرًا (canSeeFinancial). مُسجَّل توثيقًا ولا يُستخدم للإخفاء.
  "dashboard.financialKpis": { minLevel: 10 },
  // bad / needsFollowup / criticalAlerts — مفاهيم مخاطر/جودة بيانات متقدمة.
  "dashboard.advancedKpis": { minLevel: 70, alwaysOnForRoles: MANAGERS },
  "dashboard.lowStock": { minLevel: 30, alwaysOnForRoles: MANAGERS },
  "dashboard.advancedFilters": { minLevel: 70, minLevelByRole: { it_manager: 50 } },
  "dashboard.smartAlerts": { minLevel: 60, alwaysOnForRoles: MANAGERS },
  // تنبيهات تشغيلية حرجة: لا تُخفى عن المدراء أبدًا، وتظهر للبقية مع بدء عمليات المخزون.
  "dashboard.notificationAlerts": { minLevel: 30, alwaysOnForRoles: MANAGERS },
  "dashboard.charts.basic": { minLevel: 30 },
  "dashboard.charts.maintenance": { minLevel: 60 },
  "dashboard.tables.recent": { minLevel: 20 },
  "dashboard.activityFeed": { minLevel: 90, minLevelByRole: { it_manager: 50 } },

  // ---- Assets ----
  "assets.list": { minLevel: 10 },
  "assets.filters": { minLevel: 20 },
  "assets.details.basic": { minLevel: 10 },
  "assets.details.movements": { minLevel: 20 },
  "assets.details.maintenanceTab": { minLevel: 30 },
  "assets.details.assignments": { minLevel: 30 },
  "assets.details.assign": { minLevel: 30 },
  "assets.details.return": { minLevel: 30 },
  "assets.details.move": { minLevel: 30 },
  "assets.details.changeStatus": { minLevel: 40 },
  "assets.details.edit": { minLevel: 40 },
  "assets.add": { minLevel: 50 },
  // استيراد CSV — عملية إدارية قوية؛ تظهر للمدراء (مثل assets.add). الأمان في RPC + الدور.
  "assets.import": { minLevel: 50, alwaysOnForRoles: MANAGERS },
  "assets.documents": { minLevel: 50 },
  "assets.extraDetails": { minLevel: 50 },
  // مالي — بالدور حصرًا (canSeeFinancial). توثيقي، غير مستخدم للإخفاء.
  "assets.depreciation": { minLevel: 10 },

  // ---- Consumables ----
  "consumables.list": { minLevel: 30 },
  "consumables.issue": { minLevel: 30 },
  "consumables.supply": { minLevel: 30 },
  "consumables.addEdit": { minLevel: 50 },
  // 30 وليس 50: قائمة المستهلكات تربط مباشرة لصفحة التفاصيل — إخفاؤها يكسر الرابط.
  "consumables.details": { minLevel: 30 },
  "consumables.history": { minLevel: 50 },

  // ---- Maintenance ----
  "maintenance.list": { minLevel: 30 },
  "maintenance.stats": { minLevel: 60 },
  "maintenance.create": { minLevel: 60 },
  "maintenance.update": { minLevel: 60 },
  "maintenance.vendorFields": { minLevel: 60 },

  // ---- Scan ----
  "scan.search": { minLevel: 20 },
  "scan.entryExit": { minLevel: 30 },
  "scan.history": { minLevel: 40 },
  "scan.csv": { minLevel: 70 },

  // ---- Requests ----
  // لا تُخفى الطلبات عن المدراء أبدًا (أدوات الاعتماد — قاعدة 4).
  // الطلبات هي البيت التشغيلي لمهام المستودع: تظهر للدورين التشغيليين (فني/مدير مستودع)
  // من مستواهما 30 — بلا تغيير مستوى أي دور آخر (viewer/auditor عند 20 يبقيان محجوبين).
  "requests.list": { minLevel: 40, alwaysOnForRoles: MANAGERS, minLevelByRole: { technician: 30, warehouse_manager: 30 } },
  "requests.filters.basic": { minLevel: 40, alwaysOnForRoles: MANAGERS },
  "requests.filters.advanced": { minLevel: 50 },
  "requests.create": { minLevel: 40, alwaysOnForRoles: MANAGERS },
  // خيار «موظف / طلب داخلي» في نموذج الإنشاء (عهدة) — كنفس ظهور الإنشاء.
  "requests.employeeRequests": { minLevel: 40, alwaysOnForRoles: MANAGERS },
  // بالدور حصرًا (isManager) — دائمة الظهور لمن يملكها.
  "requests.managerApproval": { minLevel: 10, alwaysOnForRoles: MANAGERS },
  // أزرار دورة الطلب: معفاة كليًا على أي طلب غير منتهٍ (استثناء الطلب النشط).
  "requests.prepareDeliverReturn": { minLevel: 50, activeWorkflowExempt: true },
  "requests.customers": { minLevel: 40, alwaysOnForRoles: MANAGERS },
  "requests.csv": { minLevel: 70 },
  // حالة الطلب وخطه الزمني لا يُخفيان أبدًا — توثيقي.
  "requests.timeline": { minLevel: 10 },
  // تبويب مرفقات الطلب الداخلي — كنفس ظهور قائمة الطلبات (المدراء دائمًا). البوابة خارج النظام.
  "requests.attachments": { minLevel: 40, alwaysOnForRoles: MANAGERS },

  // ---- Reports ----
  "reports.alerts": { minLevel: 70 },
  "reports.requests": { minLevel: 70, alwaysOnForRoles: MANAGERS },
  // تبويب تحليلات طلبات العملاء — إظهار كبقية تبويبات التقارير؛ إضافةً لحارس القدرة report.customer_requests في الصفحة.
  "reports.customerRequests": { minLevel: 70 },
  "reports.assets": { minLevel: 70, alwaysOnForRoles: MANAGERS },
  "reports.maintenance": { minLevel: 70, alwaysOnForRoles: MANAGERS },
  "reports.consumables": { minLevel: 70 },
  "reports.custody": { minLevel: 70, alwaysOnForRoles: MANAGERS },
  "reports.risk": { minLevel: 70 },
  "reports.activity": { minLevel: 90 },
  // مالي بالأساس — الدور (canSeeFinancial) يبقى الحاكم داخل الصفحة كما هو؛
  // المستوى هنا يؤخّره فقط عن it_manager (الاستثناء الوحيد المسموح للمالية).
  "reports.executive": { minLevel: 90, alwaysOnForRoles: MANAGERS },
  "reports.csv": { minLevel: 70, alwaysOnForRoles: MANAGERS },

  // ---- Settings (الوصول للصفحة كلها admin/it_manager بالكود — لا يتغير) ----
  "settings.general": { minLevel: 10 },
  "settings.users": { minLevel: 80 },
  // طلبات التسجيل (قبول/رفض الحسابات) جزء من دورة اعتماد المدير الأساسية؛
  // تظل الكتابة محكومة بـ RLS/RPC، لكن لا يجوز أن تختفي عند مستوى العرض الافتراضي للمدير.
  "settings.registration": { minLevel: 80, alwaysOnForRoles: MANAGERS },
  "settings.suppliers": { minLevel: 80 },
  "settings.companies": { minLevel: 80 },
  // القيم الافتراضية للمخزون — تبويب إداري فعّال (كبقية تبويبات الإدارة، 80).
  "settings.inventory": { minLevel: 80 },
  "settings.depreciation": { minLevel: 90 },
  // البريد التشغيلي وإرساله التجريبي مساران مديريان محكومان أيضًا بـ RPC؛
  // إبقاؤهما ظاهرين للمدير يمنع تعارض الواجهة مع سياسة القاعدة.
  "settings.notifications": { minLevel: 60, alwaysOnForRoles: MANAGERS },
  // تبويب التحكم بالنسبة نفسه — admin فقط (فلترة isAdmin في صفحة الإعدادات هي الحاكم الفعلي).
  "settings.featureRollout": { minLevel: 10, alwaysOnForRoles: ["admin"] },
  // مصفوفة الصلاحيات التفصيلية — admin فقط (فلترة isAdmin في الصفحة + RPCs admin-only).
  "settings.permissions": { minLevel: 10, alwaysOnForRoles: ["admin"] },

  // ---- Activity ----
  "activity.page": { minLevel: 90, minLevelByRole: { it_manager: 50 } },
  "activity.advancedFilters": { minLevel: 90 },

  // ---- Action Center + Purchase Requests ----
  // متابعة تشغيلية: تبدأ مع العمل اليومي (30). المدراء يرونها دائمًا (أدوات متابعة).
  "actionCenter.page": { minLevel: 30, alwaysOnForRoles: MANAGERS },
  "purchaseRequests.page": { minLevel: 30, alwaysOnForRoles: MANAGERS },

  // ---- Public QR: خارج النظام كليًا (توثيقي فقط — لا يُستدعى في الصفحة العامة) ----
  "publicQr.page": { minLevel: 10 },
};

// تبويبات التقارير — تُستخدم لإظهار عنصر Reports في الشريط الجانبي إذا ظهر أي تبويب.
export const REPORT_TAB_FEATURE_KEYS: FeatureKey[] = [
  "reports.executive",
  "reports.alerts",
  "reports.requests",
  "reports.customerRequests",
  "reports.assets",
  "reports.maintenance",
  "reports.consumables",
  "reports.custody",
  "reports.risk",
  "reports.activity",
];

// الحالات المنتهية للطلب — كل ما عداها يعتبر «طلبًا نشطًا» تُعفى أزراره من الإخفاء.
const TERMINAL_REQUEST_STATUSES = new Set(["completed", "cancelled", "rejected"]);

export interface FeatureVisibilityContext {
  // حالة الطلب الحالية عند تقييم أزرار دورة الطلب.
  requestStatus?: string | null;
}

export interface FeatureVisibilityOptions {
  // تمرير مستوى صريح (وضع المعاينة). عند غيابه يُستنتج من الدور.
  level?: ExposureLevel;
  context?: FeatureVisibilityContext;
}

// admin يرى 100% دائمًا — الدالة المرجعية الوحيدة لمستوى الدور.
export function getExposureLevelForRole(role: Role): ExposureLevel {
  if (role === "admin") return 100;
  if (!role) return 10; // بلا دور فعّال (غير معتمد): أدنى مستوى — RLS يحجب البيانات أصلًا.
  return DEFAULT_EXPOSURE_BY_ROLE[role] ?? 10;
}

// helper: هل هذا الدور يتجاوز النظام كليًا؟ (admin override)
export function isAdminFullExposure(role: Role): boolean {
  return role === "admin";
}

// helper: هل هذا المستوى يعني «النظام الكامل كما هو اليوم»؟
export function isFullExposure(level: ExposureLevel): boolean {
  return level >= 100;
}

// استثناء الطلب النشط: الإجراء المعفى يظهر دائمًا ما دام السجل في حالة غير منتهية.
export function isActiveWorkflowExempt(
  featureKey: FeatureKey,
  context?: FeatureVisibilityContext,
): boolean {
  const rule = FEATURES[featureKey];
  if (!rule?.activeWorkflowExempt) return false;
  const status = context?.requestStatus;
  return typeof status === "string" && status.length > 0 && !TERMINAL_REQUEST_STATUSES.has(status);
}

// عدّ الميزات التي «تنفتح لأول مرة» عند كل مستوى لدور معيّن (لشارات الخط الزمني في الإعدادات).
// دالة نقية: alwaysOnForRoles تُحسب عند 10 (مفتوحة منذ البداية لذلك الدور)،
// و minLevelByRole يقدَّم على minLevel — نفس منطق isFeatureVisible تمامًا.
export function getUnlockCountsByLevel(role: KnownRole = "technician"): Record<ExposureLevel, number> {
  const counts: Record<ExposureLevel, number> = {
    10: 0, 20: 0, 30: 0, 40: 0, 50: 0, 60: 0, 70: 0, 80: 0, 90: 0, 100: 0,
  };
  for (const rule of Object.values(FEATURES)) {
    const min: ExposureLevel = rule.alwaysOnForRoles?.includes(role)
      ? 10
      : (rule.minLevelByRole?.[role] ?? rule.minLevel);
    counts[min] += 1;
  }
  return counts;
}

// الدالة المركزية: «هل يُعرض هذا العنصر؟» — تُخفي فقط ولا تمنح صلاحية أبدًا.
// يجب أن تبقى فحوص الدور القائمة (canWrite/canSeeFinancial/...) قبلها أو بعدها كما هي.
export function isFeatureVisible(
  featureKey: FeatureKey,
  role: Role,
  options?: FeatureVisibilityOptions,
): boolean {
  // kill switch ⇒ كل شيء ظاهر (حسب الدور فقط) — مطابق لسلوك اليوم.
  if (!EXPOSURE_ENABLED) return true;

  const rule = FEATURES[featureKey];
  // مفتاح غير معروف (نظريًا مستحيل مع union type): نُظهر — الإخفاء الخاطئ أخطر من الإظهار.
  if (!rule) return true;

  const level = options?.level ?? getExposureLevelForRole(role);

  // المستوى 100 ⇒ مطابق لليوم (admin يصل هنا دائمًا عبر getExposureLevelForRole).
  if (isFullExposure(level)) return true;

  if (role && rule.alwaysOnForRoles?.includes(role)) return true;

  if (isActiveWorkflowExempt(featureKey, options?.context)) return true;

  const min = (role && rule.minLevelByRole?.[role]) ?? rule.minLevel;
  return level >= min;
}
