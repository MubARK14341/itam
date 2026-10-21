"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight, CheckCircle2, XCircle, PackageCheck, Truck, Undo2, Flag, Ban,
  HelpCircle, UserCheck, AlertTriangle, Loader2, ScanLine, FileQuestion, ChevronLeft,
} from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Button, buttonClass } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Tabs, tabId, panelId } from "@/components/ui/tabs";
import { Field, inputClass, Select } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import { StatusChip } from "@/components/ui/status-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { RequestStatusBadge } from "@/components/requests/request-status-badge";
import { RequestAttachments } from "@/components/requests/request-attachments";
import { RequestLifecycleStepper } from "@/components/requests/request-lifecycle-stepper";
import { PartyTag, RequestNumber, ResponsibleCell } from "@/components/requests/request-list-bits";
import {
  Callout, DetailRow, FulfillDialog, RequestDeliveryPanel, RequestHistory, RequestItemsTable,
} from "@/components/requests/request-detail-sections";
import {
  getRequest, submitRequest, approveRequest, rejectRequest, confirmDevicesReady,
  deliverRequest, completeRequest, cancelRequest, isOverdue,
  secondaryApproveRequest, getDeliveryRequirements,
  requestClarification, assignResponsibleToMe, fulfillRequestItem,
  convertRequestItemToPr, getRequestFormData, getCurrentUserId,
  inspectReturnRequest, changeReservedAsset,
  type RequestRow, type RequestItemRow, type RequestEventRow, type RequestFormData,
  type RequestItemPurchaseLink, type InspectionCondition,
  type DeliveryRequirements, type DeliveryEvidence, type RequestAssetAllocation,
  getRequestAssetAllocations, selectExactRequestAsset,
} from "@/lib/requests";
import { useSession, useCan, canWrite as canWriteFor, canManageRequestAttachments, canSeeFinancial as canSeeFinancialFor } from "@/lib/session";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { formatDate, formatDateTime, formatSAR } from "@/lib/format";
import { friendlyErrorStrict } from "@/lib/user-facing-errors";
import { assetMatchesNeed } from "@/lib/request-options";
import { requestActionMap, type RequestActionKey } from "@/lib/request-fulfillment";
import { scanLookup } from "@/lib/queries";
import { requestDetailNavigation } from "@/lib/request-navigation";

type Tab = "items" | "delivery" | "attachments" | "history";

export default function RequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { role } = useSession();
  const can = useCan();
  const { t, lang } = useAppPreferences();
  const { isVisible } = useFeatureExposure();
  const tr = t.requests;
  const tl = tr.ledger;
  const canWrite = canWriteFor(role);
  const canApprove = can("request.approve"); // بوابة الاعتماد/الرفض/التوضيح (مطابقة للحارس في القاعدة)
  const fin = canSeeFinancialFor(role);

  const [request, setRequest] = useState<RequestRow | null>(null);
  const [items, setItems] = useState<RequestItemRow[]>([]);
  const [events, setEvents] = useState<RequestEventRow[]>([]);
  const [purchaseLinks, setPurchaseLinks] = useState<Record<string, RequestItemPurchaseLink>>({});
  const [responsibleLabel, setResponsibleLabel] = useState<string | null>(null);
  const [myUid, setMyUid] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>("items");
  const [toast, setToast] = useState<ToastState>(null);
  const [busy, setBusy] = useState(false);
  const [queueNavigation, setQueueNavigation] = useState<ReturnType<typeof requestDetailNavigation>>({
    returnTo: "/requests", nextId: null, nextHref: null,
  });
  const [busyAction, setBusyAction] = useState<RequestActionKey | "fulfill" | null>(null);
  const busyRef = useRef(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [clarifyOpen, setClarifyOpen] = useState(false);
  const [clarifyMsg, setClarifyMsg] = useState("");
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [deliveryReceiver, setDeliveryReceiver] = useState("");
  const [deliveryNotes, setDeliveryNotes] = useState("");
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [deliveryOperationId, setDeliveryOperationId] = useState("");
  const [deliveryRequirements, setDeliveryRequirements] = useState<DeliveryRequirements | null>(null);
  const [allocations, setAllocations] = useState<RequestAssetAllocation[]>([]);
  const [deliveryScanValue, setDeliveryScanValue] = useState("");
  const [deliveryScanOpen, setDeliveryScanOpen] = useState(false);
  const [deliveryVerifiedAssetIds, setDeliveryVerifiedAssetIds] = useState<string[]>([]);
  const [deliveryEvidence, setDeliveryEvidence] = useState<DeliveryEvidence | null>(null);
  const [deliveredByLabel, setDeliveredByLabel] = useState<string | null>(null);
  const [secondaryOpen, setSecondaryOpen] = useState(false);
  const [secondaryReason, setSecondaryReason] = useState("");
  const [inspectOpen, setInspectOpen] = useState(false);
  const [returnError, setReturnError] = useState<string | null>(null);
  const [returnScanValue, setReturnScanValue] = useState("");
  const [returnResults, setReturnResults] = useState<Record<string, { condition: InspectionCondition; notes: string }>>({});
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeItemId, setChangeItemId] = useState("");
  const [replacementAssetId, setReplacementAssetId] = useState("");
  // ربط عنصر احتياج بالمخزون
  const [fulfillTarget, setFulfillTarget] = useState<RequestItemRow | null>(null);
  const [formData, setFormData] = useState<RequestFormData | null>(null);
  const completeFinancialItems = items.length > 0
    && items.every((item) => item.total_price != null);
  const requestTotal = completeFinancialItems
    ? items.reduce((sum, item) => sum + Number(item.total_price), 0)
    : null;

  async function load() {
    const { request, items, events, responsibleLabel, deliveryEvidence, deliveredByLabel, purchaseLinks, error } = await getRequest(id, fin);
    setRequest(request); setItems(items); setEvents(events); setResponsibleLabel(responsibleLabel);
    setPurchaseLinks(purchaseLinks); setLoadErr(error); setLoaded(true);
    setDeliveryEvidence(deliveryEvidence); setDeliveredByLabel(deliveredByLabel);
    if (request) {
      const result = await getDeliveryRequirements(id);
      setDeliveryRequirements(result.requirements);
      const allocationResult = await getRequestAssetAllocations(id);
      setAllocations(allocationResult.rows);
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [id, fin]);
  useEffect(() => { getCurrentUserId().then(setMyUid); }, []);
  useEffect(() => {
    setQueueNavigation(requestDetailNavigation(window.location.search, id));
  }, [id]);

  // يفتح حوار ربط عنصر احتياج بالمخزون (يحمّل الأصول/المستهلكات المتاحة عند أول فتح).
  async function openFulfill(it: RequestItemRow) {
    if (!formData) { const fd = await getRequestFormData(); setFormData(fd); }
    setFulfillTarget(it);
  }

  // يحوّل رمز الخطأ (state_not_deliverable…) إلى نص مترجَم؛ يمرّر الرسائل غير المعروفة كما هي.
  const errLabel = (code: string) => (tr.err as Record<string, string>)[code] ?? code;

  // مشغّل عام: يدعم الدوال التي تُعيد string|null والدوال التي تُعيد {error,warnings}
  async function run(
    fn: () => Promise<string | null | { error: string | null; warnings: string[] }>,
    ok: string,
    action: RequestActionKey | "fulfill" = "fulfill",
  ): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setBusyAction(action);
    try {
      const res = await fn();
      if (res && typeof res === "object") {
        if (res.error) { setToast({ type: "error", message: tr.actionError + errLabel(res.error) }); return false; }
        setToast({ type: "success", message: res.warnings.length ? tr.partialWarning : ok });
      } else {
        if (res) { setToast({ type: "error", message: tr.actionError + errLabel(res) }); return false; }
        setToast({ type: "success", message: ok });
      }
      await load();
      return true;
    } catch (e) {
      // H3: مسار فشل مُلقى (شبكة/استثناء غير متوقع) كان يمرّ صامتًا ويُبقي «busy» عالقًا
      // (الأزرار مجمّدة بلا أي رسالة). نضمن إشعار خطأ عربيًا صريحًا وإعادة تفعيل الأزرار دائمًا،
      // دون افتراض أي تغيير في عقد الخادم الحالي.
      setToast({ type: "error", message: tr.actionError + errLabel(e instanceof Error ? e.message : String(e)) });
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
      setBusyAction(null);
    }
  }

  function openInspect() {
    setReturnError(null);
    setReturnScanValue("");
    setReturnResults({});
    setInspectOpen(true);
  }
  async function submitInspect() {
    const lines = Object.entries(returnResults).map(([asset_id, result]) => ({ asset_id, condition: result.condition, notes: result.notes.trim() || null }));
    if (!lines.length) { setReturnError(tr.returnScanRequired); return; }
    if (lines.some((line) => line.condition === "needs_inspection" && !line.notes)) { setReturnError(tr.returnNotesRequired); return; }
    const ok = await run(() => inspectReturnRequest(id, lines), tr.inspectedToast, "receive_return");
    if (ok) setInspectOpen(false);
  }

  function verifyReturnAsset() {
    const value = returnScanValue.trim().toLocaleLowerCase();
    if (!value) return;
    const allocation = allocations.filter((item) => item.state === "delivered").find((item) => (item.asset_tag ?? "").trim().toLocaleLowerCase() === value);
    if (!allocation) { setReturnError(tr.returnScanWrong); return; }
    if (returnResults[allocation.asset_id]) { setReturnError(tr.returnScanDuplicate); return; }
    setReturnResults((results) => ({ ...results, [allocation.asset_id]: { condition: "sound", notes: "" } }));
    setReturnScanValue("");
    setReturnError(null);
  }

  function openDelivery() {
    setDeliveryReceiver("");
    setDeliveryNotes("");
    setDeliveryScanValue("");
    setDeliveryScanOpen(false);
    setDeliveryVerifiedAssetIds([]);
    setDeliveryError(null);
    setDeliveryOperationId(crypto.randomUUID());
    setDeliveryOpen(true);
  }

  async function submitDelivery() {
    const receiver = deliveryReceiver.trim();
    if (!receiver) { setDeliveryError(tr.recipientNameRequired); return; }
    if (receiver.length < 2) { setDeliveryError(tr.recipientNameTooShort); return; }
    if (receiver.length > 160) { setDeliveryError(tr.recipientNameTooLong); return; }
    const normalizedReceiver = receiver.replace(/\s+/g, " ").toLocaleLowerCase();
    const normalizedOrganization = receivingOrganization.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    if (normalizedReceiver === normalizedOrganization) { setDeliveryError(tr.recipientCannotBeOrganization); return; }
    setDeliveryError(null);
    const preparedAssets = allocations.filter((allocation) => allocation.state === "prepared");
    if (preparedAssets.length > 0 && deliveryVerifiedAssetIds.length !== preparedAssets.length) {
      setDeliveryError(tr.deliveryVerifiedProgress.replace("{done}", String(deliveryVerifiedAssetIds.length)).replace("{total}", String(preparedAssets.length)));
      return;
    }
    const ok = await run(() => deliverRequest(id, {
      receiver_name: receiver,
      delivery_notes: deliveryNotes.trim() || null,
      acknowledged: true,
      verified_asset_ids: deliveryVerifiedAssetIds,
    }, deliveryOperationId), tr.deliveredToast, "deliver");
    if (ok) setDeliveryOpen(false);
  }

  async function verifyDeliveryAsset() {
    const value = deliveryScanValue.trim().toLocaleLowerCase();
    if (!value) return;
    const prepared = allocations.filter((allocation) => allocation.state === "prepared");
    let allocation = prepared.find((item) => (item.asset_tag ?? "").trim().toLocaleLowerCase() === value);
    if (!allocation) {
      let matches: Awaited<ReturnType<typeof scanLookup>>;
      try { matches = await scanLookup(deliveryScanValue); }
      catch { setDeliveryError(tr.deliveryScanUnknown); return; }
      allocation = prepared.find((item) => matches.some((match) => match.type === "asset" && match.id === item.asset_id));
      if (!allocation) {
        setDeliveryError(matches.some((match) => match.type === "asset") ? tr.deliveryScanWrong : tr.deliveryScanUnknown);
        return;
      }
    }
    if (deliveryVerifiedAssetIds.includes(allocation.asset_id)) { setDeliveryError(tr.deliveryScanDuplicate); return; }
    setDeliveryVerifiedAssetIds((ids) => [...ids, allocation.asset_id]);
    setDeliveryScanValue("");
    setDeliveryError(null);
  }

  function toggleDeliveryAsset(assetId: string) {
    setDeliveryVerifiedAssetIds((ids) => ids.includes(assetId)
      ? ids.filter((id) => id !== assetId)
      : [...ids, assetId]);
    setDeliveryError(null);
  }

  if (!loaded) {
    return (
      <div className="animate-pulse space-y-4" aria-hidden="true">
        <div className="h-4 w-32 rounded bg-sunk" />
        <div className="h-9 w-72 rounded-lg bg-sunk" />
        <div className="h-28 rounded-card bg-sunk" />
        <div className="h-72 rounded-card bg-sunk" />
      </div>
    );
  }
  if (loadErr || !request) {
    return (
      <Card>
        <EmptyState icon={FileQuestion} title={loadErr ? friendlyErrorStrict(loadErr, lang) : tr.notFound}
          action={<Link href={queueNavigation.returnTo} className={buttonClass("outline", "sm")}><ArrowRight aria-hidden="true" className="rtl:rotate-180" />{tr.back}</Link>} />
      </Card>
    );
  }

  const r = request;
  const st = r.status;
  // طلب موظف داخلي (عهدة): التسليم يسجّل العهدة على الموظف المستفيد ويُكمل الطلب فورًا.
  const isEmployeeReq = r.beneficiary_type === "employee";
  const beneficiaryName = r.beneficiary_employee
    ? `${r.beneficiary_employee.full_name_ar ?? r.beneficiary_employee.full_name}${r.beneficiary_employee.employee_no ? ` · ${r.beneficiary_employee.employee_no}` : ""}`
    : null;
  const over = isOverdue(r);
  const custName = isEmployeeReq
    ? (beneficiaryName ?? tr.requesterEmployee)
    : (r.customer?.name ?? r.customer_name_snapshot ?? tr.externalCustomer);
  const custPhone = r.customer?.phone ?? r.contact_phone_snapshot;
  // الجهة الطالبة (ثلاثية): بوابة عميل / عميل (إدخال داخلي) / موظف داخلي
  const partyLabel = r.request_source === "client_portal" ? tr.partyPortal : isEmployeeReq ? tr.partyEmployee : tr.partyCustomer;
  const receivingOrganization = isEmployeeReq ? partyLabel : custName;

  const expLifecycle = isVisible("requests.prepareDeliverReturn", { requestStatus: st });
  // ربط عناصر الاحتياج بالمخزون متاح قبل التسليم فقط (مطابق لحالات request_item_fulfill).
  const fulfillableState = ["under_review", "needs_clarification", "approved", "preparing", "provisioned", "stock_shortage"].includes(st);
  // ملخّص التجهيز (عدد الأجهزة المحجوزة مقابل الاحتياج غير المُلبّى)
  const provisionedCount = items.filter((it) => it.item_kind === "asset").length;
  const missingCount = items
    .filter((it) => it.item_kind === "custom" && it.requested_kind === "existing_asset" && !it.asset_id && !it.needs_purchase)
    .reduce((s, it) => s + (it.quantity ?? 0), 0);
  // F-A: أي جهاز مُسلَّم لم يُرجَع بعد (item_kind='asset' و delivered_quantity > returned_quantity)
  // لا تستنتج الواجهة معنى تجاريًا من request_type القديم. وجود أصل مُسلَّم
  // وغير مُعاد هو الحقيقة المعروضة؛ الحارس الخادمي هو مرجع قرار الإكمال النهائي.
  const hasOutstandingAssetReturns = allocations.some((allocation) => allocation.state === "delivered") || items.some(
    (it) => it.item_kind === "asset" && (it.delivered_quantity ?? 0) > (it.returned_quantity ?? 0),
  );
  const reservedItems = items.filter(
    (it) => it.item_kind === "asset" && it.asset_id && it.asset?.status === "reserved" && (it.delivered_quantity ?? 0) === 0,
  );
  const actions = requestActionMap({
    status: st,
    role,
    hasOutstandingReturns: hasOutstandingAssetReturns,
    hasReservedDevices: reservedItems.length > 0,
    secondApprovalRequired: Boolean(deliveryRequirements?.second_approval_required),
    secondApprovalComplete: Boolean(deliveryRequirements?.second_approval_complete),
  });
  if (!expLifecycle && actions.primary && actions.primary !== "submit") actions.primary = null;

  const selectedChangeItem = reservedItems.find((it) => it.id === changeItemId) ?? null;
  const replacementOptions = (formData?.assets ?? [])
    .filter((asset) => asset.status === "available")
    .filter((asset) => !selectedChangeItem || assetMatchesNeed(asset, selectedChangeItem));

  async function openChangeReserved() {
    if (!formData) {
      const fd = await getRequestFormData();
      setFormData(fd);
    }
    setChangeItemId(reservedItems[0]?.id ?? "");
    setReplacementAssetId("");
    setChangeOpen(true);
  }

  async function submitReservedChange() {
    if (!changeItemId || !replacementAssetId) return;
    const ok = await run(
      () => changeReservedAsset(changeItemId, replacementAssetId),
      tr.reservedDeviceChangedToast,
      "change_reserved",
    );
    if (ok) setChangeOpen(false);
  }

  const actionLabel = (action: RequestActionKey): string => ({
    submit: tr.submit,
    approve: tr.approve,
    clarify: tr.requestClarification,
    reject: tr.reject,
    confirm_ready: tr.markReady,
    deliver: tr.deliver,
    receive_return: tr.inspectAndReturn,
    close: tr.complete,
    change_reserved: tr.changeReservedDevices,
    secondary_approval: tr.secondaryApproval,
    cancel: tr.cancel,
  })[action];

  function actionIcon(action: RequestActionKey) {
    if (busyAction === action) return <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />;
    switch (action) {
      case "reject": return <XCircle className="h-4 w-4" aria-hidden="true" />;
      case "clarify": return <HelpCircle className="h-4 w-4" aria-hidden="true" />;
      case "confirm_ready": return <PackageCheck className="h-4 w-4" aria-hidden="true" />;
      case "deliver": return <Truck className="h-4 w-4" aria-hidden="true" />;
      case "receive_return": return <Undo2 className="h-4 w-4" aria-hidden="true" />;
      case "close": return <Flag className="h-4 w-4" aria-hidden="true" />;
      case "cancel": return <Ban className="h-4 w-4" aria-hidden="true" />;
      case "secondary_approval": return <UserCheck className="h-4 w-4" aria-hidden="true" />;
      default: return <CheckCircle2 className="h-4 w-4" aria-hidden="true" />;
    }
  }

  function invokeAction(action: RequestActionKey) {
    switch (action) {
      case "submit": void run(() => submitRequest(id), tr.submittedToast, action); break;
      case "approve": void run(() => approveRequest(id), tr.approved, action); break;
      case "clarify": setClarifyMsg(""); setClarifyOpen(true); break;
      case "reject": setRejectReason(""); setRejectError(null); setRejectOpen(true); break;
      case "confirm_ready": void run(() => confirmDevicesReady(id), tr.readyToast, action); break;
      case "deliver": openDelivery(); break;
      case "receive_return": openInspect(); break;
      case "close": void run(() => completeRequest(id), tr.completedToast, action); break;
      case "change_reserved": void openChangeReserved(); break;
      case "secondary_approval": setSecondaryReason(""); setSecondaryOpen(true); break;
      case "cancel": setCancelOpen(true); break;
    }
  }

  async function submitReject() {
    const reason = rejectReason.trim();
    if (reason.length < 3) {
      setRejectError(tr.rejectReasonRequired);
      return;
    }
    setRejectError(null);
    const ok = await run(() => rejectRequest(id, reason), tr.rejectedToast, "reject");
    if (ok) setRejectOpen(false);
  }

  const showAttachments = isVisible("requests.attachments", { requestStatus: st });
  const TABS: { key: Tab; label: string; count?: number }[] = [
    { key: "items", label: tl.tabItems, count: items.length },
    { key: "delivery", label: tl.tabDelivery },
    ...(showAttachments ? [{ key: "attachments" as Tab, label: tr.attachments.tab }] : []),
    { key: "history", label: tl.tabHistory, count: events.length + 1 },
  ];
  const activeTab: Tab = tab === "attachments" && !showAttachments ? "items" : tab;
  const dateDir = lang === "ar" ? "rtl" : "ltr";
  const hasActions = Boolean(actions.primary) || actions.review.length > 0 || actions.secondary.length > 0;
  const preparedCount = allocations.filter((allocation) => allocation.state === "prepared").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={queueNavigation.returnTo} className="inline-flex min-h-9 items-center gap-1.5 text-[13px] font-medium text-fg-2 hover:text-brand-ink"><ArrowRight aria-hidden="true" className="h-4 w-4 rtl:rotate-180" />{tr.back}</Link>
        {queueNavigation.nextHref && (
          <Link href={queueNavigation.nextHref} className={buttonClass("outline", "sm")}>
            {tr.nextInQueue}<ChevronLeft aria-hidden="true" className="ltr:rotate-180" />
          </Link>
        )}
      </div>

      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {r.project_name && <RequestNumber className="text-[13px] text-fg-2">{r.request_number}</RequestNumber>}
            <RequestStatusBadge status={st} />
            {over && <StatusChip tone="bad">{tr.overdueBadge}</StatusChip>}
            <PartyTag>{partyLabel}</PartyTag>
          </div>
          <h1 className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-fg sm:text-[28px] sm:leading-9">
            {r.project_name ?? <RequestNumber>{r.request_number}</RequestNumber>}
          </h1>
          <p className="mt-1 text-sm text-fg-2">
            {custName}{r.project_city ? ` · ${r.project_city}` : ""} · <span className="tabular-nums">{items.length}</span> {tr.itemsCount}
          </p>
        </div>
        <div className="page-header-actions flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          {actions.secondary.map((action) => (
            <Button
              key={action}
              variant={action === "cancel" ? "danger-ghost" : "outline"}
              onClick={() => invokeAction(action)}
              disabled={busy}
              className="flex-1 sm:flex-none"
            >
              {actionIcon(action)}{actionLabel(action)}
            </Button>
          ))}
          {actions.review.map((action) => (
            <Button
              key={action}
              variant={action === "reject" ? "danger-ghost" : action === "approve" ? "primary" : "outline"}
              onClick={() => invokeAction(action)}
              disabled={busy}
              className="flex-1 sm:flex-none"
            >
              {actionIcon(action)}{actionLabel(action)}
            </Button>
          ))}
          {actions.primary && (
            <Button
              onClick={() => invokeAction(actions.primary as RequestActionKey)}
              disabled={busy}
              className="w-full sm:w-auto"
            >
              {actionIcon(actions.primary)}{actionLabel(actions.primary)}
            </Button>
          )}
          {!hasActions && <p className="text-[13px] text-muted">{tr.noActionRequired}</p>}
        </div>
      </header>

      {/* ملاحظات الحالة */}
      {st === "ready_for_pickup" && deliveryRequirements?.second_approval_required && (
        <Callout tone="warn" icon={<AlertTriangle />}>{tr.highRiskDeliveryHint}</Callout>
      )}
      {st === "rejected" && r.rejection_reason && (
        <Callout tone="bad" icon={<XCircle />}><span className="font-semibold">{tr.rejectionReason}:</span> {r.rejection_reason}</Callout>
      )}
      {st === "needs_clarification" && (
        <Callout tone="warn" icon={<HelpCircle />}>{tr.needsClarificationNote}</Callout>
      )}
      {st === "stock_shortage" && (
        <Callout tone="warn" icon={<AlertTriangle />}>
          <span className="font-semibold">{tr.shortageTitle}</span> — {tr.shortageDesc}
          <span className="ms-1 tabular-nums">{tr.shortageProvisioned}: {provisionedCount} · {tr.shortageMissing}: {missingCount}</span>
        </Callout>
      )}
      {st === "provisioned" && (
        <Callout tone="info" icon={<PackageCheck />}>{tr.provisionReviewNote}</Callout>
      )}

      <RequestLifecycleStepper request={r} overdue={over} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
        <Card className="overflow-hidden">
          <div className="px-5 pt-2 sm:px-6">
            <Tabs idBase="request-detail" label={tl.sectionsLabel} value={activeTab} onChange={setTab}
              items={TABS.map((tb) => ({ key: tb.key, label: tb.label, count: tb.count }))} />
          </div>
          <div role="tabpanel" id={panelId("request-detail", activeTab)} aria-labelledby={tabId("request-detail", activeTab)} tabIndex={0}
            className="focus-visible:outline-none">
            {activeTab === "items" && (
              <RequestItemsTable
                items={items}
                allocations={allocations}
                purchaseLinks={purchaseLinks}
                fin={fin}
                canWrite={canWrite}
                canApprove={canApprove}
                fulfillableState={fulfillableState}
                busy={busy}
                onFulfill={(it) => void openFulfill(it)}
                onConvert={(it) => void run(() => convertRequestItemToPr(it.id), tr.convertedToast)}
              />
            )}
            {activeTab === "delivery" && (
              <RequestDeliveryPanel
                request={r}
                evidence={deliveryEvidence}
                deliveredByLabel={deliveredByLabel}
                receivingOrganization={receivingOrganization}
                provisionedCount={provisionedCount}
                allocations={allocations}
                isEmployeeReq={isEmployeeReq}
                beneficiaryName={beneficiaryName}
                overdue={over}
              />
            )}
            {activeTab === "attachments" && showAttachments && (
              <RequestAttachments
                requestId={id}
                canWrite={canManageRequestAttachments(role)}
                canSetCustomerVisibility={fin}
              />
            )}
            {activeTab === "history" && <RequestHistory request={r} events={events} />}
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title={tl.detailsTitle} />
            <dl className="px-5 py-3 text-[13.5px]">
              {isEmployeeReq ? (
                <>
                  <DetailRow label={tr.beneficiaryEmployee} value={beneficiaryName ?? "—"} />
                  <DetailRow label={tr.requestReason} value={r.project_name ?? "—"} />
                </>
              ) : (
                <>
                  <DetailRow label={tr.customer} value={custName} />
                  <DetailRow label={tr.phone} value={<bdi dir="ltr" className="tabular-nums">{custPhone ?? "—"}</bdi>} />
                  <DetailRow label={tr.projectName} value={r.project_name ?? "—"} />
                  <DetailRow label={tr.city} value={r.project_city ?? "—"} />
                </>
              )}
              <DetailRow label={tr.requesterParty} value={<PartyTag>{partyLabel}</PartyTag>} />
              <DetailRow label={tr.createdAt} value={<span className="tabular-nums">{formatDateTime(r.created_at, lang)}</span>} dir={dateDir} />
              {r.approved_at && <DetailRow label={tr.approvedAt} value={<span className="tabular-nums">{formatDateTime(r.approved_at, lang)}</span>} dir={dateDir} />}
              <DetailRow label={isEmployeeReq ? tr.needDate : tr.pickupDate} value={<span className="tabular-nums">{r.pickup_date ? formatDate(r.pickup_date, lang) : "—"}</span>} dir={dateDir} />
              <DetailRow label={tr.returnDate} value={<span className={`tabular-nums ${over ? "font-semibold text-bad" : ""}`}>{r.return_date ? formatDate(r.return_date, lang) : "—"}</span>} dir={dateDir} />
              <DetailRow label={tr.items} value={<span className="tabular-nums">{String(items.length)}</span>} />
              {fin && (
                <DetailRow
                  label={tr.totalValue}
                  value={<span className="tabular-nums">{requestTotal != null ? formatSAR(requestTotal, lang) : "—"}</span>}
                />
              )}
              {r.notes && <DetailRow label={tr.notes} value={<span className="whitespace-pre-wrap font-normal">{r.notes}</span>} />}
            </dl>

            {/* المسؤول */}
            <div className="border-t border-line px-5 py-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-fg">{tr.responsible}</h3>
                {canApprove && r.responsible_employee_id !== myUid && (
                  <Button variant="ghost" size="sm" onClick={() => run(() => assignResponsibleToMe(id), tr.responsibleAssignedToast)} disabled={busy} className="text-brand-ink">
                    <UserCheck aria-hidden="true" />{tr.assignToMe}
                  </Button>
                )}
              </div>
              <ResponsibleCell label={r.responsible_employee_id ? (responsibleLabel ?? tr.responsibleStaff) : null} unassignedLabel={tr.responsibleUnassigned} />
            </div>

            {/* الملاحظات الداخلية */}
            <div className="border-t border-line px-5 py-4">
              <h3 className="mb-1.5 text-sm font-semibold text-fg">{tr.internalNotesTab}</h3>
              <p className={`whitespace-pre-wrap text-[13px] ${r.internal_notes ? "text-fg-2" : "text-muted"}`}>{r.internal_notes || tr.noInternalNotes}</p>
            </div>
          </Card>
        </div>
      </div>

      {/* Reject dialog */}
      <Dialog open={rejectOpen} onClose={() => setRejectOpen(false)} title={tr.confirmReject}
        footer={<><Button variant="outline" onClick={() => setRejectOpen(false)}>{t.common.cancel}</Button><Button variant="danger" disabled={busy} onClick={() => void submitReject()}>{busyAction === "reject" && <Loader2 className="h-4 w-4 animate-spin" />}{tr.confirmReject}</Button></>}>
        <Field label={tr.rejectReasonLabel} required error={rejectError ?? undefined}>
          <textarea className={`${inputClass} resize-none`} rows={3} value={rejectReason} onChange={(e) => { setRejectReason(e.target.value); setRejectError(null); }} placeholder={tr.rejectReasonOptional} maxLength={500} />
        </Field>
      </Dialog>

      {/* Cancel dialog */}
      <Dialog open={cancelOpen} onClose={() => setCancelOpen(false)} title={tr.confirmCancelTitle}
        footer={<><Button variant="outline" onClick={() => setCancelOpen(false)}>{t.common.cancel}</Button><Button variant="danger" disabled={busy} onClick={async () => { const ok = await run(() => cancelRequest(id), tr.cancelledToast, "cancel"); if (ok) setCancelOpen(false); }}>{busyAction === "cancel" && <Loader2 className="h-4 w-4 animate-spin" />}{tr.cancel}</Button></>}>
        <p className="text-sm text-fg-2">{tr.confirmCancelDesc}</p>
      </Dialog>

      {/* Clarification dialog */}
      <Dialog open={clarifyOpen} onClose={() => setClarifyOpen(false)} title={isEmployeeReq ? tr.clarificationTitleEmployee : tr.clarificationTitle}
        footer={<><Button variant="outline" onClick={() => setClarifyOpen(false)}>{t.common.cancel}</Button><Button disabled={busy} onClick={() => { setClarifyOpen(false); run(() => requestClarification(id, clarifyMsg.trim() || null), isEmployeeReq ? tr.clarificationSentToastEmployee : tr.clarificationSentToast); }}>{tr.requestClarification}</Button></>}>
        <Field label={isEmployeeReq ? tr.clarificationLabelEmployee : tr.clarificationLabel}>
          <textarea className={`${inputClass} resize-none`} rows={3} value={clarifyMsg} onChange={(e) => setClarifyMsg(e.target.value)} placeholder={tr.clarificationPlaceholder} />
        </Field>
      </Dialog>

      <Dialog open={secondaryOpen} onClose={() => setSecondaryOpen(false)} title={tr.secondaryApproval}
        footer={<><Button variant="outline" onClick={() => setSecondaryOpen(false)}>{t.common.cancel}</Button><Button disabled={busy || secondaryReason.trim().length < 3} onClick={async () => { const reason = secondaryReason.trim(); const ok = await run(() => secondaryApproveRequest(id, reason), tr.secondaryApprovedToast, "secondary_approval"); if (ok) setSecondaryOpen(false); }}>{busyAction === "secondary_approval" && <Loader2 className="h-4 w-4 animate-spin" />}{tr.secondaryApproval}</Button></>}>
        <div className="space-y-3">
          <p className="text-sm text-fg-2">{tr.secondaryApprovalHint}</p>
          <textarea className={`${inputClass} min-h-24 resize-none`} value={secondaryReason} onChange={(e) => setSecondaryReason(e.target.value)} placeholder={tr.secondaryApprovalReason} aria-label={tr.secondaryApprovalReason} />
        </div>
      </Dialog>

      <Dialog open={deliveryOpen} onClose={() => setDeliveryOpen(false)} title={tr.deliveryProofTitle} size="xl"
        footer={<><Button variant="outline" onClick={() => setDeliveryOpen(false)}>{t.common.cancel}</Button><Button disabled={busy || !deliveryReceiver.trim() || (allocations.some((allocation) => allocation.state === "prepared") && deliveryVerifiedAssetIds.length !== allocations.filter((allocation) => allocation.state === "prepared").length)} onClick={() => void submitDelivery()}>{busyAction === "deliver" && <Loader2 className="h-4 w-4 animate-spin" />}{tr.confirmDelivery}</Button></>}>
        <div className="space-y-4">
          <div>
            <p className="ui-label">{tr.receivingOrganization}</p>
            <p className="rounded-control border border-line bg-sunk px-3 py-2.5 text-[13.5px] font-medium text-fg">{receivingOrganization}</p>
          </div>
          <Field label={tr.recipientPersonName} required hint={tr.recipientPersonHint} error={deliveryError ?? undefined}>
            <input className={inputClass} value={deliveryReceiver} onChange={(e) => { setDeliveryReceiver(e.target.value); setDeliveryError(null); }} placeholder={tr.recipientPersonPlaceholder} maxLength={160} autoComplete="name" />
          </Field>
          {allocations.some((allocation) => allocation.state === "prepared") && (
            <div className="rounded-xl border border-line p-3.5 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-fg">{tr.deliveryVerifyTitle}</p>
                  <p className="mt-0.5 text-xs leading-5 text-fg-2">{tr.deliveryVerifyHint}</p>
                  <p className="text-xs leading-5 text-fg-2">{tr.deliveryScanHint}</p>
                </div>
                <StatusChip tone={deliveryVerifiedAssetIds.length === preparedCount ? "ok" : "neu"} size="sm">
                  <span className="tabular-nums">{deliveryVerifiedAssetIds.length}/{preparedCount}</span>
                </StatusChip>
              </div>
              <ul className="mt-3 space-y-2">
                {allocations.filter((allocation) => allocation.state === "prepared").map((asset) => {
                  const verified = deliveryVerifiedAssetIds.includes(asset.asset_id);
                  const deviceName = asset.name ?? asset.model ?? tr.unnamedAsset;
                  const label = `${asset.asset_tag ?? tr.unknownAssetTag} — ${deviceName}`;
                  return <li key={asset.asset_id}>
                    <label className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-start transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/40 ${verified ? "border-ok bg-ok-soft" : "border-line hover:border-muted"}`}>
                      <input type="checkbox" checked={verified} onChange={() => toggleDeliveryAsset(asset.asset_id)} className="h-5 w-5 shrink-0 accent-brand" aria-label={label} />
                      <span className="min-w-0 flex-1"><span className="block font-mono text-sm font-semibold text-fg" dir="ltr">{asset.asset_tag ?? tr.unknownAssetTag}</span><span className="block truncate text-xs text-fg-2">{deviceName}</span></span>
                      <span className={`text-xs font-semibold ${verified ? "text-ok" : "text-muted"}`}>{verified ? tr.deliveryAssetVerified : tr.deliveryAssetPending}</span>
                    </label>
                  </li>;
                })}
              </ul>
              <p className="mt-3 text-xs font-medium text-fg-2">{deliveryVerifiedAssetIds.length === allocations.filter((allocation) => allocation.state === "prepared").length ? tr.deliveryVerifiedComplete : tr.deliveryVerifiedProgress.replace("{done}", String(deliveryVerifiedAssetIds.length)).replace("{total}", String(allocations.filter((allocation) => allocation.state === "prepared").length))}</p>
              <Button type="button" variant="outline" size="sm" className="mt-3" aria-expanded={deliveryScanOpen} onClick={() => setDeliveryScanOpen((open) => !open)}><ScanLine aria-hidden="true" />{tr.deliveryScanAction}</Button>
              {deliveryScanOpen && <div className="mt-2 flex gap-2">
                  <input className={inputClass} value={deliveryScanValue} onChange={(event) => { setDeliveryScanValue(event.target.value); setDeliveryError(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void verifyDeliveryAsset(); } }} placeholder={tr.deliveryScanLabel} aria-label={tr.deliveryScanLabel} dir="ltr" />
                  <Button type="button" variant="outline" onClick={() => void verifyDeliveryAsset()}>{tr.deliveryVerify}</Button>
                </div>}
            </div>
          )}
          {!deliveryReceiver.trim() ? <p className="text-xs font-medium text-warn">{tr.deliveryRecipientRequiredHint}</p> : allocations.some((allocation) => allocation.state === "prepared") && deliveryVerifiedAssetIds.length !== allocations.filter((allocation) => allocation.state === "prepared").length ? <p className="text-xs font-medium text-warn">{tr.deliveryVerificationRequiredHint}</p> : null}
          <Field label={tr.deliveryNotes} hint={tr.optional}>
            <textarea className={`${inputClass} resize-none`} rows={3} value={deliveryNotes} onChange={(e) => setDeliveryNotes(e.target.value)} maxLength={1000} />
          </Field>
        </div>
      </Dialog>

      {/* Receive returned devices dialog */}
      <Dialog open={inspectOpen} onClose={() => setInspectOpen(false)} title={tr.inspectTitle} size="xl"
        footer={<><Button variant="outline" onClick={() => setInspectOpen(false)}>{t.common.cancel}</Button><Button disabled={busy || !hasOutstandingAssetReturns} onClick={() => void submitInspect()}>{busyAction === "receive_return" && <Loader2 className="h-4 w-4 animate-spin" />}{tr.inspectSubmit}</Button></>}>
        {!hasOutstandingAssetReturns ? (
          <EmptyState compact icon={Undo2} title={tr.inspectEmpty} />
        ) : (
          <div className="space-y-4">
            <Field label={tr.returnScanLabel} error={returnError ?? undefined}>
              <div className="flex gap-2"><input className={inputClass} value={returnScanValue} onChange={(event) => { setReturnScanValue(event.target.value); setReturnError(null); }} placeholder={tr.returnScanLabel} aria-label={tr.returnScanLabel} dir="ltr" /><Button type="button" variant="outline" onClick={verifyReturnAsset}>{tr.returnVerify}</Button></div>
            </Field>
            {allocations.filter((allocation) => allocation.state === "delivered").map((allocation) => returnResults[allocation.asset_id] ? (
              <div key={allocation.asset_id} className="rounded-xl border border-line p-3.5">
                <p className="font-mono text-sm font-semibold text-fg" dir="ltr">{allocation.asset_tag ?? "—"} — {allocation.name ?? "—"}</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2"><Select value={returnResults[allocation.asset_id].condition} label={tr.returnCondition} onChange={(value) => setReturnResults((results) => ({ ...results, [allocation.asset_id]: { ...results[allocation.asset_id], condition: value as InspectionCondition } }))} options={(["sound", "needs_inspection"] as const).map((condition) => ({ value: condition, label: tr.cond[condition] }))} /><input className={inputClass} value={returnResults[allocation.asset_id].notes} onChange={(event) => setReturnResults((results) => ({ ...results, [allocation.asset_id]: { ...results[allocation.asset_id], notes: event.target.value } }))} placeholder={tr.inspectNotesPh} aria-label={tr.returnNotes} maxLength={1000} /></div>
              </div>
            ) : null)}
          </div>
        )}
      </Dialog>

      <Dialog open={changeOpen} onClose={() => setChangeOpen(false)} title={tr.changeReservedTitle}
        footer={<><Button variant="outline" onClick={() => setChangeOpen(false)}>{t.common.cancel}</Button><Button disabled={busy || !changeItemId || !replacementAssetId} onClick={() => void submitReservedChange()}>{busyAction === "change_reserved" && <Loader2 className="h-4 w-4 animate-spin" />}{tr.confirmDeviceChange}</Button></>}>
        <div className="space-y-4">
          <p className="text-sm text-fg-2">{tr.changeReservedDesc}</p>
          <Field label={tr.currentReservedDevice} required>
            <Select value={changeItemId} onChange={(value) => { setChangeItemId(value); setReplacementAssetId(""); }} placeholder={tr.chooseReservedDevice}
              options={reservedItems.map((item) => ({ value: item.id, label: [item.asset?.asset_tag, item.asset?.name].filter(Boolean).join(" · ") || "—" }))} />
          </Field>
          <Field label={tr.replacementDevice} required hint={replacementOptions.length === 0 ? tr.noReplacementDevices : undefined}>
            <Select value={replacementAssetId} onChange={setReplacementAssetId} placeholder={tr.chooseReplacementDevice}
              options={replacementOptions.map((asset) => ({ value: asset.id, label: [asset.asset_tag, asset.name, asset.serial_number ? `SN: ${asset.serial_number}` : null].filter(Boolean).join(" · ") }))} />
          </Field>
        </div>
      </Dialog>

      {/* Fulfill (link inventory) dialog */}
      <FulfillDialog target={fulfillTarget} formData={formData} tr={tr} t={t} busy={busy}
        onClose={() => setFulfillTarget(null)}
        onConfirm={(ref) => { const it = fulfillTarget; setFulfillTarget(null); if (it) run(() => ref.assetId && it.requested_kind === "existing_asset" ? selectExactRequestAsset(it.id, ref.assetId) : fulfillRequestItem(it.id, ref), ref.assetId ? tr.deviceSelectedToast : tr.fulfilledToast); }} />

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}
