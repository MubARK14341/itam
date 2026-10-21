"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, ArrowRight, AlertCircle, Copy, Check } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { recordAuthSecurityEvent } from "@/lib/auth-security";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { AuthBrand, AuthPrefs } from "@/components/auth/auth-chrome";
import { OtpBoxes } from "@/components/auth/otp-boxes";

interface Enrollment {
  factorId: string;
  qrCode: string;
  secret: string;
}

type MfaInitialization =
  | { factorId: string; enrollment: Enrollment | null; error: null }
  | { factorId: null; enrollment: null; error: string };

export default function MfaPage() {
  const router = useRouter();
  const { t } = useAppPreferences();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const initialization = useRef<Promise<MfaInitialization> | null>(null);

  useEffect(() => {
    let active = true;
    initialization.current ??= (async () => {
      const client = createClient();
      const { data, error } = await client.auth.mfa.listFactors();
      if (error) {
        return {
          factorId: null,
          enrollment: null,
          error: "تعذر تحميل إعداد التحقق المتعدد. / Unable to load MFA.",
        };
      }
      const verified = data.totp.find((factor) => factor.status === "verified");
      if (verified) {
        return { factorId: verified.id, enrollment: null, error: null };
      }
      await recordAuthSecurityEvent(client, "mfa_enrollment_started");
      const enrollmentResult = await client.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "ITAM administrator",
      });
      if (enrollmentResult.error) {
        return {
          factorId: null,
          enrollment: null,
          error: "تعذر بدء تسجيل MFA. راجع إعدادات Auth. / MFA enrollment is unavailable.",
        };
      }
      return {
        factorId: enrollmentResult.data.id,
        enrollment: {
          factorId: enrollmentResult.data.id,
          qrCode: enrollmentResult.data.totp.qr_code,
          secret: enrollmentResult.data.totp.secret,
        },
        error: null,
      };
    })();
    void initialization.current.then((result) => {
      if (!active) return;
      setFactorId(result.factorId);
      setEnrollment(result.enrollment);
      setError(result.error);
      setBusy(false);
    });
    return () => { active = false; };
  }, []);

  async function verify() {
    if (!factorId || !/^\d{6}$/.test(code)) return;
    setBusy(true); setError(null);
    const client = createClient();
    const { error } = await client.auth.mfa.challengeAndVerify({
      factorId,
      code,
    });
    if (error) {
      setError("رمز غير صحيح أو منتهي. / Invalid or expired code.");
      setBusy(false);
      return;
    }
    await recordAuthSecurityEvent(
      client,
      enrollment ? "mfa_enrolled" : "mfa_verified",
    );
    router.replace("/dashboard");
    router.refresh();
  }

  // نسخ المفتاح السري للإدخال اليدوي — واجهة فقط.
  async function copySecret() {
    if (!enrollment) return;
    try {
      await navigator.clipboard.writeText(enrollment.secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable — the key stays visible for manual entry */ }
  }

  const ta = t.auth;
  const codeHint = code.length === 6 ? ta.mfaCodeComplete : ta.mfaCodeProgress.replace("{n}", String(code.length));
  const codeField = (
    <>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <label htmlFor="mfa-code" className={enrollment ? "text-sm font-semibold text-fg" : "ui-label mb-0"}>
          {enrollment ? ta.mfaStepCode : ta.mfaCodeLabel}
        </label>
        <span aria-live="polite" className="text-xs tabular-nums text-muted">{codeHint}</span>
      </div>
      <OtpBoxes
        id="mfa-code"
        name="code"
        value={code}
        onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        dir="ltr"
        invalid={Boolean(error) && Boolean(factorId)}
        aria-describedby={enrollment ? undefined : "mfa-help"}
      />
    </>
  );

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-20">
      <div className="absolute end-4 top-4 sm:end-7 sm:top-5">
        <AuthPrefs />
      </div>

      <div className="mb-5"><AuthBrand /></div>

      <section aria-labelledby="mfa-title" className="ui-surface w-full max-w-[560px] overflow-hidden">
        <div className="flex flex-col gap-6 px-5 pb-7 pt-8 sm:px-8">
          <div className="flex items-start gap-3.5">
            <span className="inline-flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand-ink">
              <ShieldCheck aria-hidden="true" className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              <h1 id="mfa-title" className="font-display text-2xl font-semibold leading-[1.4] text-fg sm:text-[32px]">
                {enrollment ? ta.mfaEnrollTitle : ta.mfaTitle}
              </h1>
              <p className="mt-1 text-[13.5px] text-muted">{enrollment ? ta.mfaEnrollDesc : ta.mfaVerifyDesc}</p>
              <p className="mt-0.5 text-xs text-muted">{ta.mfaPolicyNote}</p>
            </div>
          </div>

          {busy && !factorId ? (
            <div className="flex justify-center py-8"><Spinner label={t.common.loading} /></div>
          ) : (
            <div className="flex flex-col gap-5">
              {enrollment ? (
                <ol className="flex flex-col gap-5">
                  <li className="grid grid-cols-[26px_minmax(0,1fr)] gap-3">
                    <StepNumber n={1} />
                    <div>
                      <p className="font-semibold text-fg">{ta.mfaStepInstall}</p>
                      <p className="text-[12.5px] text-muted">{ta.mfaStepInstallDesc}</p>
                    </div>
                  </li>
                  <li className="grid grid-cols-[26px_minmax(0,1fr)] gap-3">
                    <StepNumber n={2} />
                    <div className="min-w-0">
                      <p className="font-semibold text-fg">{ta.mfaStepScan}</p>
                      <div className="mt-2.5 flex flex-col gap-4 sm:flex-row sm:items-center">
                        {/* رموز QR تحتاج خلفية فاتحة للمسح في الوضعين */}
                        <div className="shrink-0 self-start rounded-xl border border-line bg-[#fff] p-2">
                          <Image
                            src={enrollment.qrCode.trimEnd()}
                            alt="TOTP QR"
                            width={144}
                            height={144}
                            unoptimized
                            className="block rounded-md"
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <span className="block text-[12.5px] text-muted">{ta.mfaManualKey}</span>
                          <div className="mt-1.5 flex items-center gap-1.5 rounded-control border border-line bg-surface-2 py-1 pe-1 ps-2.5">
                            <p className="min-w-0 flex-1 break-all font-mono text-xs font-medium text-fg" dir="ltr">
                              {enrollment.secret}
                            </p>
                            <Button
                              type="button" variant="outline" size="sm" onClick={() => void copySecret()}
                              aria-label={copied ? ta.mfaCopiedAria : ta.mfaCopyAria}
                            >
                              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                              {copied ? ta.mfaCopied : ta.mfaCopy}
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </li>
                  <li className="grid grid-cols-[26px_minmax(0,1fr)] gap-3">
                    <StepNumber n={3} />
                    <div className="min-w-0">{codeField}</div>
                  </li>
                </ol>
              ) : (
                <div>
                  {codeField}
                  <span id="mfa-help" className="mt-2.5 block text-[12.5px] text-muted">{ta.mfaCodeHelp}</span>
                </div>
              )}

              {error && (
                <div role="alert" className="flex gap-2.5 rounded-control bg-bad-soft px-3.5 py-3 text-[13px] font-medium text-bad">
                  <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <Button
                type="button"
                onClick={() => void verify()}
                disabled={busy || code.length !== 6}
                className="h-12 w-full text-[15px] font-semibold"
              >
                {busy ? "…" : "تحقق / Verify"}
                {!busy && <ArrowRight aria-hidden="true" className="rtl:rotate-180" />}
              </Button>
            </div>
          )}
        </div>
      </section>

      <span className="mt-4 block max-w-[500px] text-center text-[12.5px] text-muted">{ta.mfaLostAccess}</span>
    </main>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-full bg-sunk text-xs font-bold tabular-nums text-fg-2">{n}</span>
  );
}
