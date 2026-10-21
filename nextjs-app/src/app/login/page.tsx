"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Eye, EyeOff, UserPlus, ArrowRight, Building2, Users, ShieldCheck } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { inputClass } from "@/components/ui/form";
import { createClient } from "@/lib/supabase/client";
import { getRegistrationStatus, getMyAccountStatus } from "@/lib/queries";
import { getPortalContext } from "@/lib/portal";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { CaptchaField } from "@/components/auth/captcha-field";
import { AuthBrand, AuthHero, AuthPrefs } from "@/components/auth/auth-chrome";
import { recordAuthSecurityEvent } from "@/lib/auth-security";

export default function LoginPage() {
  const { t, lang } = useAppPreferences();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  // اختيار جهة الدخول: موظف/إدارة أو عميل (يغيّر رابط التسجيل والعنوان — التوجيه بعد الدخول تلقائي)
  const [mode, setMode] = useState<"employee" | "customer">("employee");

  // Load the setting to retain its public availability check, but always show
  // the clear account-creation action.  The registration page explains a
  // closed window instead of making employees hunt for an administrator.
  useEffect(() => { void getRegistrationStatus(); }, []);
  useEffect(() => { setHydrated(true); }, []);

  // فتح تبويب «عميل» مباشرة عند القدوم من تسجيل العميل (?mode=customer). قراءة من window فقط
  // (بلا useSearchParams) لتفادي متطلّب Suspense في البناء. لا يؤثّر على منطق المصادقة إطلاقًا.
  useEffect(() => {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mode") === "customer") {
      setMode("customer");
    }
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
      options: { captchaToken: captchaToken ?? undefined },
    });
    if (error) {
      setLoading(false);
      // رسالة موحّدة: لا تكشف هل الحساب موجود أو مؤكد أو محظور.
      setError(t.auth.error);
      return;
    }
    await recordAuthSecurityEvent(supabase, "login_succeeded");
    // بوابة العميل أولًا: مستخدم بوابة (لا سجل app_users) → /client-portal
    const portal = await getPortalContext();
    if (portal) {
      window.location.replace("/client-portal");
      return;
    }
    // توجيه الموظفين حسب حالة الموافقة: غير المعتمد → صفحة الانتظار
    const status = await getMyAccountStatus();
    if (status && status.approval_status !== "approved") {
      window.location.replace("/pending-approval");
      return;
    }
    // A new document reads the committed session cookies and discards the old identity's client caches.
    window.location.replace("/dashboard");
  }

  const customer = mode === "customer";
  const segItem = "ui-seg-item justify-center gap-2 max-md:min-h-11 md:min-h-9";

  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-[1440px] gap-5 bg-canvas p-4 sm:p-7 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,.92fr)]">
      <div className="flex min-w-0 flex-col rounded-[22px] bg-surface px-5 py-5 sm:px-10 sm:py-7">
        {/* الهوية + تبديل اللغة والثيم — متاح قبل تسجيل الدخول */}
        <div className="flex items-center justify-between gap-3">
          <AuthBrand />
          <AuthPrefs />
        </div>

        <div className="flex flex-1 flex-col justify-center py-6 sm:py-8">
          <div className="mx-auto w-full max-w-[420px]">
            <h1 className="font-display text-[28px] font-semibold leading-[1.4] text-fg sm:text-[32px]">{t.auth.signIn}</h1>
            <p className="mt-1.5 text-sm text-muted">{customer ? t.auth.introCustomer : t.auth.introEmployee}</p>

            {/* اختيار جهة الدخول */}
            <div className="ui-seg mt-5 grid w-full grid-cols-2" role="group" aria-label={t.auth.title}>
              <button type="button" onClick={() => setMode("employee")} aria-pressed={mode === "employee"} className={segItem}>
                <Building2 aria-hidden="true" className="h-4 w-4" />{t.auth.tabEmployee}
              </button>
              <button type="button" onClick={() => setMode("customer")} aria-pressed={mode === "customer"} className={segItem}>
                <Users aria-hidden="true" className="h-4 w-4" />{t.auth.tabCustomer}
              </button>
            </div>

            <form
              method="post"
              action="/login"
              noValidate
              aria-busy={loading}
              onSubmit={onSubmit}
              className="mt-5 space-y-4"
            >
              <div>
                <label htmlFor="login-email" className="ui-label">{t.auth.email}</label>
                <input
                  id="login-email" name="email" autoComplete="username"
                  type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                  className={`${inputClass} md:min-h-11`}
                  placeholder={customer ? "demo@example.invalid" : "demo@example.invalid"} dir="ltr"
                />
              </div>
              <div>
                <label htmlFor="login-password" className="ui-label">{t.auth.password}</label>
                <div className="relative">
                  <input
                    id="login-password" name="password" autoComplete="current-password"
                    type={showPassword ? "text" : "password"} required value={password} onChange={(e) => setPassword(e.target.value)}
                    className={`${inputClass} md:min-h-11 ${lang === "ar" ? "ps-11" : "pe-11"}`}
                    placeholder="••••••••" dir="ltr"
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? t.auth.hidePassword : t.auth.showPassword}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((visible) => !visible)}
                    className="absolute inset-y-0 end-0 inline-flex w-11 items-center justify-center rounded-e-control text-muted transition-colors hover:bg-sunk hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                  >
                    {showPassword ? <EyeOff aria-hidden="true" className="h-[17px] w-[17px]" /> : <Eye aria-hidden="true" className="h-[17px] w-[17px]" />}
                  </button>
                </div>
              </div>

              {error && (
                <div role="alert" aria-live="polite" className="rounded-control bg-bad-soft px-3 py-2.5 text-sm font-medium text-bad">{error}</div>
              )}
              <CaptchaField action="login" onToken={setCaptchaToken} />

              <Button
                type="submit" disabled={!hydrated || loading}
                className="h-12 w-full text-[15px] font-semibold"
              >
                {loading ? t.auth.signingIn : t.auth.signIn}<ArrowRight aria-hidden="true" className="rtl:rotate-180" />
              </Button>
            </form>

            <div className="mt-5 flex items-center gap-3 text-[12.5px] text-muted">
              <span aria-hidden="true" className="h-px flex-1 bg-line" />
              {t.auth.noAccount}
              <span aria-hidden="true" className="h-px flex-1 bg-line" />
            </div>

            {/* رابط التسجيل حسب الجهة: عميل جديد (مفتوح) أو موظف (إن كان التسجيل مفتوحًا) */}
            {customer ? (
              <Link href="/client-portal-register" prefetch={false} className={buttonClass("outline", "md", "mt-4 min-h-11 w-full")}>
                <UserPlus aria-hidden="true" /> {t.auth.customerRegister}
              </Link>
            ) : (
              <Link href="/register" prefetch={false} className={buttonClass("outline", "md", "mt-4 min-h-11 w-full")}>
                <UserPlus aria-hidden="true" /> {t.auth.createAccount}
              </Link>
            )}

            <p className="mt-5 flex items-start gap-2 text-[12.5px] leading-relaxed text-muted">
              <ShieldCheck aria-hidden="true" className="mt-0.5 h-[15px] w-[15px] shrink-0" />
              {customer ? t.auth.securityCustomer : t.auth.securityEmployee}
            </p>
          </div>
        </div>

        <p className="text-[12.5px] text-muted">{t.auth.title}</p>
      </div>

      <AuthHero
        label={t.auth.heroLabel}
        chip={t.auth.title}
        title={t.auth.workspaceTitle}
        description={t.auth.workspaceDescription}
        features={[]}
      />
    </main>
  );
}
