import {
  LayoutDashboard, Boxes, BarChart3, ScanLine, Settings, ClipboardList, BellRing, ClipboardCheck, Laptop, Wrench, ListChecks,
} from "lucide-react";
import type { Role } from "@/lib/session";
import type { Dict } from "@/lib/i18n";
import { REPORT_TAB_FEATURE_KEYS, type FeatureKey } from "@/lib/feature-exposure";
import { userFacingRole } from "@/lib/user-facing-role";

// labelKey يشير إلى نصوص القائمة فقط (يستثني كائن sections المتداخل).
export type NavKey = Exclude<keyof Dict["nav"], "sections">;
export type SectionKey = keyof Dict["nav"]["sections"];
// قائمة مبسّطة للمدير: المستهلكات تُدار من داخل «الأصول»؛ الصيانة وآخر العمليات من داخل «التقارير».
// الصفحات القديمة (/consumables /maintenance /activity) تبقى شغّالة لكنها لا تظهر كعناصر مستقلة.
// activeFor يحافظ على إبراز العنصر الصحيح عند زيارة تلك المسارات المخفية.
// feature: مفتاح الإظهار التدريجي (طبقة عرض فقط — roles/RLS تبقى الحاكم).
// عنصر «التقارير» يظهر إذا ظهر أي تبويب تقارير (reportsAny).
// section: تجميع بصري حسب طبيعة العمل (عرض فقط — لا يغيّر الأدوار/الصلاحيات).
// count: شارة عدّ اختيارية (مركز الإجراءات / الطلبات) — زخرفة فقط.
export type NavItem = {
  href: string; labelKey: NavKey; icon: typeof LayoutDashboard;
  section?: SectionKey; roles?: Role[]; activeFor?: string[]; feature?: FeatureKey; reportsAny?: boolean;
  count?: "actions" | "requests";
};
export const NAV: NavItem[] = [
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboard },
  // مركز الإجراءات: متابعة التنبيهات وإسنادها — طلبات الشراء تُفتح من داخله ومن قوائم العمل.
  { href: "/alerts", labelKey: "actionCenter", icon: BellRing, section: "operations", activeFor: ["/purchase-requests"], feature: "actionCenter.page", count: "actions" },
  // الطلبات صارت أساس المشروع وهي البيت التشغيلي لمهام المستودع (منظور /requests?view=warehouse).
  // متاحة لكل مستخدم معتمد (RLS يحكم الكتابة)؛ activeFor يُبرزها أيضًا عند مسار /warehouse المُحوَّل.
  { href: "/requests", labelKey: "requests", icon: ClipboardList, section: "operations", activeFor: ["/customers", "/warehouse"], feature: "requests.list", count: "requests" },
  // أُزيل عنصر «مهام المستودع» المستقل: صار منظورًا داخل الطلبات (/requests?view=warehouse) لإزالة التكرار.
  { href: "/assets", labelKey: "assets", icon: Boxes, section: "inventory", activeFor: ["/consumables"], feature: "assets.list" },
  { href: "/scan", labelKey: "scan", icon: ScanLine, section: "inventory", feature: "scan.search" },
  { href: "/stocktakes", labelKey: "stocktakes", icon: ClipboardCheck, section: "inventory", roles: ["admin", "it_manager", "technician", "warehouse_manager"] },
  { href: "/reports", labelKey: "reports", icon: BarChart3, section: "insights", activeFor: ["/maintenance", "/activity"], reportsAny: true },
  { href: "/settings", labelKey: "settings", icon: Settings, section: "system", roles: ["admin", "it_manager"] },
];
export const EMPLOYEE_NAV: NavItem[] = [
  { href: "/my-tasks", labelKey: "dailyTasks", icon: ListChecks },
  { href: "/my-requests", labelKey: "myRequests", icon: ClipboardList },
  { href: "/my-assets", labelKey: "myAssets", icon: Laptop },
];
export const WAREHOUSE_NAV: NavItem[] = [
  { href: "/my-tasks", labelKey: "dailyTasks", icon: ListChecks },
  { href: "/requests?view=warehouse", labelKey: "requests", icon: ClipboardList, section: "operations" },
  { href: "/maintenance", labelKey: "maintenance", icon: Wrench, section: "operations" },
  { href: "/scan", labelKey: "scan", icon: ScanLine, section: "operations" },
  { href: "/stocktakes", labelKey: "stocktakes", icon: ClipboardCheck, section: "inventory" },
  { href: "/assets", labelKey: "assets", icon: Boxes, section: "inventory" },
  { href: "/consumables", labelKey: "consumables", icon: Boxes, section: "inventory" },
];
export const VIEWER_NAV: NavItem[] = [
  { href: "/overview", labelKey: "overview", icon: LayoutDashboard },
  { href: "/assets", labelKey: "assets", icon: Boxes },
  { href: "/reports", labelKey: "reports", icon: BarChart3 },
];

// ترتيب عرض الأقسام تحت لوحة المعلومات (العناصر بلا قسم تظهر أولًا بلا عنوان).
export const SECTION_ORDER: SectionKey[] = ["operations", "inventory", "insights", "system"];

/** Nav items the role may see (roles + progressive exposure). Presentation only — RLS stays the authority. */
export function visibleNav(role: Role, isVisible: (key: FeatureKey) => boolean): NavItem[] {
  const exposureAllows = (item: NavItem) => {
    if (item.reportsAny) return REPORT_TAB_FEATURE_KEYS.some((k) => isVisible(k));
    return !item.feature || isVisible(item.feature);
  };
  const allowed = (item: NavItem) =>
    (!item.roles || (role != null && item.roles.includes(role))) && exposureAllows(item);
  const presentationRole = userFacingRole(role);
  return presentationRole === "office_employee"
    ? EMPLOYEE_NAV
    : presentationRole === "warehouse_employee"
      ? WAREHOUSE_NAV.filter(allowed)
      : presentationRole === "viewer"
        ? VIEWER_NAV.filter(allowed)
        : NAV.filter(allowed);
}

// المسارات التي تحمل منظورًا تشغيليًا في query (مثل /requests?view=warehouse)
// يجب أن تبقى مفعّلة بصريًا وفق pathname؛ لا يغيّر ذلك الوصول أو البيانات.
export function isNavActive(item: NavItem, pathname: string): boolean {
  const matchHref = (h: string) => {
    const targetPath = h.split("?", 1)[0];
    return pathname === targetPath || pathname.startsWith(targetPath + "/");
  };
  return matchHref(item.href) || (item.activeFor?.some(matchHref) ?? false);
}

export function initialsFromEmail(email: string | null): string {
  const local = (email ?? "").split("@", 1)[0].replace(/[^a-zA-Z]/g, "");
  return (local.slice(0, 2) || "—").toUpperCase();
}
