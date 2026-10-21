// إخفاء المواقع القديمة «الفرع 1 / الفرع 2» من كل القوائم في الواجهة.
// لا نحذفها من القاعدة (لا DELETE) — فلترة عرض آمنة فقط.
// المطابقة بالـ code (BR1/BR2) أولًا، ثم بالاسم احتياطًا لأي بيانات مشابهة.
export const HIDDEN_LOCATION_CODES = ["BR1", "BR2"];
const HIDDEN_NAME_PATTERNS = ["الفرع 1", "الفرع 2", "branch 1", "branch 2"];

type LocLike = { code?: string | null; name?: string | null; name_ar?: string | null };

export function isVisibleLocation(l: LocLike | null | undefined): boolean {
  if (!l) return false;
  if (l.code && HIDDEN_LOCATION_CODES.includes(l.code)) return false;
  const hay = `${l.name_ar ?? ""} ${l.name ?? ""}`.trim().toLowerCase();
  return !HIDDEN_NAME_PATTERNS.some((p) => hay.includes(p));
}

export function visibleLocations<T extends LocLike>(arr: T[] | null | undefined): T[] {
  return (arr ?? []).filter(isVisibleLocation);
}
