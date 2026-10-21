"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { ArrowRight, CheckCircle2, Lock, Eye, EyeOff, UserCheck, ShieldCheck, KeyRound } from "lucide-react";
import { Field, Select, inputClass } from "@/components/ui/form";
import { Button, buttonClass } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { StatusChip } from "@/components/ui/status-chip";
import {
  getRegistrationStatus, validateInvite, signUpEmployee, type RegistrationStatus,
} from "@/lib/queries";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { MIN_PASSWORD_LENGTH, passwordPolicyError } from "@/lib/password-policy";
import { CaptchaField } from "@/components/auth/captcha-field";
import { AuthHero, HeroFlow } from "@/components/auth/auth-chrome";
import { PasswordStrength } from "@/components/auth/password-strength";
import { RegisterNotice, RegisterShell, RegisterTypeSwitch } from "@/components/auth/register-layout";

type Phase = "loading" | "closed" | "no_slots" | "form" | "done_approval";

export default function RegisterPage() {
  const { t, lang } = useAppPreferences();
  const router = useRouter();
  const tr = t.registration;
  const [status, setStatus] = useState<RegistrationStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");

  const [f, setF] = useState({
    full_name: "", email: "", password: "", confirm: "",
    phone: "", department_id: "", note: "", invite: "",
  });
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      // جلسة مُصادَقة قائمة؟ لا ينبغي أن يرى مستخدمٌ داخلٌ نموذجَ التسجيل — توجيه جهة العميل فقط
      // (لا يمسّ منطق الجلسة الخادمي). يبقى الطور "loading" أثناء إعادة التوجيه.
      const { data: { user } } = await createClient().auth.getUser();
      if (!active) return;
      if (user) { router.replace("/dashboard"); return; }
      const s = await getRegistrationStatus();
      if (!active) return;
      setStatus(s);
      if (!s || s.mode === "closed") { setPhase("closed"); return; }
      if (s.mode === "gradual" && !s.has_slots) { setPhase("no_slots"); return; }
      setPhase("form");
    })();
    return () => { active = false; };
  }, [router]);

  const inviteOnly = status?.mode === "invite_only";

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!f.full_name.trim()) e.full_name = tr.errFullName;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = tr.errEmail;
    if (passwordPolicyError(f.password)) e.password = tr.errPassword;
    if (f.password !== f.confirm) e.confirm = tr.errPasswordMatch;
    if (inviteOnly && !f.invite.trim()) e.invite = tr.errInviteRequired;
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    setFormError(null);
    if (!validate()) return;
    setBusy(true);

    // التحقق من رمز الدعوة قبل الإنشاء (وضع invite_only)
    let requestedRole = status?.default_requested_role ?? null;
    if (inviteOnly) {
      const v = await validateInvite(f.invite.trim());
      if (!v.valid) { setBusy(false); setErrors((s) => ({ ...s, invite: tr.errInviteInvalid })); return; }
      requestedRole = v.default_role ?? requestedRole;
    }

    const { error } = await signUpEmployee({
      email: f.email, password: f.password, full_name: f.full_name,
      phone: f.phone.trim() || null, department_id: f.department_id || null,
      registration_note: f.note.trim() || null, requested_role: requestedRole,
      invite_code: inviteOnly ? f.invite.trim() : null,
      captcha_token: captchaToken,
    });
    setBusy(false);
    if (error) {
      // رمز خطأ ثابت من الطبقة الخلفية → رسالة دقيقة ومترجمة (لا نص خام إطلاقًا).
      setFormError(
        error === "email_invalid" ? tr.errEmailInvalid
        : error === "rate_limit" ? tr.errRateLimit
        : error === "weak_password" ? tr.errWeakPassword
        : error === "signups_disabled" ? tr.closedDesc
        : tr.signupFailed,
      );
      return;
    }
    // لا تأكيد بريد — دائمًا رسالة «بانتظار موافقة المسؤول».
    setPhase("done_approval");
  }

  const departments = status?.departments ?? [];
  const depLabel = (d: { name: string; name_ar: string | null }) => (lang === "ar" ? (d.name_ar ?? d.name) : d.name);
  const passwordsMatch = f.confirm.length > 0 && f.confirm === f.password;
  const passwordType = showPassword ? "text" : "password";

  const hero = (
    <AuthHero
      label={tr.heroLabel}
      chip={tr.heroChip}
      title={<><span className="block">{tr.heroTitleA}</span><span className="block">{tr.heroTitleB}</span></>}
      description={tr.heroDesc}
      features={[
        { icon: UserCheck, title: tr.featReview, desc: tr.featReviewDesc },
        { icon: ShieldCheck, title: tr.featRoles, desc: tr.featRolesDesc },
        { icon: KeyRound, title: tr.featSecurity, desc: tr.featSecurityDesc.replace("{n}", String(MIN_PASSWORD_LENGTH)) },
      ]}
    >
      <HeroFlow
        title={tr.flowTitle}
        stepLabel={tr.flowStepOf.replace("{n}", "1").replace("{total}", "3")}
        steps={[
          { title: tr.stepSubmit, desc: tr.stepSubmitDesc },
          { title: tr.stepReview, desc: tr.stepReviewDesc },
          { title: tr.stepAccess, desc: tr.stepAccessDesc },
        ]}
      />
    </AuthHero>
  );

  return (
    <RegisterShell hero={hero}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h1 className="font-display text-[28px] font-semibold leading-[1.4] text-fg sm:text-[32px]">{tr.title}</h1>
        {phase === "form" && status?.mode === "gradual" && status.remaining_slots != null && (
          <StatusChip tone="info"><span className="tabular-nums">{tr.seatsLeft.replace("{n}", String(status.remaining_slots))}</span></StatusChip>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">{tr.subtitle}</p>

      <RegisterTypeSwitch active="employee" />

      {phase === "loading" && (
        <div className="flex justify-center py-12"><Spinner label={t.common.loading} /></div>
      )}

      {phase === "closed" && (
        <RegisterNotice icon={<Lock aria-hidden="true" className="h-6 w-6" />} tone="warn" title={tr.closedTitle}>
          <p className="mt-1.5 text-sm text-muted">{(lang === "ar" ? status?.message_ar : status?.message_en) || tr.closedDesc}</p>
        </RegisterNotice>
      )}
      {phase === "no_slots" && (
        <RegisterNotice icon={<Lock aria-hidden="true" className="h-6 w-6" />} tone="warn" title={tr.noSlotsTitle}>
          <p className="mt-1.5 text-sm text-muted">{tr.noSlotsDesc}</p>
        </RegisterNotice>
      )}
      {phase === "done_approval" && (
        <RegisterNotice icon={<CheckCircle2 aria-hidden="true" className="h-6 w-6" />} tone="ok" title={tr.successTitle}>
          <p className="mt-1.5 text-sm text-muted">{tr.successApproval}</p>
          <Link href="/login" className={buttonClass("outline", "md", "mt-4")}>{tr.backToLogin}</Link>
        </RegisterNotice>
      )}

      {phase === "form" && (
        <form onSubmit={onSubmit} className="mt-5 space-y-3.5">
          <div className="grid gap-x-3.5 gap-y-3 sm:grid-cols-2">
            <Field label={tr.fullName} required error={errors.full_name}>
              <input className={inputClass} value={f.full_name} onChange={(e) => set("full_name")(e.target.value)} autoComplete="name" />
            </Field>
            <Field label={tr.email} required error={errors.email}>
              <input className={inputClass} type="email" value={f.email} onChange={(e) => set("email")(e.target.value)} dir="ltr" placeholder="demo@example.invalid" autoComplete="email" />
            </Field>
            <div>
              <label htmlFor="register-password" className="ui-label">
                {tr.password} <span aria-hidden="true" className="text-bad">*</span>
              </label>
              <div className="relative">
                <input
                  id="register-password"
                  className={`${inputClass} ${lang === "ar" ? "ps-11" : "pe-11"}`}
                  type={passwordType} required value={f.password}
                  onChange={(e) => set("password")(e.target.value)} dir="ltr" placeholder="••••••••••••"
                  autoComplete="new-password"
                  aria-invalid={errors.password ? true : undefined}
                  aria-describedby={errors.password ? "register-password-error" : "register-password-strength"}
                />
                <button
                  type="button"
                  aria-label={showPassword ? t.auth.hidePassword : t.auth.showPassword}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((visible) => !visible)}
                  className="absolute inset-y-0 end-0 inline-flex w-11 items-center justify-center rounded-e-control text-muted transition-colors hover:bg-sunk hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                >
                  {showPassword ? <EyeOff aria-hidden="true" className="h-4 w-4" /> : <Eye aria-hidden="true" className="h-4 w-4" />}
                </button>
              </div>
              {errors.password && <p id="register-password-error" role="alert" className="mt-1.5 text-xs font-medium text-bad">{errors.password}</p>}
            </div>
            <Field label={tr.confirmPassword} required error={errors.confirm} hint={passwordsMatch ? tr.passwordsMatch : undefined}>
              <input className={inputClass} type={passwordType} value={f.confirm} onChange={(e) => set("confirm")(e.target.value)} dir="ltr" placeholder="••••••••••••" autoComplete="new-password" />
            </Field>
            <div className="sm:col-span-2">
              <PasswordStrength id="register-password-strength" password={f.password} />
            </div>
            <Field label={tr.phone} hint={tr.optional}>
              <input className={inputClass} value={f.phone} onChange={(e) => set("phone")(e.target.value)} dir="ltr" inputMode="tel" placeholder="+966 5x xxx xxxx" />
            </Field>
            <Field label={tr.department} hint={tr.optional}>
              <Select value={f.department_id} onChange={set("department_id")} placeholder={tr.chooseDepartment}
                options={departments.map((d) => ({ value: d.id, label: depLabel(d) }))} />
            </Field>
            <div className="sm:col-span-2">
              <Field label={tr.note} hint={tr.optional}>
                <textarea className={`${inputClass} resize-none`} rows={2} value={f.note} onChange={(e) => set("note")(e.target.value)} />
              </Field>
            </div>
            {inviteOnly && (
              <div className="sm:col-span-2">
                <Field label={tr.inviteCode} required error={errors.invite} hint={tr.inviteCodeHint}>
                  <input className={`${inputClass} font-mono`} value={f.invite} onChange={(e) => set("invite")(e.target.value)} dir="ltr" />
                </Field>
              </div>
            )}
          </div>

          <CaptchaField action="employee_signup" onToken={setCaptchaToken} />

          {formError && (
            <div role="alert" className="rounded-control bg-bad-soft px-3 py-2.5 text-sm font-medium text-bad">{formError}</div>
          )}

          <Button type="submit" disabled={busy} className="h-12 w-full text-[15px] font-semibold">
            {busy ? tr.submitting : tr.submit}<ArrowRight aria-hidden="true" className="rtl:rotate-180" />
          </Button>
        </form>
      )}

      <p className="mt-5 text-center text-[13px] text-muted">
        {tr.haveAccount}{" "}
        <Link href="/login" className="font-semibold text-brand-ink hover:underline">{tr.backToLogin}</Link>
      </p>
    </RegisterShell>
  );
}
