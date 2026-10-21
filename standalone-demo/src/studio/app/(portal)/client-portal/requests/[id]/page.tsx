"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Send, CheckCircle2, XCircle, AlertOctagon, Check, Clock, MessageSquareReply, X } from "lucide-react";
import { inputClass } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { Toast, type ToastState } from "@/components/ui/toast";
import {
  portalGetRequest, portalReplyClarification, portalPmApproveRequest, portalPmRejectRequest,
  type PortalRequestDetail,
} from "@/lib/portal";
import {
  portalDisplayKey, portalStatusKey, portalFulfillmentKey,
  PORTAL_STATUS_TONE, PORTAL_FULFILLMENT_TONE, type PortalStatusKey,
} from "@/lib/portal-status";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { formatDate, formatDateTime } from "@/lib/format";
import { usePortalSession } from "@/components/providers/portal-session";
import { PortalAttachments } from "@/components/portal/portal-attachments";
import { EquipmentPhoto } from "@/components/assets/equipment-photo";
import { acknowledgePortalDraft, submitPortalDraft } from "@/lib/portal-request-operation";
import { friendlyErrorStrict } from "@/lib/user-facing-errors";
import { createClient } from "@/lib/supabase/client";
import { usePortalOperationActor } from "@/lib/use-portal-operation-actor";

type StepState = "done" | "current" | "pending" | "failed";

const TEAM_KEYS: PortalStatusKey[] = ["reviewing", "clarify", "accepted", "preparing", "delivered", "completed", "returned"];
const PROC_KEYS: PortalStatusKey[] = ["reviewing", "clarify", "accepted", "preparing", "delivered"];
const DONE_KEYS: PortalStatusKey[] = ["completed", "returned"];
const CLOSED_KEYS: PortalStatusKey[] = ["rejected", "pm_rejected", "cancelled"];

export default function PortalRequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, lang } = useAppPreferences();
  const tp = t.portal;
  const ctx = usePortalSession();
  const { actorId, ready: actorReady, actorChanged, isCurrent, invalidate } = usePortalOperationActor();

  const [data, setData] = useState<PortalRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [pmRejectReason, setPmRejectReason] = useState("");
  const [pmRejectOpen, setPmRejectOpen] = useState(false);
  const submitInFlight = useRef(false);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    if (!actorId || !isCurrent(actorId)) return;
    const generation = ++loadGeneration.current;
    const session = await createClient().auth.getSession();
    if (generation !== loadGeneration.current || !isCurrent(actorId)) return;
    if (session.data.session?.user.id !== actorId) { invalidate(); return; }
    if (!session.data.session.access_token) { setError("not_authorized"); setLoaded(true); return; }
    const { data, error } = await portalGetRequest(id, session.data.session.access_token);
    if (generation !== loadGeneration.current || !isCurrent(actorId)) return;
    setData(data); setError(error); setLoaded(true);
    if (!error && data?.request.id === id) void acknowledgePortalDraft(id, actorId);
  }, [id, actorId, isCurrent, invalidate]);
  useEffect(() => {
    if (!actorReady || actorChanged) return;
    setLoaded(false); setData(null);
    if (!actorId) { setError("not_authorized"); setLoaded(true); return; }
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load, actorId, actorReady, actorChanged]);
  useEffect(() => {
    if (!actorChanged) return;
    loadGeneration.current += 1;
    setData(null); setReply(""); setPmRejectReason(""); setPmRejectOpen(false); setToast(null); setBusy(false);
  }, [actorChanged]);

  async function resumeSubmit() {
    if (!actorId || !isCurrent(actorId) || submitInFlight.current || !ctx?.portal_enabled || ctx.portal_role === "viewer"
      || !data?.creation_complete || data.request.can_submit_draft !== true || data.items.length === 0) return;
    submitInFlight.current = true;
    setBusy(true);
    try {
      const result = await submitPortalDraft(id, actorId);
      if (!isCurrent(actorId)) return;
      if (result.error === "operation_actor_changed") { invalidate(); return; }
      if (result.data) setData(result.data);
      if (result.error) {
        setToast({ type: "error", message: result.error === "operation_result_unknown"
          ? tp.recovery.submitUnconfirmed : friendlyErrorStrict(result.error, lang) });
        return;
      }
      setToast({ type: "success", message: result.pendingPm ? tp.submitPendingToast : tp.submittedToast });
      await load();
    } finally {
      submitInFlight.current = false;
      if (isCurrent(actorId)) setBusy(false);
    }
  }

  const errLabel = (code: string) => (tp.err as Record<string, string>)[code] ?? code;

  async function actionToken() {
    if (!actorId || !isCurrent(actorId)) return null;
    const session = await createClient().auth.getSession();
    if (!isCurrent(actorId)) return null;
    if (session.data.session?.user.id !== actorId) { invalidate(); return null; }
    return session.data.session.access_token || null;
  }

  async function sendReply() {
    if (!reply.trim()) return;
    const token = await actionToken();
    if (!token || !actorId) return;
    setBusy(true);
    const e = await portalReplyClarification(id, reply.trim(), token);
    if (!isCurrent(actorId)) return;
    setBusy(false);
    if (e) { setToast({ type: "error", message: tp.actionError + errLabel(e) }); return; }
    setReply(""); setToast({ type: "success", message: tp.replySentToast }); load();
  }

  async function pmApprove() {
    const token = await actionToken();
    if (!token || !actorId) return;
    setBusy(true);
    const e = await portalPmApproveRequest(id, token);
    if (!isCurrent(actorId)) return;
    setBusy(false);
    if (e) { setToast({ type: "error", message: tp.actionError + errLabel(e) }); return; }
    setToast({ type: "success", message: tp.pmApprovedToast }); load();
  }
  async function pmReject() {
    if (!pmRejectReason.trim()) { setToast({ type: "error", message: tp.pmRejectReasonRequired }); return; }
    const token = await actionToken();
    if (!token || !actorId) return;
    setBusy(true);
    const e = await portalPmRejectRequest(id, pmRejectReason.trim(), token);
    if (!isCurrent(actorId)) return;
    setBusy(false);
    if (e) { setToast({ type: "error", message: tp.actionError + errLabel(e) }); return; }
    setPmRejectOpen(false); setPmRejectReason(""); setToast({ type: "success", message: tp.pmRejectedToast }); load();
  }

  if (actorChanged) return <div role="alert" className="ui-surface space-y-3 p-5">
    <p>{tp.recovery.actorChanged}</p>
    <Link href="/client-portal/requests" className="inline-flex min-h-11 items-center text-brand-ink">{tp.back}</Link>
  </div>;
  if (!loaded) return <div className="ui-surface flex justify-center p-10"><Spinner label={tp.loading} /></div>;
  if (error || !data) {
    return (
      <div className="ui-surface">
        <EmptyState
          icon={AlertOctagon}
          title={error ? tp.loadError + errLabel(error) : tp.notFound}
          action={<Link href="/client-portal/requests" className="inline-flex min-h-11 items-center text-[13.5px] font-semibold text-brand-ink hover:underline">{tp.back}</Link>}
        />
      </div>
    );
  }

  const r = data.request;
  const sk = portalDisplayKey(r.status, r.portal_approval_status);
  const canReply = ctx?.portal_role !== "viewer";
  const isPmRejected = r.portal_approval_status === "rejected_by_project_manager";
  const isPendingPm = r.portal_approval_status === "pending_project_manager";
  const hasPmFlow = r.portal_approval_status !== "not_required";
  const needsClarify = r.status === "needs_clarification";

  // خطوات المسار المبسّط للعميل — مشتقّة من مفتاح الحالة فقط.
  const steps: { label: string; state: StepState }[] = [];
  steps.push({ label: tp.steps.created, state: "done" });
  if (hasPmFlow) {
    steps.push({
      label: tp.steps.pending_pm,
      state: sk === "pending_pm" ? "current" : sk === "pm_rejected" ? "failed" : "done",
    });
  }
  steps.push({
    label: tp.steps.submitted,
    state: TEAM_KEYS.includes(sk) ? "done" : sk === "pm_rejected" ? "failed" : "pending",
  });
  steps.push({
    label: tp.steps.processing,
    state: DONE_KEYS.includes(sk) ? "done" : PROC_KEYS.includes(sk) ? "current" : "pending",
  });
  steps.push({
    label: CLOSED_KEYS.includes(sk) ? tp.steps.rejected : tp.steps.done,
    state: DONE_KEYS.includes(sk) ? "done" : CLOSED_KEYS.includes(sk) ? "failed" : "pending",
  });

  const tl = tp.ledger;
  // آخر سؤال من الفريق (من سجل الطلب نفسه) لعرضه فوق مربع الرد.
  const lastQuestion = [...data.events].reverse().find((e) => e.event_type === "clarification_requested" && e.message);
  const bannerCls = "flex items-start gap-2.5 rounded-card p-4";

  return (
    <div className="flex flex-col gap-5">
      <Link href="/client-portal/requests" className="-mb-2 inline-flex min-h-11 w-fit items-center gap-1 text-[13px] font-medium text-muted hover:text-fg"><ArrowRight aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />{tp.back}</Link>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          {/* رأس */}
          <section aria-labelledby="portal-request-title" className="ui-surface p-5 sm:p-6">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[13px] font-medium text-fg-2 [unicode-bidi:isolate]" dir="ltr">{r.request_number}</span>
              <StatusChip tone={PORTAL_STATUS_TONE[sk]}>{tp.status[sk]}</StatusChip>
            </div>
            <h1 id="portal-request-title" className="mt-3 font-display text-2xl font-semibold leading-snug text-fg sm:text-[32px]">{r.project_name || r.request_number}</h1>
            <p className="mt-0.5 text-[13px] tabular-nums text-muted">
              {r.project_city && <>{r.project_city} · </>}
              {tl.itemsCount.replace("{count}", String(data.items.length))}
            </p>
            <dl className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-line pt-3 sm:grid-cols-3">
              <Info label={tp.created} value={formatDateTime(r.created_at, lang)} />
              {r.pickup_date && <Info label={tp.pickupDate} value={formatDate(r.pickup_date, lang)} />}
              {r.return_date && <Info label={tp.returnDate} value={formatDate(r.return_date, lang)} />}
            </dl>
            {r.notes && <p className="mt-3 rounded-control border border-line bg-surface-2 px-3 py-2.5 text-[13px] text-fg-2"><span className="text-muted">{tl.yourNotes}</span> {r.notes}</p>}
          </section>

          {r.status === "draft" && r.portal_approval_status === "not_required" && (
            <section className="ui-surface space-y-3 p-4 sm:p-5">
              <p className="text-sm text-muted">{data.creation_complete ? tp.recovery.savedHint : tp.recovery.legacyDraftHint}</p>
              {data.creation_complete && r.can_submit_draft === true && data.items.length > 0 && ctx?.portal_enabled && ctx.portal_role !== "viewer" && (
                <Button disabled={busy} onClick={() => void resumeSubmit()}>
                  <Send aria-hidden="true" className="h-4 w-4" />{busy ? tp.saving : tp.recovery.resumeSubmit}
                </Button>
              )}
            </section>
          )}

          {/* رفض مدير المشروع — بطاقة تحذير بارزة */}
          {isPmRejected && (
            <div role="note" className={`${bannerCls} bg-bad-soft`}>
              <AlertOctagon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-bad" />
              <div>
                <p className="text-[13.5px] font-semibold text-bad">{tp.status.pm_rejected}</p>
                {r.portal_rejection_reason && <p className="mt-1 text-[13px] text-fg-2">{tp.pmRejectedReasonLabel}: {r.portal_rejection_reason}</p>}
              </div>
            </div>
          )}

          {/* رفض الفريق (بعد الوصول) */}
          {r.status === "rejected" && r.rejection_reason && (
            <div role="note" className={`${bannerCls} bg-bad-soft`}>
              <AlertOctagon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-bad" />
              <div><p className="text-[13.5px] font-semibold text-bad">{tp.status.rejected}</p><p className="mt-1 text-[13px] text-fg-2">{tp.teamNote}: {r.rejection_reason}</p></div>
            </div>
          )}

          {/* ردّ على طلب توضيح — أول بطاقة مهمة عند الحاجة */}
          {needsClarify && canReply && (
            <section aria-labelledby="portal-clarify-title" className="ui-surface overflow-hidden">
              <div className="flex items-center gap-3 bg-warn-soft px-4 py-3 sm:px-5">
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-surface text-warn"><MessageSquareReply aria-hidden="true" className="h-[18px] w-[18px]" /></span>
                <div className="min-w-0">
                  <h2 id="portal-clarify-title" className="text-[14.5px] font-semibold text-fg">{tl.clarifyTitle}</h2>
                  <p className="text-[12.5px] text-fg-2">{tp.clarifyBox}</p>
                </div>
              </div>
              {lastQuestion && (
                <div className="px-4 pt-3.5 sm:px-5">
                  <p className="whitespace-pre-wrap rounded-xl rounded-ss-sm bg-sunk px-3.5 py-2.5 text-[13.5px] text-fg">{lastQuestion.message}</p>
                  <p className="mt-1 text-xs tabular-nums text-muted">{formatDateTime(lastQuestion.created_at, lang)}</p>
                </div>
              )}
              <div className="flex flex-col gap-2 px-4 pb-4 pt-3.5 sm:px-5">
                <label htmlFor="portal-clarify-reply" className="ui-label !mb-0">{tl.replyLabel}</label>
                <textarea id="portal-clarify-reply" className={`${inputClass} resize-none`} rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={tp.replyPlaceholder} />
                <div className="flex justify-end">
                  <Button disabled={busy || !reply.trim()} onClick={sendReply}><Send aria-hidden="true" className="h-4 w-4" />{tp.sendReply}</Button>
                </div>
              </div>
            </section>
          )}

          {/* اعتماد مدير المشروع — يظهر لمدير المشروع فقط عند وجود طلب بانتظار اعتماده */}
          {r.can_pm_approve && (
            <section aria-labelledby="portal-pm-title" className="ui-surface overflow-hidden">
              <div className="flex items-center gap-3 bg-warn-soft px-4 py-3 sm:px-5">
                <Clock aria-hidden="true" className="h-[18px] w-[18px] shrink-0 text-warn" />
                <h2 id="portal-pm-title" className="text-[14.5px] font-semibold text-fg">{tp.status.pending_pm}</h2>
              </div>
              <div className="px-4 py-3.5 sm:px-5">
                {!pmRejectOpen ? (
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy} onClick={pmApprove}><CheckCircle2 aria-hidden="true" className="h-4 w-4" />{tp.pmApprove}</Button>
                    <Button variant="outline" disabled={busy} onClick={() => setPmRejectOpen(true)}><XCircle aria-hidden="true" className="h-4 w-4" />{tp.pmReject}</Button>
                  </div>
                ) : (
                  <div>
                    <textarea className={`${inputClass} resize-none`} rows={3} value={pmRejectReason} onChange={(e) => setPmRejectReason(e.target.value)} placeholder={tp.pmRejectReason} aria-label={tp.pmRejectReason} />
                    <div className="mt-2 flex flex-wrap justify-end gap-2">
                      <Button variant="outline" disabled={busy} onClick={() => { setPmRejectOpen(false); setPmRejectReason(""); }}>{tp.back}</Button>
                      <Button variant="danger" disabled={busy || !pmRejectReason.trim()} onClick={pmReject}><XCircle aria-hidden="true" className="h-4 w-4" />{tp.pmReject}</Button>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* لصاحب الطلب: بانتظار اعتماد مدير المشروع (بلا أزرار) */}
          {isPendingPm && !r.can_pm_approve && (
            <div role="note" className={`${bannerCls} bg-warn-soft text-[13.5px] text-warn`}>
              <Clock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{tp.pmPendingBadge}
            </div>
          )}

          {/* العناصر المطلوبة */}
          <section aria-labelledby="portal-items-title" className="ui-surface overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-4 py-3.5 sm:px-5">
              <h2 id="portal-items-title" className="font-display text-[17px] font-semibold text-fg">{tp.requestItems}</h2>
              <span className="ui-count">{data.items.length}</span>
            </div>
            <ul>
              {data.items.map((it) => {
                const fk = portalFulfillmentKey(it.fulfillment);
                return (
                  <li key={it.id} className="flex items-start justify-between gap-3 border-t border-line px-4 py-4 sm:px-5">
                    <EquipmentPhoto asset={{ name: it.preferred_model || it.requested_description, category: { name: it.requested_category } }} size="row" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-semibold text-fg">{it.requested_description || it.requested_category || "—"}</p>
                      <p className="mt-0.5 text-xs text-muted">
                        {it.requested_category && it.requested_description && <span>{it.requested_category} · </span>}
                        {it.preferred_model && <span>{it.preferred_model} · </span>}
                        {tp.acceptAlternative} {it.accept_alternative ? tp.yes : tp.no}
                      </p>
                      <div className="mt-1.5"><StatusChip tone={PORTAL_FULFILLMENT_TONE[fk]} size="sm">{(tp.fulfillment as Record<string, string>)[fk]}</StatusChip></div>
                    </div>
                    <span className="shrink-0 text-[13px] tabular-nums text-fg-2">{tp.quantityLabel} <b className="font-semibold text-fg">{it.quantity}</b></span>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* المرفقات */}
          <PortalAttachments requestId={id} status={r.status} role={ctx?.portal_role} expectedActorId={actorId ?? ""} isCurrent={isCurrent} />
        </div>

        <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-24">
          {/* مسار الطلب المبسّط */}
          <section aria-labelledby="portal-path-title" className="ui-surface px-4 pb-1 pt-3.5 sm:px-5">
            <h2 id="portal-path-title" className="mb-3 font-display text-[17px] font-semibold text-fg">{tl.timelineLabel}</h2>
            <ol>
              {steps.map((s, i) => (
                <li key={i} aria-current={s.state === "current" ? "step" : undefined} className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3">
                  <span className="flex flex-col items-center">
                    <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${stepMarker(s.state)}`}>
                      {s.state === "done" ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : s.state === "failed" ? <X aria-hidden="true" className="h-3.5 w-3.5" /> : <span aria-hidden="true" className="h-2 w-2 rounded-full bg-current" />}
                    </span>
                    {i < steps.length - 1 && <span aria-hidden="true" className={`my-1 w-0.5 flex-1 rounded-full ${s.state === "done" ? "bg-ok" : "bg-line"}`} />}
                  </span>
                  <span className={`block min-w-0 pb-4 pt-0.5 text-[13.5px] ${s.state === "current" ? "font-semibold text-fg" : s.state === "failed" ? "font-semibold text-bad" : s.state === "done" ? "text-fg" : "text-muted"}`}>
                    {s.label}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          {/* سجل الطلب */}
          <section aria-labelledby="portal-activity-title" className="ui-surface px-4 py-3.5 sm:px-5">
            <h2 id="portal-activity-title" className="mb-3 font-display text-[17px] font-semibold text-fg">{tp.activity}</h2>
            <ol className="relative flex flex-col gap-3.5 border-s border-line ps-4">
              {data.events.map((e, i) => {
                const label = e.event_type === "status_changed" && e.to_status
                  ? tp.status[portalStatusKey(e.to_status)]
                  : ((tp.ev as Record<string, string>)[e.event_type] ?? e.event_type);
                return (
                  <li key={i} className="relative">
                    <span aria-hidden="true" className={`absolute -start-[21px] top-1.5 h-2 w-2 rounded-full ring-2 ring-surface ${i === data.events.length - 1 ? "bg-brand" : "bg-line-strong"}`} />
                    <p className="text-[13.5px] font-medium text-fg">{label}</p>
                    {e.message && <p className="mt-0.5 whitespace-pre-wrap text-xs text-fg-2">{e.message}</p>}
                    <p className="mt-0.5 text-xs tabular-nums text-muted" dir={lang === "ar" ? "rtl" : "ltr"}>{formatDateTime(e.created_at, lang)}</p>
                  </li>
                );
              })}
            </ol>
          </section>
        </aside>
      </div>

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function stepMarker(state: StepState): string {
  switch (state) {
    case "done": return "bg-ok text-canvas";
    case "current": return "bg-brand-soft text-brand";
    case "failed": return "bg-bad-soft text-bad";
    default: return "border border-line-strong bg-surface text-line-strong";
  }
}
function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-[13.5px] font-semibold tabular-nums text-fg">{value}</dd>
    </div>
  );
}
