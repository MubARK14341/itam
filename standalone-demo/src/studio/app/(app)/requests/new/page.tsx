"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight, Plus, Trash2, Boxes, PackageOpen, ClipboardList, UserRound, Building2, Check, CalendarDays, Save, Send, ChevronLeft,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button, buttonClass } from "@/components/ui/button";
import { Field, Select, inputClass } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import { StatusChip } from "@/components/ui/status-chip";
import { EmptyState } from "@/components/ui/empty-state";
import {
  getRequestFormData, createRequest, createEmployeeRequest, type RequestFormData, type NewRequestItem,
} from "@/lib/requests";
import {
  groupAssetOptions, brandOptionsForCategory, mergeRequestDraftLine, requestHasItems, validateRequestQuantity,
} from "@/lib/request-options";
import { legacyRequestTypeForInsert } from "@/lib/request-compat";
import { isSupportedRequestDate, requestDateMaximum, riyadhTodayISO } from "@/lib/request-date-validation";
import { useSession, canWrite as canWriteFor, canManageSettings as canManageSettingsFor } from "@/lib/session";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import { FeatureUnavailablePanel } from "@/components/feature-gate";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { formatDate, formatQtyUnit } from "@/lib/format";
import { CustomerDialog } from "@/components/requests/customers-manager";

const nameOf = (x: any) => x?.name_ar ?? x?.name ?? "";

// النموذج احتياجي (Need-based): لا اختيار أصل فردي/asset_tag/serial هنا إطلاقًا —
// عناصر الأصول تُحفظ item_kind='custom' وتُربط بالمخزون لاحقًا في التجهيز (request_item_fulfill).
interface DraftItem extends NewRequestItem { key: string; label: string; }

type RequesterType = "customer" | "employee";
type DraftKind = "asset" | "consumable" | "custom";
// خطوات العرض فقط — نفس الحقول ونفس التحقق ونفس استدعاء الحفظ.
const FORM_STEPS = ["party", "items", "dates", "review"] as const;
type FormStep = (typeof FORM_STEPS)[number];

export default function NewRequestPage() {
  const router = useRouter();
  const { role, loading } = useSession();
  const { t, lang } = useAppPreferences();
  const { isVisible } = useFeatureExposure();
  const tr = t.requests;
  const tl = tr.ledger;
  const canWrite = canWriteFor(role);
  const canManageCustomers = canManageSettingsFor(role); // RLS الحارس الفعلي (ins_mgr)

  const [data, setData] = useState<RequestFormData | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [busy, setBusy] = useState(false);
  const [addCustomerOpen, setAddCustomerOpen] = useState(false);
  // أخطاء تحقّق مضمّنة (بدل الاكتفاء بإشعار عابر) — عميل/عناصر مطلوبة.
  const [formErr, setFormErr] = useState<{ customer?: string; items?: string }>({});
  // الخطوة الحالية وأبعد خطوة وصلها المستخدم (للتنقّل للخلف عبر مؤشر الخطوات).
  const [formStep, setFormStep] = useState(1);
  const [maxStep, setMaxStep] = useState(1);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(1);

  // الجهة الطالبة: عميل (الافتراضي) أو موظف داخلي (عهدة)
  const [requesterType, setRequesterType] = useState<RequesterType>("customer");

  // رأس الطلب — طلب الموظف يُنسب تلقائيًا للحساب الحالي (لا اختيار موظف).
  const [h, setH] = useState({
    customer_id: "", customer_name: "", contact_phone: "",
    project_name: "", project_city: "",
    pickup_date: "", return_date: "", notes: "", internal_notes: "",
  });
  const setHk = (k: keyof typeof h) => (v: string) => setH((s) => ({ ...s, [k]: v }));

  // عناصر الطلب — الأصل يُختار كاحتياج (تصنيف ← شركة ← موديل)، لا كجهاز فردي. بلا أي حقل سعر.
  const [items, setItems] = useState<DraftItem[]>([]);
  const [draft, setDraft] = useState({
    kind: "asset" as DraftKind,
    // brand_key = مفتاح الماركة المشتقّة (companyKey)، ليس معرّف جدول companies
    category_id: "", brand_key: "", group_key: "",
    consumable_id: "", description: "",
    quantity: "1", notes: "",
  });

  useEffect(() => { getRequestFormData().then(setData); }, []);

  // خطأ تحقّق عند الإرسال ⇒ العودة لخطوته ليظهر الخطأ بجانب الحقل.
  useEffect(() => {
    if (formErr.customer) setFormStep(1);
    else if (formErr.items) setFormStep(2);
  }, [formErr]);
  useEffect(() => {
    if (previousStep.current === formStep) return;
    previousStep.current = formStep;
    stepHeadingRef.current?.focus();
  }, [formStep]);

  const isEmployee = requesterType === "employee";
  // وضع العنصر: من التصنيفات المعروفة (أصل/مستهلك) أو احتياج مخصص (وصف نصّي فقط، بلا تصنيف/شركة/موديل)
  const itemMode: "known" | "custom" = draft.kind === "custom" ? "custom" : "known";
  const setItemMode = (m: "known" | "custom") =>
    setDraft((s) => ({ ...s, kind: m === "custom" ? "custom" : "asset", category_id: "", brand_key: "", group_key: "", consumable_id: "", description: "" }));

  // خيارات الأصول المجمّعة (موديل واحد مهما تكرر الجهاز) — عدّاد المتاح لشاشة الموظفين فقط.
  const grouped = useMemo(() => groupAssetOptions(data?.assets ?? []), [data]);
  const assetCategories = useMemo(
    () => (data?.categories ?? []).filter((c) => c.kind !== "consumable"),
    [data],
  );
  // ماركات التصنيف المختار فقط (مصدر قائمة «الشركة/الماركة») — لا من جدول companies الكامل
  const brandOptions = useMemo(
    () => brandOptionsForCategory(grouped, draft.category_id || null),
    [grouped, draft.category_id],
  );
  const groupsForCategory = useMemo(
    () => grouped.filter((g) =>
      (!draft.category_id || g.categoryId === draft.category_id) &&
      (!draft.brand_key || g.companyKey === draft.brand_key)),
    [grouped, draft.category_id, draft.brand_key],
  );
  const selectedAssetGroup = useMemo(
    () => grouped.find((g) => g.key === draft.group_key) ?? null,
    [grouped, draft.group_key],
  );
  const selectedConsumable = useMemo(
    () => (data?.consumables ?? []).find((c) => c.id === draft.consumable_id) ?? null,
    [data, draft.consumable_id],
  );
  const draftIdentity = draft.kind === "asset" && selectedAssetGroup
    ? `asset:${selectedAssetGroup.key}`
    : draft.kind === "consumable" && selectedConsumable
      ? `consumable:${selectedConsumable.id}`
      : null;
  const currentAvailable = draft.kind === "asset"
    ? selectedAssetGroup?.available_count ?? null
    : draft.kind === "consumable"
      ? selectedConsumable?.quantity_on_hand ?? null
      : null;
  const existingQuantity = draftIdentity ? (items.find((it) => it.key === draftIdentity)?.quantity ?? 0) : 0;
  const quantityCheck = validateRequestQuantity(draft.quantity, existingQuantity, currentAvailable);
  const quantityError = quantityCheck.error === "invalid"
    ? tr.quantityInvalid
    : quantityCheck.error === "unavailable"
      ? tr.quantityUnavailable
      : quantityCheck.error === "exceeds_available"
        ? tr.quantityExceeds.replace("{n}", String(currentAvailable ?? 0))
        : null;

  // سبب تعذّر الإضافة (لعرضه للمستخدم بدل التجاهل الصامت) — يطابق حراس addItem أدناه (L2).
  const selectionBlockReason =
    draft.kind === "asset"
      ? (!draft.group_key ? tr.addNeedsModel : null)
      : draft.kind === "consumable"
      ? (!draft.consumable_id ? tr.addNeedsConsumable : null)
      : (!draft.description.trim() ? tr.addNeedsDescription : null);
  const addBlockReason = selectionBlockReason ?? quantityError;

  function addItem() {
    const qty = quantityCheck.quantity;
    if (quantityCheck.error || qty < 1) return;
    const notes = draft.notes.trim() || null;
    if (draft.kind === "asset") {
      const g = groupsForCategory.find((x) => x.key === draft.group_key);
      if (!g) return;
      const label = [g.categoryLabel, g.companyLabel, g.modelLabel].filter(Boolean).join(" · ");
      const line: DraftItem = {
        key: `asset:${g.key}`,
        item_kind: "custom", asset_id: null, consumable_id: null,
        quantity: qty, notes,
        requested_kind: "existing_asset",
        requested_description: label,
        requested_category: g.categoryLabel,
        preferred_company_id: g.companyId,
        preferred_model: g.modelLabel,
        label,
      };
      setItems((s) => mergeRequestDraftLine(s, line, g.available_count).rows);
    } else if (draft.kind === "consumable") {
      if (!draft.consumable_id) return;
      const c = (data?.consumables ?? []).find((x) => x.id === draft.consumable_id);
      if (!c) return;
      const line: DraftItem = {
        key: `consumable:${c.id}`, item_kind: "consumable", asset_id: null, consumable_id: c.id,
        quantity: qty, notes,
        label: `${c.name}${c.sku ? ` · ${c.sku}` : ""}`,
      };
      setItems((s) => mergeRequestDraftLine(s, line, c.quantity_on_hand).rows);
    } else {
      // احتياج مخصص: وصف نصّي فقط — بلا تصنيف/شركة/موديل
      const desc = draft.description.trim();
      if (!desc) return;
      setItems((s) => [...s, {
        key: `x-${Date.now()}-${s.length}`, item_kind: "custom", asset_id: null, consumable_id: null,
        quantity: qty, notes,
        requested_kind: "custom",
        requested_description: desc,
        requested_category: null,
        preferred_company_id: null, preferred_model: null,
        label: desc,
      }]);
    }
    setDraft((s) => ({ ...s, group_key: "", consumable_id: "", description: "", quantity: "1", notes: "" }));
  }

  function removeItem(key: string) { setItems((s) => s.filter((it) => it.key !== key)); }

  async function submit(status: "draft" | "under_review") {
    if (!isEmployee && !h.customer_id && !h.customer_name.trim()) {
      setFormErr({ customer: tr.needCustomer }); setToast({ type: "error", message: tr.needCustomer }); return;
    }
    if (!requestHasItems(items)) { setFormErr({ items: tr.needItems }); setToast({ type: "error", message: tr.needItems }); return; }
    const today = riyadhTodayISO();
    const dateOutsideSupportedRange = [h.pickup_date, h.return_date]
      .filter(Boolean)
      .some((date) => !isSupportedRequestDate(date, today));
    if (dateOutsideSupportedRange) {
      setToast({ type: "error", message: tr.err.request_date_out_of_range }); return;
    }
    if (h.pickup_date && h.return_date && h.return_date <= h.pickup_date) {
      setToast({ type: "error", message: tr.err.return_date_invalid }); return;
    }
    setFormErr({});
    setBusy(true);
    // تعرض الواجهة الموديل كسطر واحد مدمج. طبقة الحفظ توسّع الأصول المتسلسلة
    // إلى بنود مفردة حتى يبقى request_item_fulfill الحالي قادرًا على ربط أصل واحد بكل بند.
    const itemsPayload = items.flatMap(({ key, label, ...rest }) =>
      rest.item_kind === "custom" && rest.requested_kind === "existing_asset" && rest.quantity > 1
        ? Array.from({ length: rest.quantity }, () => ({ ...rest, quantity: 1 }))
        : [rest],
    );
    // طلب الموظف: RPC خادمي يشتق المستفيد من الحساب الحالي (لا beneficiary من العميل، بلا تسعير).
    const { error, id } = isEmployee
      ? await createEmployeeRequest({
          status,
          project_name: h.project_name.trim() || null,
          pickup_date: h.pickup_date || null,
          return_date: h.return_date || null,
          notes: h.notes.trim() || null,
          items: itemsPayload,
        })
      : await createRequest({
          status,
          customer_id: h.customer_id || null,
          customer_name_snapshot: h.customer_name.trim() || null,
          contact_phone_snapshot: h.contact_phone.trim() || null,
          project_name: h.project_name.trim() || null,
          project_city: h.project_city.trim() || null,
          request_type: legacyRequestTypeForInsert(),
          beneficiary_type: "customer",
          beneficiary_employee_id: null,
          pickup_date: h.pickup_date || null,
          return_date: h.return_date || null,
          notes: h.notes.trim() || null,
          internal_notes: h.internal_notes.trim() || null,
          items: itemsPayload,
        });
    setBusy(false);
    if (error || !id) {
      const msg = error ? ((tr.err as Record<string, string>)[error] ?? error) : "";
      setToast({ type: "error", message: tr.createError + msg }); return;
    }
    router.push(`/requests/${id}`);
  }

  // أثناء تحميل الجلسة لا نعرض النموذج (نتفادى ظهوره للأدوار للقراءة فقط في نافذة التحميل)
  if (loading) {
    return <div className="animate-pulse space-y-4" aria-hidden="true"><div className="h-9 w-64 rounded-lg bg-sunk" /><div className="h-80 rounded-card bg-sunk" /></div>;
  }
  if (!canWrite) {
    return (
      <Card>
        <EmptyState icon={ClipboardList} title={tr.noPermission}
          action={<Link href="/requests" className={buttonClass("outline", "sm")}><ArrowRight aria-hidden="true" className="rtl:rotate-180" />{tr.back}</Link>} />
      </Card>
    );
  }
  // إظهار تدريجي: إنشاء الطلبات من مستوى 40 — رابط مباشر تحت المستوى ⇒ لوحة «تُفعَّل لاحقًا»
  // (بعد فحص الدور أعلاه؛ ليست رسالة صلاحيات). لا يمس أي طلب قائم.
  if (!isVisible("requests.create")) return <FeatureUnavailablePanel />;
  const employeeRequestsVisible = isVisible("requests.employeeRequests");

  const noCustomers = (data?.customers ?? []).length === 0;

  // ===== واجهة الخطوات =====
  const stepKey: FormStep = FORM_STEPS[formStep - 1];
  function goToStep(n: number) {
    setFormStep(n);
    setMaxStep((m) => Math.max(m, n));
  }
  function nextStep() {
    // نفس قاعدتَي التحقق عند الإرسال، مطبّقتان عند مغادرة الخطوة (بلا قواعد جديدة).
    if (formStep === 1 && !isEmployee && !h.customer_id && !h.customer_name.trim()) { setFormErr({ customer: tr.needCustomer }); return; }
    if (formStep === 2 && !requestHasItems(items)) { setFormErr({ items: tr.needItems }); return; }
    setFormErr({});
    goToStep(Math.min(formStep + 1, FORM_STEPS.length));
  }
  const selectedCustomer = (data?.customers ?? []).find((c) => c.id === h.customer_id) ?? null;
  const partyName = isEmployee
    ? tr.requesterEmployee
    : selectedCustomer ? selectedCustomer.name : h.customer_name.trim() || null;
  const dateText = (d: string) => (d ? formatDate(d, lang) : "—");
  const datesLabel = h.pickup_date || h.return_date
    ? `${dateText(h.pickup_date)} – ${dateText(h.return_date)}`
    : tl.noDates;
  const itemIcon = (it: DraftItem) => it.item_kind === "consumable" ? PackageOpen : it.requested_kind === "custom" ? ClipboardList : Boxes;
  const kindLabel = (it: DraftItem) => it.item_kind === "consumable" ? tr.consumable : it.requested_kind === "custom" ? tr.customNeed : tr.asset;
  const totalQty = items.reduce((s, it) => s + it.quantity, 0);
  const dateHintEmployee = tr.custodyReturnHint;
  const partyRows: [string, string][] = isEmployee
    ? [[tr.requesterType, tr.requesterEmployee], [tr.requestReason, h.project_name.trim() || "—"]]
    : [
        [tr.customer, partyName ?? "—"],
        ...(!h.customer_id ? [[tr.contactPhone, h.contact_phone.trim() || "—"] as [string, string]] : []),
        [tr.projectName, h.project_name.trim() || "—"],
        [tr.projectCity, h.project_city.trim() || "—"],
      ];
  const dateRows: [string, string][] = [
    [isEmployee ? tr.needDate : tr.pickupDate, dateText(h.pickup_date)],
    [tr.returnDate, dateText(h.return_date)],
    [tr.notes, h.notes.trim() || "—"],
  ];

  const stepTitle = tl.newSteps[stepKey];
  const stepHint = stepKey === "party" ? tl.partyStepHint : stepKey === "items" ? tr.itemsNeedHint : stepKey === "dates" ? tl.datesStepHint : tl.reviewStepHint;

  return (
    <div className="space-y-6">
      <Link href="/requests" className="inline-flex min-h-9 items-center gap-1.5 text-[13px] font-medium text-fg-2 hover:text-brand-ink"><ArrowRight aria-hidden="true" className="h-4 w-4 rtl:rotate-180" />{tr.back}</Link>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-[27px] font-semibold text-fg sm:text-[32px] sm:leading-[1.5]">{tr.newTitle}</h1>
          <p className="mt-1 text-sm text-muted">{tr.needBasedNote}</p>
        </div>
        <div className="page-header-actions flex flex-wrap items-center gap-2">
          <Link href="/requests" className={buttonClass("ghost", "md")}>{tl.cancel}</Link>
          <Button variant="outline" onClick={() => submit("draft")} disabled={busy}><Save aria-hidden="true" />{tr.saveDraft}</Button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
        <Card className="overflow-hidden">
          {/* مؤشر الخطوات */}
          <ol tabIndex={0} aria-label={tl.stepsLabel} className="flex items-center gap-3 overflow-x-auto border-b border-line p-5 sm:p-6">
            {FORM_STEPS.map((key, index) => {
              const n = index + 1;
              const done = n < formStep && n <= maxStep;
              const current = n === formStep;
              const locked = n > maxStep;
              return (
                <li key={key} className={`flex items-center gap-2 ${index < FORM_STEPS.length - 1 ? "min-w-0 flex-1" : ""}`}>
                  <button type="button" onClick={() => goToStep(n)} disabled={locked} aria-current={current ? "step" : undefined}
                    className="group inline-flex shrink-0 items-center gap-2.5 rounded-control px-1.5 py-1 text-start disabled:cursor-default">
                    <span aria-hidden="true" className={`inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border-[1.5px] text-[13px] font-semibold tabular-nums ${
                      current ? "border-brand bg-brand text-brand-on" : done ? "border-[rgb(var(--hero))] bg-[rgb(var(--hero))] text-white" : "border-line-strong bg-surface text-muted"
                    }`}>
                      {done ? <Check className="h-4 w-4" strokeWidth={2.4} /> : n}
                    </span>
                    <span className="flex flex-col">
                      <span className={`whitespace-nowrap text-[13.5px] font-semibold ${current ? "text-fg" : locked ? "text-muted" : "text-fg-2 group-hover:text-fg"}`}>{tl.newSteps[key]}</span>
                      <span className="hidden whitespace-nowrap text-[11.5px] text-muted sm:block">{tl.newStepsCap[key]}</span>
                    </span>
                  </button>
                  {index < FORM_STEPS.length - 1 && <span aria-hidden="true" className={`hidden h-0.5 min-w-4 flex-1 rounded-full md:block ${n < maxStep ? "bg-ok" : "bg-line"}`} />}
                </li>
              );
            })}
          </ol>

          <div className="space-y-6 p-5 sm:p-6">
            <div>
              <h2 ref={stepHeadingRef} tabIndex={-1} className="font-display text-[17px] font-semibold text-fg focus:outline-none">{stepTitle}</h2>
              <p className="mt-0.5 text-[13px] text-muted">{stepHint}</p>
            </div>

            {/* ----- 1: نوع الجهة الطالبة + معلومات العميل / الموظف المستفيد ----- */}
            {stepKey === "party" && (
              <>
                <div>
                  <span className="ui-label">{tr.requesterType}</span>
                  <div role="group" aria-label={tr.requesterType} className="ui-seg">
                    <button type="button" aria-pressed={!isEmployee} onClick={() => setRequesterType("customer")} className="ui-seg-item">
                      <Building2 aria-hidden="true" className="h-4 w-4" />{tr.requesterCustomer}
                    </button>
                    {employeeRequestsVisible && (
                      <button type="button" aria-pressed={isEmployee} onClick={() => setRequesterType("employee")} className="ui-seg-item">
                        <UserRound aria-hidden="true" className="h-4 w-4" />{tr.requesterEmployee}
                      </button>
                    )}
                  </div>
                  {isEmployee && <p className="ui-hint">{tr.employeeRequestHint}</p>}
                </div>

                {isEmployee ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="rounded-xl bg-sunk px-4 py-3 text-[13px] text-fg-2 sm:col-span-2">
                      {tr.employeeSelfNote}
                    </div>
                    <div className="sm:col-span-2">
                      <Field label={tr.requestReason}>
                        <input className={inputClass} value={h.project_name} onChange={(e) => setHk("project_name")(e.target.value)} placeholder={tr.requestReasonHint} />
                      </Field>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <Field label={tr.customer} error={formErr.customer}>
                            <Select value={h.customer_id} onChange={(v) => { setHk("customer_id")(v); setFormErr((er) => ({ ...er, customer: undefined })); }} placeholder={tr.noCustomer}
                              options={(data?.customers ?? []).map((c) => ({ value: c.id, label: `${c.name}${c.city ? ` · ${c.city}` : ""}` }))} />
                          </Field>
                        </div>
                        {canManageCustomers && (
                          <Button type="button" variant="outline" onClick={() => setAddCustomerOpen(true)} className="mt-[26px] shrink-0">
                            <Plus aria-hidden="true" />{tr.addNewCustomer}
                          </Button>
                        )}
                      </div>
                      {noCustomers && <p className="mt-1.5 text-xs font-medium text-warn">{tr.noCustomersYet}</p>}
                    </div>
                    <Field label={tr.customerName} hint={tr.orWalkIn}>
                      <input className={inputClass} value={h.customer_name} onChange={(e) => { setHk("customer_name")(e.target.value); setFormErr((er) => ({ ...er, customer: undefined })); }} disabled={!!h.customer_id} />
                    </Field>
                    <Field label={tr.contactPhone}>
                      <input className={inputClass} value={h.contact_phone} onChange={(e) => setHk("contact_phone")(e.target.value)} dir="ltr" disabled={!!h.customer_id} />
                    </Field>
                    <Field label={tr.projectName}>
                      <input className={inputClass} value={h.project_name} onChange={(e) => setHk("project_name")(e.target.value)} />
                    </Field>
                    <Field label={tr.projectCity}>
                      <input className={inputClass} value={h.project_city} onChange={(e) => setHk("project_city")(e.target.value)} />
                    </Field>
                  </div>
                )}
              </>
            )}

            {/* ----- 2: عناصر الطلب (احتياج — لا أجهزة فردية) ----- */}
            {stepKey === "items" && (
              <>
                {/* اختيار الوضع: من التصنيفات المعروفة أو احتياج مخصص (يُخفي التصنيف/الشركة/الموديل) */}
                <div role="group" aria-label={tr.itemsSection} className="ui-seg">
                  <button type="button" aria-pressed={itemMode === "known"} onClick={() => setItemMode("known")} className="ui-seg-item">
                    <Boxes aria-hidden="true" className="h-4 w-4" />{tr.knownFromCatalog}
                  </button>
                  <button type="button" aria-pressed={itemMode === "custom"} onClick={() => setItemMode("custom")} className="ui-seg-item">
                    <ClipboardList aria-hidden="true" className="h-4 w-4" />{tr.customNeed}
                  </button>
                </div>

                <div className="rounded-xl border border-line bg-surface-2 p-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                    {itemMode === "known" ? (
                      <>
                        <div className="sm:col-span-3">
                          <Select value={draft.kind}
                            label={tr.itemsSection}
                            onChange={(v) => setDraft((s) => ({ ...s, kind: v as DraftKind, group_key: "", consumable_id: "" }))}
                            options={[
                              { value: "asset", label: tr.asset },
                              { value: "consumable", label: tr.consumable },
                            ]} />
                        </div>

                        {draft.kind === "asset" && (
                          <>
                            <div className="sm:col-span-3">
                              {/* تغيير التصنيف يصفّر الماركة والموديل معًا (يتفادى ماركة قديمة من تصنيف آخر) */}
                              <Select value={draft.category_id} onChange={(v) => setDraft((s) => ({ ...s, category_id: v, brand_key: "", group_key: "" }))} placeholder={tr.allCategories}
                                options={assetCategories.map((c) => ({ value: c.id, label: nameOf(c) }))} />
                            </div>
                            <div className="sm:col-span-3">
                              {/* الماركات من أصول التصنيف المختار فقط؛ تغيير الماركة يصفّر الموديل */}
                              <Select value={draft.brand_key} onChange={(v) => setDraft((s) => ({ ...s, brand_key: v, group_key: "" }))} placeholder={tr.allCompanies}
                                options={brandOptions.map((b) => ({ value: b.key, label: b.label ?? tr.brandUnspecified }))} />
                            </div>
                            <div className="sm:col-span-3">
                              <Select value={draft.group_key} onChange={(v) => setDraft((s) => ({ ...s, group_key: v }))} placeholder={tr.chooseModel}
                                options={groupsForCategory.map((g) => ({
                                  value: g.key,
                                  label: `${[g.companyLabel ?? tr.brandUnspecified, g.modelLabel].filter(Boolean).join(" ")} — ${g.available_count > 0 ? `${tr.availableCount}: ${g.available_count}` : tr.notAvailableNow}`,
                                }))} />
                            </div>
                          </>
                        )}

                        {draft.kind === "consumable" && (
                          <div className="sm:col-span-9">
                            <Select value={draft.consumable_id} onChange={(v) => setDraft((s) => ({ ...s, consumable_id: v }))} placeholder={tr.chooseConsumable}
                              options={(data?.consumables ?? []).map((c) => ({ value: c.id, label: `${c.name} (${tr.inStock}: ${formatQtyUnit(c.quantity_on_hand, c.unit, t.consumables.form.units)})` }))} />
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="sm:col-span-12">
                        <input className={inputClass} value={draft.description} onChange={(e) => setDraft((s) => ({ ...s, description: e.target.value }))} placeholder={tr.customNeedPlaceholder} aria-label={tr.customNeed} />
                      </div>
                    )}

                    <div className="sm:col-span-3">
                      <input type="number" min={1} max={currentAvailable == null ? undefined : Math.max(currentAvailable - existingQuantity, 0)} step={1} className={`${inputClass} tabular-nums`} value={draft.quantity}
                        onChange={(e) => setDraft((s) => ({ ...s, quantity: e.target.value }))} placeholder={tr.quantity} aria-label={tr.quantity} dir="ltr" />
                    </div>
                    <div className="sm:col-span-3">
                      <Button variant="outline" className="w-full" onClick={addItem} type="button"
                        disabled={!!addBlockReason} title={addBlockReason ?? undefined}
                        aria-describedby={addBlockReason ? "add-item-hint" : undefined}><Plus aria-hidden="true" />{tr.addItem}</Button>
                    </div>
                  </div>

                  {/* توضيح سبب تعذّر الإضافة بدل تعطيل صامت بلا سبب (L2) */}
                  {addBlockReason && (
                    <p id="add-item-hint" role={quantityError ? "alert" : undefined} className={`mt-2 text-start text-xs ${quantityError ? "font-medium text-bad" : "text-muted"}`}>{addBlockReason}</p>
                  )}

                  {currentAvailable != null && (
                    <p className="mt-2 text-xs tabular-nums text-fg-2">
                      {tr.currentAvailable.replace("{n}", String(currentAvailable))}
                      {existingQuantity > 0 ? ` · ${tr.alreadyAdded.replace("{n}", String(existingQuantity))}` : ""}
                      {h.pickup_date ? ` · ${tr.dateAvailabilityPending}` : ""}
                    </p>
                  )}

                  {/* لا موديلات لهذه الماركة ضمن التصنيف — حالة فارغة صريحة (لا نعرض ماركات أخرى) */}
                  {draft.kind === "asset" && draft.brand_key && groupsForCategory.length === 0 && (
                    <p className="mt-2 text-xs font-medium text-warn">{tr.noModelsForBrand}</p>
                  )}
                </div>

                {/* قائمة العناصر */}
                {items.length === 0 ? (
                  <p role={formErr.items ? "alert" : undefined} className={`rounded-xl border border-dashed px-4 py-6 text-center text-[13px] ${formErr.items ? "border-bad font-medium text-bad" : "border-line-strong text-muted"}`}>{formErr.items ?? tr.noItems}</p>
                ) : (
                  <div tabIndex={0} className="overflow-x-auto rounded-xl border border-line">
                    <table className="ui-table">
                      <caption className="sr-only">{tr.itemsSection}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{tr.itemKind}</th>
                          <th scope="col">{tr.requestedItems}</th>
                          <th scope="col">{tr.quantity}</th>
                          <th scope="col"><span className="sr-only">{tr.remove}</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((it) => {
                          const Icon = itemIcon(it);
                          return (
                            <tr key={it.key}>
                              <td className="whitespace-nowrap text-[13px] text-fg-2"><span className="inline-flex items-center gap-2"><Icon aria-hidden="true" className="h-4 w-4 text-brand-ink" />{kindLabel(it)}</span></td>
                              <td className="font-medium text-fg">{it.label}</td>
                              <td className="tabular-nums text-fg-2">{it.quantity}</td>
                              <td className="w-12"><Button type="button" variant="danger-ghost" size="icon-sm" aria-label={`${tr.remove} ${it.label}`} onClick={() => removeItem(it.key)}><Trash2 aria-hidden="true" /></Button></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {/* ----- 3: المواعيد والملاحظات ----- */}
            {stepKey === "dates" && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={isEmployee ? tr.needDate : tr.pickupDate} hint={t.common.dateHint}>
                  <input type="date" className={inputClass} value={h.pickup_date} min={riyadhTodayISO()} max={requestDateMaximum(riyadhTodayISO())} onChange={(e) => setHk("pickup_date")(e.target.value)} dir="ltr" />
                </Field>
                <Field label={tr.returnDate} hint={isEmployee ? dateHintEmployee : tr.returnDateHint}>
                  <input type="date" className={inputClass} value={h.return_date} min={riyadhTodayISO()} max={requestDateMaximum(riyadhTodayISO())} onChange={(e) => setHk("return_date")(e.target.value)} dir="ltr" />
                </Field>
                <div className="sm:col-span-2">
                  <Field label={tr.notes}>
                    <textarea className={`${inputClass} resize-none`} rows={3} value={h.notes} onChange={(e) => setHk("notes")(e.target.value)} />
                  </Field>
                </div>
              </div>
            )}

            {/* ----- 4: المراجعة ----- */}
            {stepKey === "review" && (
              <div className="space-y-4">
                <ReviewSection title={`1 · ${tl.newSteps.party}`} editLabel={tl.edit} onEdit={() => goToStep(1)}>
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[13.5px] sm:grid-cols-2">
                    {partyRows.map(([k, v]) => <ReviewRow key={k} label={k} value={v} />)}
                  </dl>
                </ReviewSection>
                <ReviewSection title={`2 · ${tl.newSteps.items}`} editLabel={tl.edit} onEdit={() => goToStep(2)}>
                  {items.length === 0 ? (
                    <p className="text-[13px] font-medium text-bad">{tr.needItems}</p>
                  ) : (
                    <ul className="divide-y divide-line rounded-xl border border-line">
                      {items.map((it) => (
                        <li key={it.key} className="flex items-center gap-3 px-3.5 py-2.5 text-[13.5px]">
                          <span className="min-w-0 flex-1 truncate font-medium text-fg">{it.label} <span className="font-normal text-muted">· {kindLabel(it)}</span></span>
                          <span className="tabular-nums text-fg-2" dir="ltr">× {it.quantity}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </ReviewSection>
                <ReviewSection title={`3 · ${tl.newSteps.dates}`} editLabel={tl.edit} onEdit={() => goToStep(3)}>
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[13.5px] sm:grid-cols-2">
                    {dateRows.map(([k, v]) => <ReviewRow key={k} label={k} value={v} />)}
                  </dl>
                </ReviewSection>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-2 px-5 py-5 sm:px-6">
            <Button variant="outline" onClick={() => goToStep(Math.max(formStep - 1, 1))} disabled={formStep === 1}>
              <ArrowRight aria-hidden="true" className="rtl:rotate-180" />{tl.previous}
            </Button>
            <span className="text-[13px] tabular-nums text-muted">{tl.stepOf.replace("{n}", String(formStep)).replace("{total}", String(FORM_STEPS.length))}</span>
            {formStep < FORM_STEPS.length ? (
              <Button onClick={nextStep}>{tl.next}<ChevronLeft aria-hidden="true" className="ltr:rotate-180" /></Button>
            ) : (
              <Button onClick={() => submit("under_review")} disabled={busy}><Send aria-hidden="true" className="rtl:-scale-x-100" />{busy ? tr.saving : tr.submit}</Button>
            )}
          </div>
        </Card>

        {/* ملخّص الطلب — ثابت على الشاشات الكبيرة */}
        <aside aria-labelledby="request-new-summary" className="ui-surface lg:sticky lg:top-20">
          <div className="flex items-center justify-between gap-3 px-5 pb-4 pt-6">
            <h2 id="request-new-summary" className="font-display text-[17px] font-semibold text-fg">{tl.summaryTitle}</h2>
            <StatusChip tone="neu">{tl.draftChip}</StatusChip>
          </div>
          <div className="space-y-2.5 px-5 py-4 text-[13px]">
            <p className="flex items-start gap-2.5">
              {isEmployee ? <UserRound aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted" /> : <Building2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted" />}
              <span className="min-w-0">
                <span className={`block font-semibold ${partyName ? "text-fg" : "text-muted"}`}>{partyName ?? tr.noCustomer}</span>
                {h.project_name.trim() && <span className="block truncate text-muted">{h.project_name.trim()}{!isEmployee && h.project_city.trim() ? ` · ${h.project_city.trim()}` : ""}</span>}
              </span>
            </p>
            <p className="flex items-center gap-2.5">
              <CalendarDays aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
              <span className="tabular-nums text-fg-2" dir={lang === "ar" ? "rtl" : "ltr"}>{datesLabel}</span>
            </p>
          </div>
          <div className="flex items-center justify-between border-t border-line px-5 pb-2 pt-3.5">
            <h3 className="text-sm font-semibold text-fg">{tr.itemsSection}</h3>
            <span className="ui-count">{totalQty}</span>
          </div>
          {items.length === 0 ? (
            <EmptyState compact icon={Boxes} title={tl.summaryEmpty} description={tl.summaryEmptyHint} />
          ) : (
            <ul className="px-2 pb-3">
              {items.map((it) => {
                const Icon = itemIcon(it);
                return (
                  <li key={it.key} className="flex items-center gap-2.5 rounded-control px-3 py-2 hover:bg-surface-2">
                    <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-brand-ink" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-fg">{it.label}</span>
                      <span className="block text-xs text-muted">{kindLabel(it)} · <span className="tabular-nums">× {it.quantity}</span></span>
                    </span>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`${tr.remove} ${it.label}`} onClick={() => removeItem(it.key)}><Trash2 aria-hidden="true" /></Button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>

      {/* إضافة عميل جديد دون مغادرة الصفحة — يُضاف للقائمة ويُختار تلقائيًا */}
      <CustomerDialog open={addCustomerOpen} t={t} onClose={() => setAddCustomerOpen(false)}
        onDone={async (m, newId) => {
          setAddCustomerOpen(false); setToast(m);
          if (newId) {
            const fresh = await getRequestFormData();
            setData(fresh);
            setH((s) => ({ ...s, customer_id: newId, customer_name: "", contact_phone: "" }));
            setFormErr((e) => ({ ...e, customer: undefined }));
          }
        }} />

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function ReviewSection({ title, editLabel, onEdit, children }: { title: string; editLabel: string; onEdit: () => void; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="rounded-xl border border-line p-4">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        <Button type="button" variant="ghost" size="sm" onClick={onEdit} className="text-brand-ink">{editLabel}</Button>
      </div>
      {children}
    </section>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-fg">{value}</dd>
    </div>
  );
}
