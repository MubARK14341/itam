"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, Plus, Send, Trash2, Paperclip, Info, AlertTriangle } from "lucide-react";
import { Field, Select, inputClass } from "@/components/ui/form";
import { Button, buttonClass } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { StatusChip } from "@/components/ui/status-chip";
import { FileInput } from "@/components/ui/file-input";
import { Toast, type ToastState } from "@/components/ui/toast";
import {
  type PortalNewItem,
  portalGetProfile, portalListCatalog, type PortalCatalogRow,
  portalListConsumables, type PortalConsumableRow, portalGetItemAvailability,
} from "@/lib/portal";
import { filterPortalCatalog, portalKeyForCategoryName } from "@/lib/portal-catalog";
import { requestHasItems } from "@/lib/request-options";
import { legacyRequestTypeForInsert } from "@/lib/request-compat";
import {
  uploadRequestAttachmentPortal, validateAttachmentFile, ATTACHMENT_ACCEPT,
} from "@/lib/request-attachments";
import { formatBytes } from "@/lib/format";
import { isSupportedRequestDate, requestDateMaximum, riyadhTodayISO } from "@/lib/request-date-validation";
import { createClient } from "@/lib/supabase/client";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { usePortalSession } from "@/components/providers/portal-session";
import { EquipmentPhoto } from "@/components/assets/equipment-photo";
import {
  createPortalDraftOperation, recoverPortalDraftOperation, submitPortalDraft,
} from "@/lib/portal-request-operation";
import { friendlyErrorStrict } from "@/lib/user-facing-errors";
import { usePortalOperationActor } from "@/lib/use-portal-operation-actor";

type ItemMode = "catalog" | "consumable" | "custom";

interface DraftItem {
  key: string; mode: ItemMode; requested_kind: "consumable" | "custom";
  categoryName: string;        // تسمية التصنيف المعروضة (مترجمة)
  categoryKey: string | null;  // مفتاح البوابة المشتقّ (لمسار الكتابة/السماح)
  companyName: string;         // اسم الماركة (الكتالوج فقط)
  itemName: string;            // اسم الموديل (كتالوج) أو اسم المستهلك
  description: string;         // نص الاحتياج المخصص
  quantity: string;
  modelId: string | null;
  consumableId: string | null;
  availableQuantity: number | null;
  additionalQuantityRequested: boolean;
}

export default function PortalNewRequestPage() {
  const router = useRouter();
  const { t, lang } = useAppPreferences();
  const tp = t.portal;
  const ctx = usePortalSession();
  const { actorId, ready: actorReady, actorChanged, isCurrent, invalidate } = usePortalOperationActor();

  // الهوية للعرض فقط — تُشتق في القاعدة (البريد من الجلسة، الجوال من الملف). لا حقول إدخال يدوية.
  const [sessionEmail, setSessionEmail] = useState("");
  const [profilePhone, setProfilePhone] = useState<string | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  useEffect(() => {
    if (!actorId || actorChanged) return;
    createClient().auth.getUser().then(({ data }) => { if (isCurrent(actorId)) setSessionEmail(data.user?.email ?? ""); });
    portalGetProfile().then(({ data }) => { if (isCurrent(actorId)) { setProfilePhone(data?.phone ?? null); setProfileLoaded(true); } });
  }, [actorId, actorChanged, isCurrent]);
  const phoneMissing = profileLoaded && !((profilePhone ?? "").trim());

  // الكتالوج الآمن (تصنيف→ماركة→موديل) والمستهلكات (تصنيف→مستهلك). فارغ ⇒ يُستخدم «احتياج مخصص».
  const [catalog, setCatalog] = useState<PortalCatalogRow[]>([]);
  const [consCatalog, setConsCatalog] = useState<PortalConsumableRow[]>([]);
  useEffect(() => {
    if (!actorId || actorChanged) return;
    portalListCatalog().then((rows) => { if (isCurrent(actorId)) setCatalog(rows); });
    portalListConsumables().then((rows) => { if (isCurrent(actorId)) setConsCatalog(rows); });
  }, [actorId, actorChanged, isCurrent]);

  const [h, setH] = useState({ project_name: "", city: "", pickup_date: "", return_date: "", notes: "" });
  const setHk = (k: keyof typeof h) => (v: string) => setH((s) => ({ ...s, [k]: v }));

  const [items, setItems] = useState<DraftItem[]>([]);
  const emptyDraft = { mode: "catalog" as ItemMode, catId: "", companyId: "", modelId: "", consCatId: "", consumableId: "", description: "", quantity: "1" };
  const [d, setD] = useState(emptyDraft);
  const [availability, setAvailability] = useState<number | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [additionalAcknowledged, setAdditionalAcknowledged] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [files, setFiles] = useState<File[]>([]);
  const [toast, setToast] = useState<ToastState>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(1);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [recoveredId, setRecoveredId] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState(false);
  const [checkingRecovery, setCheckingRecovery] = useState(true);
  const [uploadErrors, setUploadErrors] = useState(new Map<File, string>());
  const uploadedFiles = useRef(new WeakSet<File>());
  const persistInFlight = useRef(false);

  useEffect(() => {
    if (!actorReady || actorChanged) return;
    if (!actorId) { setCheckingRecovery(false); return; }
    let active = true;
    void recoverPortalDraftOperation(actorId).then((result) => {
      if (!active || !isCurrent(actorId)) return;
      if (result.error === "operation_actor_changed") { invalidate(); return; }
      setRecoveredId(result.id);
      setPendingSave(result.pending);
      setCheckingRecovery(false);
    });
    return () => { active = false; };
  }, [actorId, actorReady, actorChanged, isCurrent, invalidate]);

  useEffect(() => {
    if (!actorChanged) return;
    setH({ project_name: "", city: "", pickup_date: "", return_date: "", notes: "" });
    setItems([]); setFiles([]); setUploadErrors(new Map());
    uploadedFiles.current = new WeakSet();
    setSavedId(null); setRecoveredId(null); setPendingSave(false);
    setSessionEmail(""); setProfilePhone(null); setCatalog([]); setConsCatalog([]);
    setToast(null); setBusy(false); setCheckingRecovery(false);
  }, [actorChanged]);

  async function retryRecovery() {
    if (!actorId || !isCurrent(actorId)) return;
    setCheckingRecovery(true);
    const result = await recoverPortalDraftOperation(actorId);
    if (!isCurrent(actorId)) return;
    if (result.error === "operation_actor_changed") { invalidate(); return; }
    setRecoveredId(result.id);
    setPendingSave(result.pending);
    setCheckingRecovery(false);
    if (result.error) setToast({ type: "error", message: friendlyErrorStrict(result.error, lang) });
  }

  // مشاهد لا ينشئ طلبات — يُعاد إلى القائمة.
  useEffect(() => { if (ctx && ctx.portal_role === "viewer") router.replace("/client-portal/requests"); }, [ctx, router]);

  const catLabel = (r: { category_name: string; category_name_ar: string | null }) =>
    (lang === "ar" ? r.category_name_ar : r.category_name) || r.category_name;

  // اشتقاق تتالي الكتالوج: تصنيف ← ماركة(شركة) ← موديل (بلا مخزون/سعر/معرّف أصل).
  const categories = useMemo(() => {
    const m = new Map<string, PortalCatalogRow>();
    catalog.forEach((r) => { if (!m.has(r.category_id)) m.set(r.category_id, r); });
    return Array.from(m.values()).map((r) => ({ value: r.category_id, label: catLabel(r) }));
  }, [catalog, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const brands = useMemo(() => {
    if (!d.catId) return [] as { value: string; label: string }[];
    const m = new Map<string, string>();
    filterPortalCatalog(catalog, d.catId).forEach((r) => { if (!m.has(r.company_id)) m.set(r.company_id, r.company_name); });
    return Array.from(m, ([value, label]) => ({ value, label }));
  }, [catalog, d.catId]);
  const models = useMemo(() => {
    if (!d.catId || !d.companyId) return [] as { value: string; label: string }[];
    return filterPortalCatalog(catalog, d.catId, d.companyId)
      .map((r) => ({ value: r.model_id, label: r.model_name }));
  }, [catalog, d.catId, d.companyId]);
  const catalogEmpty = categories.length === 0;

  // تتالي المستهلكات: تصنيف ← مستهلك (بلا كمية/سعر/مورد).
  const consCategories = useMemo(() => {
    const m = new Map<string, PortalConsumableRow>();
    consCatalog.forEach((r) => { if (!m.has(r.category_id)) m.set(r.category_id, r); });
    return Array.from(m.values()).map((r) => ({ value: r.category_id, label: catLabel(r) }));
  }, [consCatalog, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const consumableOpts = useMemo(() => {
    if (!d.consCatId) return [] as { value: string; label: string }[];
    return consCatalog.filter((r) => r.category_id === d.consCatId)
      .map((r) => ({ value: r.consumable_id, label: r.consumable_name }));
  }, [consCatalog, d.consCatId]);
  const consumablesEmpty = consCategories.length === 0;

  const errLabel = (code: string) => (tp.err as Record<string, string>)[code] ?? code;
  const willNeedPmApproval = !!ctx && ctx.require_project_manager_approval && ctx.portal_role === "authorized_requester";
  const qty = Math.max(1, Number(d.quantity) || 0);
  const qtyValid = qty >= 1;
  const availabilityLabel = (count: number, mode: ItemMode) => tp.availability.currentlyAvailable
    .replace("{count}", String(count))
    .replace("{unit}", mode === "catalog" ? tp.availability.assets : tp.availability.units);

  useEffect(() => {
    const isDurable = d.mode === "catalog" && !!d.catId && !!d.modelId;
    const isConsumable = d.mode === "consumable" && !!d.consumableId;
    if (!isDurable && !isConsumable) { setAvailability(null); setAdditionalAcknowledged(false); return; }
    let active = true;
    setAvailabilityLoading(true);
    void portalGetItemAvailability(isDurable
      ? { item_type: "durable", category_id: d.catId, model_id: d.modelId }
      : { item_type: "consumable", consumable_id: d.consumableId })
      .then((result) => { if (active) setAvailability(result?.available_quantity ?? null); })
      .finally(() => { if (active) setAvailabilityLoading(false); });
    return () => { active = false; };
  }, [d.mode, d.catId, d.modelId, d.consumableId]);

  // مفتاح المطابقة لكشف التكرار (المكرّر يُدمج).
  const norm = (s: string) => s.trim().toLowerCase();
  const matchKey = (it: DraftItem) =>
    it.mode === "catalog"
      ? `cat|${norm(it.categoryName)}|${norm(it.companyName)}|${norm(it.itemName)}`
      : it.mode === "consumable"
        ? `cons|${norm(it.itemName)}`
        : `custom|${norm(it.description)}`;

  function addItem() {
    if (qty < 1) return;
    let newItem: DraftItem;
    if (d.mode === "catalog") {
      const row = catalog.find((r) => r.category_id === d.catId && r.company_id === d.companyId && r.model_id === d.modelId);
      if (!row) return; // يتطلب اختيار موديل من الكتالوج (لا نص حر)
      newItem = {
        key: "", mode: "catalog", requested_kind: "custom",
        categoryName: catLabel(row), categoryKey: portalKeyForCategoryName(row.category_name),
        companyName: row.company_name, itemName: row.model_name,
        description: "", quantity: String(qty), modelId: row.model_id, consumableId: null,
        availableQuantity: availability, additionalQuantityRequested: additionalAcknowledged,
      };
    } else if (d.mode === "consumable") {
      const row = consCatalog.find((r) => r.category_id === d.consCatId && r.consumable_id === d.consumableId);
      if (!row) return; // يتطلب اختيار مستهلك من الكتالوج (لا نص حر)
      newItem = {
        key: "", mode: "consumable", requested_kind: "consumable",
        categoryName: catLabel(row), categoryKey: portalKeyForCategoryName(row.category_name) ?? "consumable",
        companyName: "", itemName: row.consumable_name,
        description: "", quantity: String(qty), modelId: null, consumableId: row.consumable_id,
        availableQuantity: availability, additionalQuantityRequested: additionalAcknowledged,
      };
    } else {
      if (!d.description.trim()) return;
      newItem = {
        key: "", mode: "custom", requested_kind: "custom",
        categoryName: "", categoryKey: null, companyName: "", itemName: "",
        description: d.description, quantity: String(qty), modelId: null, consumableId: null,
        availableQuantity: null, additionalQuantityRequested: false,
      };
    }
    const mk = matchKey(newItem);
    const idx = items.findIndex((it) => matchKey(it) === mk);
    if (idx >= 0) {
      setItems((s) => s.map((it, i) => (i === idx ? { ...it, quantity: String((Number(it.quantity) || 0) + qty) } : it)));
      setToast({ type: "success", message: tp.itemMergedToast });
    } else {
      setItems((s) => [...s, { ...newItem, key: mk }]);
    }
    setD((s) => ({ ...emptyDraft, mode: s.mode, catId: s.mode === "catalog" ? s.catId : "", consCatId: s.mode === "consumable" ? s.consCatId : "" }));
    setAvailability(null); setAdditionalAcknowledged(false);
  }
  const removeItem = (key: string) => setItems((s) => s.filter((x) => x.key !== key));

  function pickFile(f: File | null) {
    if (!f) return;
    const v = validateAttachmentFile(f);
    if (v) { setToast({ type: "error", message: errLabel(v) }); return; }
    setFiles((s) => [...s, f]);
  }
  const removeFile = (i: number) => {
    if (persistInFlight.current) return;
    const removed = files[i];
    setFiles((s) => s.filter((_, idx) => idx !== i));
    setUploadErrors((current) => { const next = new Map(current); next.delete(removed); return next; });
  };

  const addDisabled =
    d.mode === "catalog" ? (!d.modelId || !qtyValid)
    : d.mode === "consumable" ? (!d.consumableId || !qtyValid)
    : (!d.description.trim() || !qtyValid);

  function validateStep(target: number) {
    const next: Record<string, string> = {};
    if (target >= 2) {
      if (!h.project_name.trim()) next.project_name = tp.form.projectRequired;
      if (!h.city.trim()) next.city = tp.form.cityRequired;
    }
    if (target >= 3) {
      const today = riyadhTodayISO();
      if (!h.pickup_date) next.pickup_date = tp.form.deliveryRequired;
      else if (!isSupportedRequestDate(h.pickup_date, today)) next.pickup_date = tp.form.deliveryOutsideRange;
      const needsReturn = items.some((item) => item.mode === "catalog");
      if (needsReturn && !h.return_date) next.return_date = tp.form.returnRequired;
      else if (needsReturn && (!isSupportedRequestDate(h.return_date, today) || h.return_date <= h.pickup_date)) next.return_date = h.return_date > requestDateMaximum(today) ? tp.form.deliveryOutsideRange : tp.form.returnAfterDelivery;
    }
    setFieldErrors(next);
    const first = Object.keys(next)[0];
    if (first) document.getElementById(`portal-${first}`)?.focus();
    return Object.keys(next).length === 0;
  }

  async function persist(submit: boolean) {
    if (!actorId || !isCurrent(actorId) || persistInFlight.current || checkingRecovery || recoveredId || !ctx?.portal_enabled || ctx.portal_role === "viewer") return;
    if (phoneMissing) { setToast({ type: "error", message: tp.phoneMissingWarn }); return; }
    if (!requestHasItems(items)) { setToast({ type: "error", message: tp.needItems }); return; }
    if (!validateStep(3)) return;
    persistInFlight.current = true;
    setBusy(true);
    try {
      let id = savedId;
      if (!id) {
        const bundleItems = items.map((it) => {
          const q = Math.max(1, Number(it.quantity) || 1);
          // category_key يُمرَّر للاتساق مع قائمة السماح (fail-closed في القاعدة)؛ يُتجاهَل إن لم تكن للعميل قائمة سماح.
          const payload: PortalNewItem =
            it.mode === "catalog"
              ? {
                  requested_kind: "existing_asset",
                  requested_description: it.itemName || null,
                  requested_category: it.categoryName || null,
                  quantity: q,
                  preferred_model: `${it.companyName} ${it.itemName}`.trim() || null,
                  accept_alternative: true, needs_purchase: false,
                  category_key: it.categoryKey, preferred_company_id: null, model_id: it.modelId,
                  additional_quantity_requested: it.additionalQuantityRequested,
                }
              : it.mode === "consumable"
              ? {
                  requested_kind: "consumable",
                  requested_description: it.itemName || null,
                  requested_category: it.categoryName || null,
                  quantity: q,
                  preferred_model: null, accept_alternative: false, needs_purchase: false,
                  category_key: it.categoryKey, preferred_company_id: null, consumable_id: it.consumableId,
                  additional_quantity_requested: it.additionalQuantityRequested,
                }
              : {
                  requested_kind: "custom",
                  requested_description: it.description.trim() || null,
                  requested_category: null,
                  quantity: q,
                  preferred_model: null, accept_alternative: false, needs_purchase: false,
                  category_key: null, preferred_company_id: null,
                };
          return payload;
        });
        const result = await createPortalDraftOperation({
          project_name: h.project_name.trim() || null,
          project_city: h.city.trim() || null,
          contact_phone: null, contact_email: null,
          request_type: legacyRequestTypeForInsert(),
          pickup_date: h.pickup_date || null, return_date: h.return_date || null,
          notes: h.notes.trim() || null, items: bundleItems,
        }, actorId);
        if (!isCurrent(actorId)) return;
        if (result.error === "operation_actor_changed") { invalidate(); return; }
        setPendingSave(result.pending);
        if (result.error || !result.id) {
          if (result.id) setRecoveredId(result.id);
          setToast({ type: "error", message: friendlyErrorStrict(result.error ?? "failed", lang) });
          return;
        }
        id = result.id;
        setSavedId(id);
      }
      const failed = new Map<File, string>();
      for (const file of files) {
        if (!isCurrent(actorId)) return;
        if (uploadedFiles.current.has(file)) continue;
        if (!ctx.allow_attachments) { failed.set(file, "attachments_disabled"); continue; }
        try {
          const error = await uploadRequestAttachmentPortal(id, file, actorId);
          if (!isCurrent(actorId)) return;
          if (error === "operation_actor_changed") { invalidate(); return; }
          if (error) failed.set(file, error);
          else uploadedFiles.current.add(file);
        } catch { if (!isCurrent(actorId)) return; failed.set(file, "upload_failed"); }
      }
      if (!isCurrent(actorId)) return;
      setUploadErrors(failed);
      if (failed.size > 0) {
        setToast({ type: "error", message: tp.recovery.uploadStopped });
        return;
      }
      if (submit) {
        const result = await submitPortalDraft(id, actorId);
        if (!isCurrent(actorId)) return;
        if (result.error === "operation_actor_changed") { invalidate(); return; }
        if (result.error) {
          setToast({ type: "error", message: result.error === "operation_result_unknown"
            ? tp.recovery.submitUnconfirmed : friendlyErrorStrict(result.error, lang) });
          return;
        }
      }
      router.push(`/client-portal/requests/${id}`);
    } finally {
      persistInFlight.current = false;
      if (isCurrent(actorId)) setBusy(false);
    }
  }

  const blocked = !actorId || actorChanged || busy || checkingRecovery || !ctx?.portal_enabled || ctx.portal_role === "viewer" || phoneMissing || items.length === 0 || !!recoveredId;
  const steps = [tp.requestSteps.need, tp.requestSteps.project, tp.requestSteps.dates, tp.requestSteps.review];
  const goBack = () => setStep((current) => Math.max(1, current - 1));
  const goNext = () => {
    if (!validateStep(step)) return;
    setStep((current) => Math.min(4, current + 1));
  };

  const hasCatalogItem = items.some((item) => item.mode === "catalog");
  const sectionTitle = (n: number, label: string, id: string) => (
    <h2 id={id} className="flex items-center gap-2 font-display text-[17px] font-semibold text-fg"><StepNum n={n} />{label}</h2>
  );

  if (actorChanged) return <div role="alert" className="ui-surface space-y-3 p-5">
    <p>{tp.recovery.actorChanged}</p>
    <Link href="/client-portal/requests" className={buttonClass("outline", "sm")}>{tp.back}</Link>
  </div>;

  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-5">
      <div>
        <Link href="/client-portal/requests" className="mb-1 inline-flex min-h-11 items-center gap-1 text-[13px] font-medium text-muted hover:text-fg"><ArrowRight aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />{tp.back}</Link>
        <PageHeader className="!mb-0" title={tp.newRequest} description={tp.ledger.stepOf.replace("{n}", String(step)).replace("{total}", String(steps.length))} />
      </div>

      {checkingRecovery && <p role="status" className="text-sm text-muted">{tp.recovery.checking}</p>}
      {(pendingSave || recoveredId || savedId) && (
        <section role="status" aria-live="polite" className="ui-surface space-y-2 p-4">
          <h2 className="font-semibold text-fg">{savedId || recoveredId ? tp.recovery.savedTitle : tp.recovery.pendingTitle}</h2>
          <p className="text-sm text-muted">{savedId ? tp.recovery.savedHint : tp.recovery.pendingHint}</p>
          {(recoveredId || savedId) && !busy && uploadErrors.size === 0 ? (
            <Link href={`/client-portal/requests/${recoveredId ?? savedId}`} className={buttonClass("outline", "sm")}>{tp.recovery.openDraft}</Link>
          ) : !savedId && !recoveredId ? (
            <Button variant="outline" size="sm" disabled={checkingRecovery || busy} onClick={() => void retryRecovery()}>{tp.recovery.retry}</Button>
          ) : null}
        </section>
      )}

      <ol className="ui-surface grid grid-cols-4 gap-3 p-4 sm:p-5" aria-label={tp.requestSteps.progress}>
        {steps.map((label, index) => {
          const number = index + 1;
          const active = number === step;
          const complete = number < step;
          return (
            <li key={label} className="min-w-0" aria-current={active ? "step" : undefined}>
              <span aria-hidden="true" className={`block h-1 rounded-full ${complete ? "bg-ok" : active ? "bg-brand" : "bg-sunk"}`} />
              <span className="mt-2 flex min-w-0 items-center gap-1.5">
                <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold tabular-nums ${complete ? "bg-ok-soft text-ok" : active ? "bg-brand text-brand-on" : "bg-sunk text-muted"}`} dir="ltr">
                  {complete ? <Check aria-hidden="true" className="h-3 w-3" /> : number}
                </span>
                <span className={`truncate text-xs max-sm:sr-only ${active ? "font-semibold text-fg" : complete ? "font-medium text-fg-2" : "text-muted"}`}>{label}</span>
              </span>
            </li>
          );
        })}
      </ol>

      {/* نقص الجوال ⇒ منع الإنشاء + رابط إلى «ملفي الشخصي» (الذي يعمل). */}
      {phoneMissing && (
        <div role="note" className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-warn-soft p-4 text-[13.5px] text-warn">
          <span className="flex items-center gap-2"><AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />{tp.phoneMissingWarn}</span>
          <Link href="/client-portal/profile" className="inline-flex min-h-11 items-center font-semibold text-brand-ink underline-offset-2 hover:underline md:min-h-0">{tp.goToProfile}</Link>
        </div>
      )}

      {/* المشروع/الموقع ثم المواعيد: لا تُعرض إلا عند المرحلة المناسبة. */}
      {(step === 2 || step === 3) && <section aria-labelledby="portal-step-heading" className="ui-surface p-4 sm:p-5">
        {sectionTitle(step, step === 2 ? tp.requestSteps.project : tp.requestSteps.dates, "portal-step-heading")}
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {step === 2 ? <>
            <Field label={tp.projectName} error={fieldErrors.project_name}><input id="portal-project_name" className={inputClass} value={h.project_name} maxLength={160} onChange={(e) => setHk("project_name")(e.target.value)} /></Field>
            <Field label={tp.city} error={fieldErrors.city}><input id="portal-city" className={inputClass} value={h.city} maxLength={120} onChange={(e) => setHk("city")(e.target.value)} /></Field>
          </> : <>
            <Field label={tp.pickupDate} error={fieldErrors.pickup_date}><input id="portal-pickup_date" className={`${inputClass} tabular-nums`} type="date" value={h.pickup_date} min={riyadhTodayISO()} max={requestDateMaximum(riyadhTodayISO())} onChange={(e) => setHk("pickup_date")(e.target.value)} dir="ltr" /></Field>
            {hasCatalogItem ? <Field label={tp.returnDate} error={fieldErrors.return_date}><input id="portal-return_date" className={`${inputClass} tabular-nums`} type="date" value={h.return_date} min={riyadhTodayISO()} max={requestDateMaximum(riyadhTodayISO())} onChange={(e) => setHk("return_date")(e.target.value)} dir="ltr" /></Field> : <p className="self-end pb-2 text-xs text-muted">{tp.form.returnNotApplicable}</p>}
            <div className="sm:col-span-2"><Field label={tp.notes}><textarea className={`${inputClass} resize-none`} rows={3} value={h.notes} onChange={(e) => setHk("notes")(e.target.value)} /></Field></div>
          </>}
        </div>
        {step === 2 && <div className="mt-4 grid grid-cols-1 gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <Field label={tp.email} hint={tp.contactAutoNote}><input className={`${inputClass} bg-sunk`} value={sessionEmail} dir="ltr" readOnly /></Field>
          <Field label={tp.phone} hint={tp.contactAutoNote}><input className={`${inputClass} bg-sunk tabular-nums`} value={(profilePhone ?? "").trim() || "—"} dir="ltr" readOnly /></Field>
        </div>}
      </section>}

      {/* ما تحتاجه أولًا: لا ينتقل العميل قبل وجود عنصر حقيقي. */}
      {step === 1 && <>
        <section aria-labelledby="portal-items-heading" className="ui-surface overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-4 py-3.5 sm:px-5">
            {sectionTitle(1, tp.requestSteps.need, "portal-items-heading")}
            <span className="ui-count">{items.length}</span>
          </div>
          {items.length > 0 ? (
            <ul>
              {items.map((it) => (
                <li key={it.key} className="flex items-start gap-3 border-t border-line py-4 pe-2 ps-4 sm:ps-5">
                  <EquipmentPhoto asset={{ name: it.itemName || it.description, category: { name: it.categoryName } }} size="row" />
                  <div className="min-w-0 flex-1 text-[13.5px]">
                    <p className="font-semibold text-fg">
                      {it.mode === "catalog"
                        ? `${it.categoryName} · ${it.companyName} ${it.itemName}`
                        : it.mode === "consumable"
                          ? `${it.categoryName} · ${it.itemName}`
                          : it.description}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                      <span className="tabular-nums">{tp.quantityLabel}: {it.quantity}</span>
                      {it.mode === "consumable" && <StatusChip tone="info" size="sm" dot={false}>{tp.itemModeConsumable}</StatusChip>}
                    </p>
                    {it.availableQuantity !== null && <p className="mt-1 text-xs tabular-nums text-muted">{availabilityLabel(it.availableQuantity, it.mode)}</p>}
                    {it.availableQuantity !== null && Number(it.quantity) > it.availableQuantity && <p className="mt-1 text-xs font-semibold tabular-nums text-warn">{tp.availability.additionalNeeded.replace("{count}", String(Number(it.quantity) - it.availableQuantity))}</p>}
                  </div>
                  <Button variant="ghost" size="icon" aria-label={tp.remove} onClick={() => removeItem(it.key)} className="text-muted hover:text-bad"><Trash2 aria-hidden="true" className="h-4 w-4" /></Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="border-t border-line px-4 py-4 text-center text-[13px] text-muted sm:px-5">{tp.noItems}</p>
          )}
        </section>

        {/* بانية عنصر: من الكتالوج · مستهلك · احتياج مخصص */}
        <section aria-label={tp.addItem} className="ui-surface p-4 sm:p-6">
          <div className="ui-seg mb-4" role="group" aria-label={tp.itemsSection}>
            {(["catalog", "consumable", "custom"] as ItemMode[]).map((m) => (
              <button key={m} type="button" aria-pressed={d.mode === m} onClick={() => setD({ ...emptyDraft, mode: m })} className="ui-seg-item">
                {m === "catalog" ? tp.itemModeCatalog : m === "consumable" ? tp.itemModeConsumable : tp.itemModeCustom}
              </button>
            ))}
          </div>

          {d.mode === "catalog" ? (
            catalogEmpty ? (
              <p className="rounded-control bg-sunk px-3 py-3 text-xs text-fg-2">{tp.catalogEmpty}</p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={tp.itemCategory}>
                  <Select value={d.catId} onChange={(v) => setD((s) => ({ ...s, catId: v, companyId: "", modelId: "" }))} options={categories} placeholder="—" />
                </Field>
                <Field label={tp.itemBrand}>
                  <Select value={d.companyId} onChange={(v) => setD((s) => ({ ...s, companyId: v, modelId: "" }))} options={brands} placeholder="—" />
                </Field>
                <Field label={tp.itemModel}>
                  <Select value={d.modelId} onChange={(v) => setD((s) => ({ ...s, modelId: v }))} options={models} placeholder="—" />
                </Field>
                <Field label={tp.itemQuantity} error={!qtyValid ? tp.form.quantityMin : undefined}>
                  <input className={`${inputClass} tabular-nums`} type="number" min={1} value={d.quantity} onChange={(e) => setD((s) => ({ ...s, quantity: e.target.value }))} dir="ltr" />
                </Field>
              </div>
            )
          ) : d.mode === "consumable" ? (
            consumablesEmpty ? (
              <p className="rounded-control bg-sunk px-3 py-3 text-xs text-fg-2">{tp.consumablesEmpty}</p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={tp.itemCategory}>
                  <Select value={d.consCatId} onChange={(v) => setD((s) => ({ ...s, consCatId: v, consumableId: "" }))} options={consCategories} placeholder="—" />
                </Field>
                <Field label={tp.itemConsumable}>
                  <Select value={d.consumableId} onChange={(v) => setD((s) => ({ ...s, consumableId: v }))} options={consumableOpts} placeholder="—" />
                </Field>
                <Field label={tp.itemQuantity} error={!qtyValid ? tp.form.quantityMin : undefined}>
                  <input className={`${inputClass} tabular-nums`} type="number" min={1} value={d.quantity} onChange={(e) => setD((s) => ({ ...s, quantity: e.target.value }))} dir="ltr" />
                </Field>
              </div>
            )
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={tp.itemDescription}><input className={inputClass} value={d.description} onChange={(e) => setD((s) => ({ ...s, description: e.target.value }))} /></Field>
              <Field label={tp.itemQuantity} error={!qtyValid ? tp.form.quantityMin : undefined}>
                <input className={`${inputClass} tabular-nums`} type="number" min={1} value={d.quantity} onChange={(e) => setD((s) => ({ ...s, quantity: e.target.value }))} dir="ltr" />
              </Field>
              <p className="text-xs text-muted sm:col-span-2">{tp.itemModeCustomHint}</p>
            </div>
          )}

          {availability !== null && d.mode !== "custom" && (
            <div className="mt-3 rounded-control bg-brand-soft p-3 text-[13px] text-brand-ink">
              <p className="font-semibold tabular-nums">{availabilityLoading ? tp.availability.loading : availabilityLabel(availability, d.mode)}</p>
              <p className="mt-1 text-xs text-fg-2">{tp.availability.snapshotNote}</p>
              {qty > availability && <div className="mt-3 border-t border-line pt-3">
                <p className="font-medium tabular-nums">{availabilityLabel(availability, d.mode)}<br />{tp.availability.requested.replace("{count}", String(qty))}<br />{tp.availability.additionalNeeded.replace("{count}", String(qty - availability))}</p>
                <label className="mt-2 flex min-h-11 cursor-pointer items-start gap-2 text-xs text-fg"><input type="checkbox" checked={additionalAcknowledged} onChange={(e) => setAdditionalAcknowledged(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[rgb(var(--brand))]" /><span><strong>{tp.availability.requestAdditional}</strong><br />{tp.availability.additionalExplanation}</span></label>
              </div>}
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <Button type="button" variant="outline" onClick={addItem} disabled={addDisabled || availabilityLoading || (availability !== null && qty > availability && !additionalAcknowledged)}>
              <Plus aria-hidden="true" className="h-4 w-4" />{tp.addItem}
            </Button>
          </div>
        </section>
      </>}

      {/* المرفقات والمراجعة في نهاية التدفق، مع بقاء الحقول المطلوبة كما هي. */}
      {step === 4 && ctx?.allow_attachments && (
        <section aria-labelledby="portal-files-heading" className="ui-surface overflow-hidden">
          <div className="px-4 py-3.5 sm:px-5">
            <h2 id="portal-files-heading" className="flex items-center gap-2 font-display text-[17px] font-semibold text-fg"><Paperclip aria-hidden="true" className="h-4 w-4 text-muted" />{tp.attachments.sectionTitle}</h2>
            <p className="mt-0.5 text-xs text-muted">{tp.attachments.hint}</p>
          </div>
          {files.length > 0 && (
            <ul>
              {files.map((f, i) => (
                <li key={`${i}-${f.name}`} className="flex items-center gap-2 border-t border-line py-2 pe-1.5 ps-4 sm:ps-5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold text-fg">{f.name}</p>
                    <p className="text-xs tabular-nums text-muted" dir="ltr">{formatBytes(f.size)}</p>
                    {uploadedFiles.current.has(f) && <p className="text-xs text-ok">{tp.recovery.uploaded}</p>}
                    {uploadErrors.has(f) && <p role="alert" className="text-xs text-bad">{tp.recovery.uploadFailed}</p>}
                  </div>
                  <Button variant="ghost" size="icon" aria-label={tp.remove} onClick={() => removeFile(i)} disabled={busy || uploadedFiles.current.has(f)} className="text-muted hover:text-bad"><Trash2 aria-hidden="true" className="h-4 w-4" /></Button>
                </li>
              ))}
            </ul>
          )}
          {uploadErrors.size > 0 && <div className="border-t border-line px-4 py-3 sm:px-5">
            <Button variant="outline" disabled={blocked} onClick={() => void persist(false)}>{tp.recovery.retryAttachments}</Button>
          </div>}
          <div className="border-t border-line px-4 py-3 sm:px-5">
            <FileInput accept={ATTACHMENT_ACCEPT} file={null} onPick={pickFile} disabled={busy} />
          </div>
        </section>
      )}

      {/* مراجعة وإرسال */}
      {step === 4 && <section aria-labelledby="portal-review-heading" className="ui-surface overflow-hidden">
        <div className="px-4 py-3.5 sm:px-5">{sectionTitle(4, tp.requestSteps.review, "portal-review-heading")}</div>
        <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-2.5 border-t border-line px-4 py-3.5 text-[13.5px] sm:px-5">
          <ReviewRow label={tp.form.reviewItems} value={String(items.length)} />
          <ReviewRow label={tp.projectName} value={h.project_name || "—"} />
          <ReviewRow label={tp.city} value={h.city || "—"} />
          <ReviewRow label={tp.pickupDate} value={h.pickup_date || "—"} ltr />
          {hasCatalogItem && <ReviewRow label={tp.returnDate} value={h.return_date || "—"} ltr />}
          {ctx?.allow_attachments && <ReviewRow label={tp.form.reviewFiles} value={String(files.length)} />}
        </dl>
        {items.length === 0 && <p className="border-t border-line px-4 py-3 text-xs font-medium text-warn sm:px-5">{tp.needItems}</p>}
        {willNeedPmApproval && (
          <div className="flex items-start gap-2 border-t border-line bg-warn-soft px-4 py-3 text-[13px] text-warn sm:px-5">
            <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{tp.pmPendingNote}</span>
          </div>
        )}
        <div className="flex justify-center border-t border-line px-4 py-3 sm:justify-end sm:px-5">
          <Button variant="ghost" className="text-brand-ink" disabled={blocked} onClick={() => persist(false)}>{busy ? tp.saving : tp.saveDraft}</Button>
        </div>
      </section>}

      {/* شريط الإجراءات: ثابت فوق شريط التبويب على الجوال، وضمن التدفق على الشاشات الأكبر. */}
      <div className="fixed inset-x-0 bottom-[calc(72px+env(safe-area-inset-bottom))] z-20 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2.5 border-t border-line bg-surface px-4 py-3 md:static md:flex md:justify-between md:border-0 md:bg-transparent md:p-0">
        {step === 1 ? (
          <Link href="/client-portal/requests" className={buttonClass("outline", "md", "w-full md:w-auto")}>{tp.ledger.cancel}</Link>
        ) : (
          <Button type="button" variant="outline" className="w-full md:w-auto" onClick={goBack} disabled={busy || !!savedId}>
            <ArrowRight aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />{tp.previousStep}
          </Button>
        )}
        {step < 4 ? (
          <Button type="button" className="w-full md:w-auto" onClick={goNext} disabled={step === 1 && items.length === 0}>
            {tp.nextStep}<ArrowLeft aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />
          </Button>
        ) : (
          <Button className="w-full md:w-auto" disabled={blocked} onClick={() => persist(true)}>
            <Send aria-hidden="true" className="h-4 w-4" />{busy ? tp.saving : tp.submit}
          </Button>
        )}
      </div>
      <div aria-hidden="true" className="h-10 md:hidden" />

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

// رقم خطوة صغير لعناوين الأقسام.
function StepNum({ n }: { n: number }) {
  return <span aria-hidden="true" className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-bold tabular-nums text-brand-ink" dir="ltr">{n}</span>;
}
function ReviewRow({ label, value, ltr = false }: { label: string; value: string; ltr?: boolean }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className={`min-w-0 break-words font-semibold text-fg ${ltr ? "tabular-nums" : ""}`}>{ltr ? <bdi dir="ltr">{value}</bdi> : value}</dd>
    </>
  );
}
