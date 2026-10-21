// تصنيف أخطاء Supabase Auth signUp إلى رمز ثابت تعرضه الواجهة كرسالة مترجمة.
// دالة نقيّة (بلا أي اعتماد على شبكة/عميل) حتى تكون قابلة للاختبار وحدةً.
// لا تُعرض أي تفاصيل خام للمستخدم — الرمز فقط يُترجَم في صفحة /register.

export type SignUpErrorCode =
  | "email_exists" | "email_invalid" | "rate_limit"
  | "weak_password" | "signups_disabled" | "unknown";

export function classifySignUpError(
  message: string | undefined, status: number | undefined, code: string | undefined,
): SignUpErrorCode {
  const m = (message ?? "").toLowerCase();
  const c = (code ?? "").toLowerCase();
  // حد إرسال البريد (429): يظهر عندما يكون "Confirm email" مفعّلًا في Supabase
  // فيُرسَل بريد تحقّق لكل تسجيل حتى يتجاوز حد الخدمة المدمجة.
  if (c === "over_email_send_rate_limit" || status === 429 || /rate limit/.test(m)) return "rate_limit";
  if (c === "user_already_exists" || c === "email_exists" || /already.*(regist|exist)|user already/.test(m)) return "email_exists";
  if (c === "email_address_invalid" || /email address .*invalid|invalid email|is invalid/.test(m)) return "email_invalid";
  if (c === "weak_password" || (status === 422 && /password/.test(m))) return "weak_password";
  if (c === "signup_disabled" || c === "email_provider_disabled" || /signups? (are )?(not allowed|disabled)/.test(m)) return "signups_disabled";
  return "unknown";
}
