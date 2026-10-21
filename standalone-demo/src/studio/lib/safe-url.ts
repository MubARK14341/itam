// تعقيم الروابط الخارجية القادمة من إدخال المستخدم قبل عرضها كـ href.
// يمنع XSS المخزّن عبر مخطّطات خطيرة مثل javascript: / data: / vbscript:
// بالسماح فقط بـ http/https. المدخلات بلا مخطّط أو غير الصالحة تُرفض (تُعرض كنص لا كرابط).
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
}
