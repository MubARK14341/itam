"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, XCircle, CheckCircle2, LogOut, RefreshCw, Check, X, KeyRound, ShieldCheck, LogIn, DoorOpen, FileSearch, Mail } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { getMyAccountStatus, type MyAccountStatus } from "@/lib/queries";
import { getPortalContext } from "@/lib/portal";
import { formatDateTime } from "@/lib/format";
import type { Tone } from "@/lib/tone";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { secureSignOut } from "@/lib/auth-security";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { StatusChip } from "@/components/ui/status-chip";
import { AuthBrand, AuthPrefs } from "@/components/auth/auth-chrome";

type StepState = "done" | "current" | "failed" | "upcoming";
type TrackerStepData = { title: string; desc: string; state: StepState; tag?: string; tagTone?: Tone };

export default function PendingApprovalPage() {
  const router = useRouter();
  const { t, lang } = useAppPreferences();
  const tr = t.registration;
  const [status, setStatus] = useState<MyAccountStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const s = await getMyAccountStatus();
    if (!s) {
      // مستخدم بوابة عميل (لا سجل app_users) → بوابته، لا صفحة انتظار الموظفين.
      const portal = await getPortalContext();
      router.replace(portal ? "/client-portal" : "/login");
      return;
    }
    setStatus(s);
    setCheckedAt(new Date().toISOString());
    setLoading(false);
    // إذا أصبح معتمدًا → دخول التطبيق (لا تأكيد بريد — الموافقة وحدها هي البوابة)
    if (s.approval_status === "approved") {
      setTimeout(() => { router.replace("/dashboard"); router.refresh(); }, 900);
    }
  }, [router]);

  useEffect(() => { load(); }, [load]);

  async function signOut() {
    const sb = createClient();
    await secureSignOut(sb);
    router.replace("/login");
    router.refresh();
  }

  // اختيار الحالة المعروضة بالأولوية: رفض ← موافقة ← انتظار (لا تأكيد بريد)
  const view = !status ? "loading"
    : status.approval_status === "approved" ? "approved"
    : status.approval_status === "rejected" ? "rejected"
    : "pending";

  const map = {
    loading: { icon: Clock, tone: "neu" as Tone, title: t.common.loading, desc: "" },
    rejected: { icon: XCircle, tone: "bad" as Tone, title: tr.rejectedTitle, desc: tr.rejectedDesc },
    approved: { icon: CheckCircle2, tone: "ok" as Tone, title: tr.statusApproved, desc: tr.approvedRedirect },
    pending: { icon: Clock, tone: "info" as Tone, title: tr.pendingTitle, desc: tr.pendingDesc },
  }[view];

  const statusBadge: Record<MyAccountStatus["approval_status"], { label: string; tone: Tone }> = {
    pending: { label: tr.statusPending, tone: "info" },
    approved: { label: tr.statusApproved, tone: "ok" },
    rejected: { label: tr.statusRejected, tone: "bad" },
  };

  const iconTile: Record<Tone, string> = {
    ok: "bg-ok-soft text-ok", res: "bg-res-soft text-res", warn: "bg-warn-soft text-warn",
    bad: "bg-bad-soft text-bad", info: "bg-brand-soft text-brand-ink", neu: "bg-sunk text-muted",
  };

  // متتبّع الحالة — مشتق فقط من approval_status المعروض في الصفحة.
  const steps: TrackerStepData[] = status ? [
    { title: tr.stepCreated, desc: tr.stepCreatedDesc, state: "done" },
    view === "pending"
      ? { title: tr.stepReview, desc: tr.reviewPendingDesc, state: "current", tag: tr.currentStep, tagTone: "info" }
      : view === "rejected"
        ? { title: tr.stepReview, desc: tr.reviewDoneDesc, state: "failed", tag: tr.statusRejected, tagTone: "bad" }
        : { title: tr.stepReview, desc: tr.reviewDoneDesc, state: "done" },
    view === "approved"
      ? { title: tr.stepAccess, desc: tr.approvedRedirect, state: "current", tag: tr.statusApproved, tagTone: "ok" }
      : { title: tr.stepAccess, desc: view === "rejected" ? tr.accessBlockedDesc : tr.accessPendingDesc, state: "upcoming" },
  ] : [];

  const next = view === "pending" ? [
    { icon: ShieldCheck, title: tr.nextReviewTitle, desc: tr.nextReviewDesc },
    { icon: LogIn, title: tr.nextAutoTitle, desc: tr.nextAutoDesc },
    { icon: DoorOpen, title: tr.nextCloseTitle, desc: tr.nextCloseDesc },
  ] : view === "rejected" ? [
    { icon: FileSearch, title: tr.nextReasonTitle, desc: tr.nextReasonDesc },
    { icon: Mail, title: tr.nextContactTitle, desc: tr.nextContactDesc },
  ] : [];

  const Icon = map.icon;

  return (
    <main className="flex min-h-dvh flex-col bg-canvas">
      <div className="flex h-20 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4 sm:px-8">
        <AuthBrand />
        <AuthPrefs />
      </div>

      <div className="flex flex-1 justify-center px-4 py-6 sm:px-8 sm:py-9">
        <div className="ui-surface h-fit w-full max-w-[760px] overflow-hidden">
          <section aria-labelledby="pending-title" className="px-5 pb-6 pt-6 sm:px-8 sm:pt-7">
            <div className="flex items-start gap-4">
              <span className={`inline-flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[14px] ${iconTile[map.tone]}`}>
                {view === "loading" ? <Spinner /> : <Icon aria-hidden="true" className="h-6 w-6" />}
              </span>
              <div className="min-w-0 flex-1">
                {status && (
                  <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
                    <span>{tr.statusLabel}</span>
                    <StatusChip tone={statusBadge[status.approval_status].tone}>{statusBadge[status.approval_status].label}</StatusChip>
                  </div>
                )}
                <h1 id="pending-title" className="mt-2 font-display text-2xl font-semibold leading-[1.4] text-fg sm:text-[32px]">{map.title}</h1>
                {map.desc && <p className="mt-1 text-fg-2">{map.desc}</p>}
                {status && status.email && (
                  <p className="mt-2 text-[13px] text-muted">
                    {tr.accountLabel}: <bdi dir="ltr" className="font-medium text-fg-2">{status.email}</bdi>
                  </p>
                )}
              </div>
            </div>

            {/* سبب الرفض */}
            {status && status.approval_status === "rejected" && status.rejection_reason && (
              <div className="mt-5 flex gap-3 rounded-xl bg-bad-soft px-4 py-3.5">
                <XCircle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-bad" />
                <div className="leading-relaxed">
                  <p className="font-semibold text-bad">{tr.rejectionReason}</p>
                  <p className="text-fg">{status.rejection_reason}</p>
                </div>
              </div>
            )}
          </section>

          {steps.length > 0 && (
            <section aria-label={tr.trackerLabel} className="border-t border-line px-5 py-5 sm:px-8">
              <ol className="grid gap-4 sm:grid-cols-3 sm:gap-0">
                {steps.map((step, index) => (
                  <TrackerStep key={step.title} step={step} last={index === steps.length - 1} />
                ))}
              </ol>
            </section>
          )}

          {next.length > 0 && (
            <section aria-labelledby="pending-next-title" className="border-t border-line px-5 py-5 sm:px-8">
              <h2 id="pending-next-title" className="font-display text-[17px] font-semibold text-fg">
                {view === "rejected" ? tr.nextRejectedTitle : tr.nextPendingTitle}
              </h2>
              <ul className="mt-3 flex flex-col gap-3">
                {next.map(({ icon: NextIcon, title, desc }) => (
                  <li key={title} className="flex items-start gap-3">
                    <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-sunk text-fg-2">
                      <NextIcon aria-hidden="true" className="h-4 w-4" />
                    </span>
                    <div className="leading-[1.55]">
                      <p className="text-[13.5px] font-semibold text-fg">{title}</p>
                      <p className="text-[13px] text-muted">{desc}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface-2 px-5 py-3.5 sm:px-8">
            <Button type="button" variant={view === "rejected" ? "outline" : "primary"} onClick={load} disabled={loading}>
              <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} /> {tr.refreshStatus}
            </Button>
            <Button type="button" variant={view === "rejected" ? "ghost" : "outline"} onClick={signOut}>
              <LogOut aria-hidden="true" className="rtl:rotate-180" /> {tr.signOut}
            </Button>
            {checkedAt && (
              <span aria-live="polite" className="ms-auto inline-flex items-center gap-1.5 text-[12.5px] tabular-nums text-muted">
                <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${view === "rejected" ? "bg-bad" : view === "approved" ? "bg-ok" : "bg-brand"}`} />
                {tr.lastChecked.replace("{time}", formatDateTime(checkedAt, lang))}
              </span>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function TrackerStep({ step, last }: { step: TrackerStepData; last: boolean }) {
  const circle: Record<StepState, string> = {
    done: "border-ok bg-ok-soft text-ok",
    current: "border-brand bg-brand-soft text-brand-ink",
    failed: "border-bad bg-bad-soft text-bad",
    upcoming: "border-line-strong bg-surface text-muted",
  };
  const StepIcon = step.state === "done" ? Check : step.state === "failed" ? X : step.state === "current" ? Clock : KeyRound;
  const tagTone: Tone = step.tagTone ?? "neu";
  return (
    <li aria-current={step.state === "current" || step.state === "failed" ? "step" : undefined} className="flex gap-3 sm:block sm:pe-3">
      <div className="flex items-center gap-2.5">
        <span className={`inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border-[1.5px] ${circle[step.state]}`}>
          <StepIcon aria-hidden="true" className="h-4 w-4" />
        </span>
        {!last && <span aria-hidden="true" className={`hidden h-0.5 flex-1 rounded sm:block ${step.state === "done" ? "bg-ok" : step.state === "failed" ? "bg-bad" : "bg-line-strong"}`} />}
      </div>
      <div className="min-w-0 sm:mt-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-[14.5px] font-semibold ${step.state === "upcoming" ? "text-muted" : "text-fg"}`}>{step.title}</span>
          {step.tag && <StatusChip tone={tagTone} size="sm" dot={false}>{step.tag}</StatusChip>}
        </div>
        <p className="mt-0.5 text-[12.5px] text-muted">{step.desc}</p>
      </div>
    </li>
  );
}
