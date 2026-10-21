"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, ArrowRight, Building2, PackageCheck, KeyRound, Ticket } from "lucide-react";
import { Field, inputClass } from "@/components/ui/form";
import { Button, buttonClass } from "@/components/ui/button";
import { portalSelfRegister } from "@/lib/portal";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { MIN_PASSWORD_LENGTH, passwordPolicyError } from "@/lib/password-policy";
import { CaptchaField } from "@/components/auth/captcha-field";
import { AuthHero, HeroFlow } from "@/components/auth/auth-chrome";
import { PasswordStrength } from "@/components/auth/password-strength";
import { RegisterNotice, RegisterShell, RegisterTypeSwitch } from "@/components/auth/register-layout";

type Phase = "form" | "done";

export default function ClientPortalRegisterPage() {
  const { t } = useAppPreferences();
  const tr = t.portal.register;

  const [phase, setPhase] = useState<Phase>("form");
  const [f, setF] = useState({ full_name: "", company_name: "", city: "", email: "", password: "", phone: "", code: "" });
  type FieldErrors = { full_name?: string; email?: string; phone?: string; password?: string };
  const [errors, setErrors] = useState<FieldErrors>({});
  const set = (k: keyof typeof f) => (v: string) => {
    setF((s) => ({ ...s, [k]: v }));
    // امسح خطأ الحقل عند الكتابة فيه فقط (بقية القيم لا تُمسّ).
    if (k === "full_name" || k === "email" || k === "phone" || k === "password") {
      setErrors((e) => ({ ...e, [k]: undefined }));
    }
  };
  const [showCode, setShowCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [doneMsg, setDoneMsg] = useState("");
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);

  // تحقّق واجهة فقط — ليس إلزامًا أمنيًا ولا قيدًا في القاعدة (انظر التقرير: يمكن تجاوزه باستدعاء مباشر).
  // الجوال دولي متساهل: «+» اختيارية ثم 7–15 رقمًا بعد إزالة الفواصل الشائعة. لا صيغة سعودية مفروضة.
  // المسافات تُقلَّم؛ قيمة من مسافات فقط = فارغة = خطأ. القيم المُدخلة لا تُمسح عند الفشل (محفوظة في f).
  function validate(): FieldErrors {
    const e: FieldErrors = {};
    if (!f.full_name.trim()) e.full_name = tr.errName;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = tr.errEmail;
    const phoneDigits = f.phone.trim().replace(/[\s().\-]/g, "");
    if (!/^\+?\d{7,15}$/.test(phoneDigits)) e.phone = tr.errPhone;
    if (passwordPolicyError(f.password)) e.password = tr.errPassword;
    return e;
  }

  async function createAccount() {
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setLoading(true); setError(null);
    const { error, needsEmailVerification, pending } = await portalSelfRegister({
      email: f.email.trim(), password: f.password, full_name: f.full_name.trim(), phone: f.phone.trim() || null,
      company_name: f.company_name.trim() || null, city: f.city.trim() || null, code: f.code.trim() || null,
      captcha_token: captchaToken,
    });
    setLoading(false);
    if (error) { setError(tr.error); return; }
    setDoneMsg(pending ? tr.donePending : (needsEmailVerification ? tr.doneVerify : tr.doneReady));
    setPhase("done");
  }

  const hero = (
    <AuthHero
      label={tr.heroLabel}
      chip={t.portal.appName}
      title={<><span className="block">{tr.heroTitleA}</span><span className="block">{tr.heroTitleB}</span></>}
      description={tr.heroDesc}
      features={[
        { icon: Building2, title: tr.featIsolation, desc: tr.featIsolationDesc },
        { icon: PackageCheck, title: tr.featTracking, desc: tr.featTrackingDesc },
        { icon: KeyRound, title: t.registration.featSecurity, desc: t.registration.featSecurityDesc.replace("{n}", String(MIN_PASSWORD_LENGTH)) },
      ]}
    >
      <HeroFlow
        title={tr.flowTitle}
        stepLabel={t.registration.flowStepOf.replace("{n}", "1").replace("{total}", "3")}
        steps={[
          { title: tr.stepCreate, desc: tr.stepCreateDesc },
          { title: tr.stepLink, desc: tr.stepLinkDesc },
          { title: tr.stepRequest, desc: tr.stepRequestDesc },
        ]}
      />
    </AuthHero>
  );

  return (
    <RegisterShell hero={hero}>
      <h1 className="font-display text-[28px] font-semibold leading-[1.4] text-fg sm:text-[32px]">{tr.title}</h1>
      <p className="mt-1 text-sm text-muted">{tr.subtitle}</p>

      <RegisterTypeSwitch active="customer" />

      {phase === "done" ? (
        <RegisterNotice icon={<CheckCircle2 aria-hidden="true" className="h-6 w-6" />} tone="ok">
          <p className="mt-1.5 text-sm text-fg-2">{doneMsg}</p>
          <Link href="/login?mode=customer" className={buttonClass("primary", "md", "mt-4")}>{tr.haveAccount}</Link>
        </RegisterNotice>
      ) : (
        <div className="mt-5 space-y-3.5">
          <div className="grid gap-x-3.5 gap-y-3 sm:grid-cols-2">
            <Field label={tr.fullName} required error={errors.full_name}><input className={inputClass} value={f.full_name} onChange={(e) => set("full_name")(e.target.value)} autoComplete="name" /></Field>
            <Field label={tr.phone} required error={errors.phone}><input className={inputClass} value={f.phone} onChange={(e) => set("phone")(e.target.value)} dir="ltr" inputMode="tel" placeholder="+966 5x xxx xxxx" autoComplete="tel" /></Field>
            <Field label={tr.companyName}><input className={inputClass} value={f.company_name} onChange={(e) => set("company_name")(e.target.value)} autoComplete="organization" /></Field>
            <Field label={tr.city}><input className={inputClass} value={f.city} onChange={(e) => set("city")(e.target.value)} /></Field>
            <Field label={tr.email} required error={errors.email}><input className={inputClass} type="email" value={f.email} onChange={(e) => set("email")(e.target.value)} dir="ltr" placeholder="demo@example.invalid" autoComplete="email" /></Field>
            <Field label={tr.password} required error={errors.password}><input className={inputClass} type="password" value={f.password} onChange={(e) => set("password")(e.target.value)} dir="ltr" placeholder="••••••••••••" autoComplete="new-password" aria-describedby="portal-password-strength" /></Field>
            <div className="sm:col-span-2">
              <PasswordStrength id="portal-password-strength" password={f.password} />
            </div>
            <div className="sm:col-span-2">
              {showCode ? (
                <Field label={tr.code}><input className={`${inputClass} font-mono`} value={f.code} onChange={(e) => set("code")(e.target.value)} dir="ltr" autoCapitalize="characters" /></Field>
              ) : (
                <button type="button" onClick={() => setShowCode(true)} aria-expanded={false}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg text-[13px] font-semibold text-brand-ink hover:underline max-md:min-h-11">
                  <Ticket aria-hidden="true" className="h-4 w-4" />{tr.haveCode}
                </button>
              )}
            </div>
          </div>
          <CaptchaField action="portal_signup" onToken={setCaptchaToken} />
          {error && <p role="alert" className="rounded-control bg-bad-soft px-3 py-2.5 text-sm font-medium text-bad">{error}</p>}
          {/* لا نعطّل الزر على الحقول الفارغة: الإرسال الفارغ يجب أن يُظهر أخطاء الحقول الواضحة. */}
          <Button className="h-12 w-full text-[15px] font-semibold" disabled={loading} onClick={createAccount}>
            {loading ? tr.creating : tr.createAccount}<ArrowRight aria-hidden="true" className="rtl:rotate-180" />
          </Button>
        </div>
      )}

      {/* رابط الدخول يظهر في طور النموذج فقط — في طور النجاح يُعرض رابط واحد داخل بطاقة النجاح (بلا تكرار). */}
      {phase === "form" && (
        <p className="mt-5 text-center text-[13px]">
          <Link href="/login?mode=customer" className="font-semibold text-brand-ink hover:underline">{tr.haveAccount}</Link>
        </p>
      )}
    </RegisterShell>
  );
}
