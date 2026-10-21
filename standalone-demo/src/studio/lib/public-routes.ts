// المصدر الوحيد للمسارات العامة (بدون جلسة): تسجيل الدخول + إنشاء حساب + بطاقة QR العامة
// ونقاط الرصد وسياسة عناكب البحث التي يجب أن تعمل قبل إنشاء جلسة.
// مطابقة على حدود المقاطع (segment-boundary) حتى لا يُعتبر مثل /loginX أو /registration عامًا.
const PUBLIC_EXACT_PATHS = new Set(["/robots.txt"]);

const PUBLIC_PREFIXES = [
  "/login",
  "/register",
  "/a",
  "/client-portal-register",
  "/api/health/schema",
  "/api/csp-report",
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT_PATHS.has(pathname)
    || PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}
