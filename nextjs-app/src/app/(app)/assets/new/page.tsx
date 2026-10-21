"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Save, Upload, Boxes, Package, Layers, Fingerprint, MapPin, Receipt, NotebookPen, Lock, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button, buttonClass } from "@/components/ui/button";
import { Field, Select, inputClass } from "@/components/ui/form";
import { CreatableSelect } from "@/components/ui/creatable-select";
import { FileInput } from "@/components/ui/file-input";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Toast, type ToastState } from "@/components/ui/toast";
import { getFormOptions, createAsset, createModel, createLocation, uploadAssetAttachment, type NewAsset } from "@/lib/queries";
import { getInventorySettings, type InventorySettings } from "@/lib/inventory-settings";
import { ConsumableNewForm } from "@/components/consumables/consumable-new-form";
import { filterSuppliersByCategory } from "@/lib/suppliers";
import { useSession, canCreateAsset, canSeeFinancial, canManageSettings, useCan } from "@/lib/session";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { friendlyErrorStrict } from "@/lib/user-facing-errors";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import { FeatureUnavailablePanel } from "@/components/feature-gate";
import { AssetDynamicFields } from "@/components/assets/asset-dynamic-fields";
import { NewAssetAside, type CompletenessGroup } from "@/components/assets/new-asset-aside";
import { getTemplateByCategoryOrSection, TEMPLATES, buildSpecialAttributesForSave } from "@/lib/asset-type-templates";
import { computeCompleteness } from "@/lib/asset-completeness";
import type { AssetStatus } from "@/lib/types";
import { validateNewPhysicalAssetRequired } from "@/lib/new-asset-form";
import { ASSET_POOLS_UI_VISIBLE } from "@/lib/asset-pools-visibility";
import { parseStrictDecimal } from "@/lib/numeric-validation";

type Opt = { id: string; name?: string; name_ar?: string | null; brand?: string; model_name?: string; full_name?: string; full_name_ar?: string | null; category_id?: string };

export default function NewAssetPage() {
  const router = useRouter();
  const { role, loading: roleLoading } = useSession();
  const { t, lang } = useAppPreferences();
  const { isVisible } = useFeatureExposure();
  const can = useCan();
  const exposureAllowsAdd = isVisible("assets.add");
  const af = t.assetForm;
  const L = af.ledger;
  const [opts, setOpts] = useState<Awaited<ReturnType<typeof getFormOptions>> | null>(null);
  const [invDefaults, setInvDefaults] = useState<InventorySettings | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // نوع العنصر: أصل عادي أو مستهلك (المستهلك يُحفظ في جدول consumables بسلوك مخزون)
  const [itemType, setItemType] = useState<"asset" | "consumable">("asset");
  const [f, setF] = useState({
    category_id: "", model_id: "", serial_number: "", name: "",
    status: "available" as AssetStatus, location_id: "",
    purchase_date: "", purchase_cost: "",
    warranty_end: "", supplier_id: "", company_id: "", pool_id: "", rfid_tag: "", notes: "",
  });
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const [tmplVals, setTmplVals] = useState<Record<string, string>>({});
  // مرفقات الأصل تُرفع بعد الحفظ (نحتاج asset_id) — اختيارية، فشلها لا يُفشل إنشاء الأصل
  const [docPhoto, setDocPhoto] = useState<File | null>(null);
  const [docWarranty, setDocWarranty] = useState<File | null>(null);
  const [docPurchase, setDocPurchase] = useState<File | null>(null);

  useEffect(() => { getFormOptions().then(setOpts); }, []);
  useEffect(() => { getInventorySettings().then(setInvDefaults); }, []);
  // قيمة أولية لموقع الأصل من «المستودع الافتراضي» (إعدادات المخزون) — تُطبَّق مرة واحدة وفقط إن كان الموقع فارغًا.
  useEffect(() => {
    const loc = invDefaults?.default_location_id;
    if (!opts || !loc) return;
    if ((opts.locations as { id: string }[]).some((l) => l.id === loc)) {
      setF((s) => (s.location_id ? s : { ...s, location_id: loc }));
    }
  }, [opts, invDefaults]);

  const write = canCreateAsset(role);
  const fin = canSeeFinancial(role);
  const canSettings = canManageSettings(role);
  // رابط الاستيراد يظهر بنفس شرط صفحة الاستيراد نفسها (عرض فقط).
  const canImport = can("asset.import") && can("asset.create");
  const suppliersForCat = useMemo(
    () => filterSuppliersByCategory((opts?.suppliers ?? []) as Opt[], opts?.supplierCategories ?? [], f.category_id),
    [opts, f.category_id],
  );
  const models = useMemo(
    () => (opts?.models ?? []).filter((m: Opt) => !f.category_id || m.category_id === f.category_id),
    [opts, f.category_id]
  );
  // القالب المكتشف من التصنيف المختار + الاسم المكتوب (طبقة عرض فقط)
  const template = useMemo(() => {
    if (!f.category_id) return null;
    const cat = (opts?.categories ?? []).find((c: Opt) => c.id === f.category_id);
    const id = getTemplateByCategoryOrSection(cat?.name, cat?.name_ar, null, f.name, f.serial_number, null);
    return TEMPLATES[id];
  }, [opts, f.category_id, f.name, f.serial_number]);

  // ---- إضافة بيانات مرجعية جديدة من داخل القوائم ----
  async function onCreateModel(vals: Record<string, string>) {
    const { error, row } = await createModel({ categoryId: f.category_id, brand: vals.brand ?? "", modelName: vals.model_name ?? "" });
    if (error || !row) { setToast({ type: "error", message: af.toasts.modelError + (error ?? "") }); return { value: "", label: "", error: error ?? "" }; }
    setOpts((s: any) => (s ? { ...s, models: [...s.models, row] } : s));
    setToast({ type: "success", message: af.toasts.modelSaved });
    return { value: row.id as string, label: `${row.brand} ${row.model_name}`, error: null };
  }
  async function onCreateLocation(vals: Record<string, string>) {
    const { error, row } = await createLocation({ name: vals.name ?? "" });
    if (error || !row) { setToast({ type: "error", message: af.toasts.locationError + (error ?? "") }); return { value: "", label: "", error: error ?? "" }; }
    setOpts((s: any) => (s ? { ...s, locations: [...s.locations, row] } : s));
    setToast({ type: "success", message: af.toasts.locationSaved });
    return { value: row.id as string, label: (row.name_ar ?? row.name) as string, error: null };
  }

  function validate() {
    const e: Record<string, string> = {};
    for (const code of validateNewPhysicalAssetRequired({ categoryId: f.category_id, locationId: f.location_id, companyId: f.company_id, serialNumber: f.serial_number })) {
      if (code === "category") e.category_id = af.errors.category;
      if (code === "location") e.location_id = af.errors.location;
      if (code === "company") e.company_id = af.errors.company;
      if (code === "serial") e.serial_number = af.errors.serial;
    }
    const purchaseCost = parseStrictDecimal(f.purchase_cost);
    if (!purchaseCost.ok) e.purchase_cost = af.errors.cost;
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    const purchaseCost = parseStrictDecimal(f.purchase_cost);
    if (!purchaseCost.ok) return;
    setSaving(true);
    const payload: NewAsset = {
      category_id: f.category_id,
      model_id: f.model_id || null,
      serial_number: f.serial_number.trim() || null,
      name: f.name.trim() || null,
      status: f.status,
      location_id: f.location_id || null,
      department_id: null,
      assigned_to_employee_id: null,
      purchase_date: f.purchase_date || null,
      purchase_cost: purchaseCost.value,
      warranty_end: f.warranty_end || null,
      supplier_id: f.supplier_id || null,
      company_id: f.company_id || null,
      pool_id: f.pool_id || null,
      rfid_tag: f.rfid_tag.trim() || null,
      notes: f.notes.trim() || null,
      special_attributes: template ? buildSpecialAttributesForSave(null, template, tmplVals, []) : null,
    };
    const { error, id } = await createAsset(payload);
    if (!id) {
      setSaving(false);
      // (DATA-4) رسالة محددة للرقم التسلسلي المكرر (وغيره من الأخطاء المعروفة/التقنية) بدل النص الخام.
      setToast({ type: "error", message: friendlyErrorStrict(error, lang) });
      return;
    }
    // id موجود مع error ⇒ الأصل أُنشئ لكن فشل سجل التاريخ/العهدة — تحذير دون إفشال الحفظ
    let historyErr: string | null = error;
    // رفع المرفقات بعد توفّر asset_id — فشل أي مرفق لا يُفشل إنشاء الأصل (تحذير فقط)
    const uploads: Array<[File | null, "asset_photo" | "warranty_invoice" | "purchase_invoice"]> = [
      [docPhoto, "asset_photo"], [docWarranty, "warranty_invoice"], [docPurchase, "purchase_invoice"],
    ];
    let uploadErr: string | null = null;
    for (const [file, kind] of uploads) {
      if (file) { const e = await uploadAssetAttachment(id, file, kind); if (e && !uploadErr) uploadErr = e; }
    }
    setSaving(false);
    const warn = uploadErr ? t.assetDetail.docs.uploadError + uploadErr : historyErr;
    setToast(warn
      ? { type: "error", message: af.toasts.saved + " — " + warn }
      : { type: "success", message: af.toasts.saved });
    setTimeout(() => router.push(`/assets/${id}`), 700);
  }

  if (!opts || !invDefaults) {
    return (
      <div aria-busy="true" className="animate-pulse space-y-4">
        <div className="h-9 w-56 rounded-lg bg-sunk" />
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="h-96 rounded-card bg-sunk" />
          <div className="h-72 rounded-card bg-sunk" />
        </div>
      </div>
    );
  }

  const noPermission = (
    <Card>
      <EmptyState icon={Lock} title={af.noPermission}
        action={<Link href="/assets" className={buttonClass("outline", "sm")}>{af.backToAssets}</Link>} />
    </Card>
  );

  if (!roleLoading && !canCreateAsset(role)) return noPermission;

  // إظهار تدريجي: نموذج إضافة أصل من مستوى 50 — رابط مباشر تحت المستوى ⇒ لوحة «تُفعَّل لاحقًا»
  // (بعد فحص الدور أعلاه: من لا يملك الكتابة يرى رسالة الصلاحيات المعتادة، لا هذه).
  if (!roleLoading && !exposureAllowsAdd) return <FeatureUnavailablePanel />;

  const o = (arr: Opt[], labelKey: "name" | "full_name") =>
    arr.map((x) => ({ value: x.id, label: (labelKey === "name" ? (x.name_ar ?? x.name) : (x.full_name_ar ?? x.full_name)) as string }));

  // ---- معاينة الملصق + مؤشّر الاكتمال (عرض فقط؛ لا يغيّر التحقق أو الحفظ) ----
  const catObj = (opts.categories as Opt[]).find((c) => c.id === f.category_id);
  const catName = catObj ? ((lang === "en" ? (catObj.name ?? catObj.name_ar) : (catObj.name_ar ?? catObj.name)) ?? "") : "";
  const modelObj = (models as Opt[]).find((m) => m.id === f.model_id);
  const modelLabel = modelObj ? `${modelObj.brand} ${modelObj.model_name}` : "";
  const locObj = (opts.locations as Opt[]).find((l) => l.id === f.location_id);
  const locName = locObj ? ((lang === "en" ? (locObj.name ?? locObj.name_ar) : (locObj.name_ar ?? locObj.name)) ?? "") : "";
  const has = (v: string) => v.trim() !== "";
  const typeData = template
    ? computeCompleteness(
        { name: f.name, serial_number: f.serial_number, category: catObj ? { name: catObj.name, name_ar: catObj.name_ar } : null, special_attributes: tmplVals },
        { canSeeFinancial: fin, canWrite: write },
      )
    : null;
  const groups: CompletenessGroup[] = [
    { key: "identity", label: L.sections.identity, filled: [f.name, f.serial_number, f.rfid_tag].filter(has).length, total: 3, requiredMissing: !has(f.serial_number) },
    { key: "classification", label: L.sections.classification, filled: [f.category_id, f.model_id].filter(has).length, total: 2, requiredMissing: !has(f.category_id) },
    ...(typeData && typeData.total > 0 ? [{ key: "type", label: t.assetTemplates.ui.typeFieldsTitle, filled: typeData.filled, total: typeData.total, requiredMissing: false }] : []),
    { key: "location", label: L.sections.location, filled: [f.location_id, f.company_id].filter(has).length, total: 2, requiredMissing: !has(f.location_id) || !has(f.company_id) },
    {
      key: "purchase", label: L.sections.purchase,
      filled: [f.supplier_id, f.purchase_date, f.warranty_end, ...(fin ? [f.purchase_cost] : [])].filter(has).length,
      total: fin ? 4 : 3, requiredMissing: false,
    },
  ];
  const fieldLabels = t.assetTemplateFields as Record<string, string>;
  const missingLabels = [
    ...(!has(f.category_id) ? [af.fields.category] : []),
    ...(!has(f.serial_number) ? [af.fields.serial] : []),
    ...(!has(f.location_id) ? [af.fields.location] : []),
    ...(typeData ? typeData.missingKeys.slice(0, 4).map((k) => fieldLabels[k] ?? k) : []),
  ];

  return (
    <div>
      <PageHeader
        title={af.newTitle}
        description={af.newSubtitle}
        actions={
          <>
            {/* نوع العنصر: أصل أو مستهلك — المستهلك يُحفظ في جدول consumables بسلوك مخزون */}
            <div role="group" aria-label={af.itemType} className="ui-seg">
              {(["asset", "consumable"] as const).map((it) => (
                <button key={it} type="button" aria-pressed={itemType === it} onClick={() => setItemType(it)} className="ui-seg-item">
                  {it === "asset" ? <Boxes aria-hidden="true" className="h-4 w-4" /> : <Package aria-hidden="true" className="h-4 w-4" />}
                  {it === "asset" ? af.typeAsset : af.typeConsumable}
                </button>
              ))}
            </div>
            {canImport && (
              <Link href="/assets/import" className={buttonClass("ghost", "md")}>
                <Upload aria-hidden="true" className="h-4 w-4" />{t.import.title}
              </Link>
            )}
          </>
        }
      />

      {itemType === "consumable" && (
        <p role="note" className="mb-4 rounded-xl bg-brand-soft px-3.5 py-2.5 text-[13px] text-brand-ink">{af.consumableHint}</p>
      )}

      {itemType === "consumable" ? (
        <ConsumableNewForm opts={opts} fin={fin} write={write} setToast={setToast} defaults={invDefaults} />
      ) : !canCreateAsset(role) ? (
        // إنشاء الأصول محصور بـ admin/it_manager (إخفاء واجهة). المستهلكات تبقى متاحة عبر مبدّل النوع أعلاه.
        noPermission
      ) : (
      <form onSubmit={onSubmit}>
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col gap-4">
            {/* ١) التعريف: الاسم / الرقم التسلسلي / RFID — (حقل المجموعة مُخفى من الواجهة، pool_id يبقى في الحفظ) */}
            <FormSection id="new-asset-identity" icon={Fingerprint} title={L.sections.identity} hint={L.hints.identity}>
              <Field label={af.fields.descriptiveName}>
                <input className={inputClass} value={f.name} onChange={(e) => set("name")(e.target.value)} placeholder={af.placeholders.descriptiveName} />
              </Field>
              <Field label={af.fields.serial} required error={errors.serial_number} hint={af.serialHint}>
                <input className={inputClass} value={f.serial_number} onChange={(e) => set("serial_number")(e.target.value)} dir="ltr" placeholder="SN-..." />
              </Field>
              <Field label={af.fields.rfid} hint={af.rfidHint}>
                <input className={inputClass} value={f.rfid_tag} onChange={(e) => set("rfid_tag")(e.target.value)} dir="ltr" />
              </Field>
              <div>
                <span className="ui-label">{L.tagLabel}</span>
                <div className="flex min-h-[38px] items-center gap-2.5 rounded-control border border-dashed border-line-strong bg-surface-2 px-3 text-[13px] text-muted max-md:min-h-11">
                  <Lock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />{L.tagAuto}
                </div>
              </div>
              {ASSET_POOLS_UI_VISIBLE && (
                <Field label={t.pools.field}>
                  <Select value={f.pool_id} onChange={set("pool_id")} placeholder={t.pools.select}
                    options={o((opts?.pools ?? []) as Opt[], "name")} />
                </Field>
              )}
            </FormSection>

            {/* ٢) التصنيف + حقول القالب */}
            <FormSection id="new-asset-classification" icon={Layers} title={L.sections.classification} hint={L.hints.classification}>
              <Field label={af.fields.category} required error={errors.category_id}>
                <Select value={f.category_id} onChange={(v) => {
                  set("category_id")(v); set("model_id")("");
                  // صفّر المورد إن لم يَعُد ضمن موردي التصنيف الجديد
                  const ok = filterSuppliersByCategory((opts?.suppliers ?? []) as Opt[], opts?.supplierCategories ?? [], v).some((s) => s.id === f.supplier_id);
                  if (!ok) set("supplier_id")("");
                }} placeholder={af.placeholders.category}
                  options={o(opts.categories as Opt[], "name")} />
              </Field>
              <Field label={af.fields.model} hint={f.category_id ? undefined : af.placeholders.modelHint}>
                <CreatableSelect key={f.category_id || "no-cat"} value={f.model_id} onChange={set("model_id")} disabled={!f.category_id} placeholder={af.placeholders.chooseModelOptional}
                  options={(models as Opt[]).map((m) => ({ value: m.id, label: `${m.brand} ${m.model_name}` }))}
                  canCreate={write} addLabel={af.addModel} dialogTitle={af.addModel}
                  fields={[{ key: "brand", label: af.brand, placeholder: "Dell", required: true }, { key: "model_name", label: af.modelName, placeholder: "Latitude 5440", required: true }]}
                  onCreate={onCreateModel} />
              </Field>
              <Field label={af.fields.status} hint={L.custodyNote}>
                <Select value={f.status} onChange={(v) => set("status")(v as AssetStatus)}
                  options={(["available","in_maintenance"] as AssetStatus[]).map((s) => ({ value: s, label: t.status[s] }))} />
              </Field>
              {template && (
                <div className="md:col-span-2">
                  <AssetDynamicFields
                    template={template}
                    values={tmplVals}
                    onChange={(k, v) => setTmplVals((s) => ({ ...s, [k]: v }))}
                    canSeeFinancial={fin}
                    canWrite={write}
                  />
                </div>
              )}
            </FormSection>

            {/* ٣) الموقع والملكية — العهدة تُحدَّد لاحقًا عبر مسار التسليم */}
            <FormSection id="new-asset-location" icon={MapPin} title={L.sections.location} hint={L.hints.location}>
              <Field label={af.fields.location} required error={errors.location_id}>
                <CreatableSelect value={f.location_id} onChange={set("location_id")} placeholder={af.placeholders.location}
                  options={o(opts.locations as Opt[], "name")}
                  canCreate={write} addLabel={af.addLocation} dialogTitle={af.addLocation}
                  fields={[{ key: "name", label: af.locationName, required: true }]}
                  onCreate={onCreateLocation} />
              </Field>
              <Field label={af.fields.company} required error={errors.company_id}>
                <Select value={f.company_id} onChange={set("company_id")} placeholder={af.chooseCompany}
                  options={(opts.companies ?? []).map((c) => ({ value: c.id, label: c.name }))} />
                {(opts.companies?.length ?? 0) === 0 && (
                  <p className="mt-1.5 text-xs text-warn">
                    {af.noCompanies}
                    {canSettings && <Link href="/settings" className="ms-1 font-medium text-brand-ink hover:underline">{af.manageCompanies}</Link>}
                  </p>
                )}
              </Field>
            </FormSection>

            {/* ٤) الشراء والضمان — قيمة الشراء لمن لديه صلاحية مالية فقط */}
            <FormSection id="new-asset-purchase" icon={Receipt} title={L.sections.purchase} hint={fin ? L.hints.purchaseFin : L.hints.purchase}>
              <Field label={af.fields.supplier} hint={f.category_id ? undefined : af.chooseCategoryForSupplier}>
                <Select value={f.supplier_id} onChange={set("supplier_id")} placeholder={af.chooseSupplier}
                  options={o(suppliersForCat as Opt[], "name")} />
                {f.category_id && suppliersForCat.length === 0 && (
                  <p className="mt-1.5 text-xs text-warn">
                    {af.noSuppliersForCategory}
                    {canSettings && <Link href="/settings" className="ms-1 font-medium text-brand-ink hover:underline">{af.manageSuppliers}</Link>}
                  </p>
                )}
              </Field>
              {fin && (
                <Field label={af.fields.purchaseCost} error={errors.purchase_cost}>
                  <input className={`${inputClass} tabular-nums`} value={f.purchase_cost} onChange={(e) => set("purchase_cost")(e.target.value)} dir="ltr" inputMode="decimal" placeholder="0.00" />
                </Field>
              )}
              <Field label={af.fields.purchaseDate} hint={t.common.dateHint}>
                <input type="date" className={inputClass} value={f.purchase_date} onChange={(e) => set("purchase_date")(e.target.value)} dir="ltr" />
              </Field>
              <Field label={af.fields.warrantyEnd} hint={t.common.dateHint}>
                <input type="date" className={inputClass} value={f.warranty_end} onChange={(e) => set("warranty_end")(e.target.value)} dir="ltr" />
              </Field>
            </FormSection>

            {/* ٥) الملاحظات والمستندات — تُرفع بعد الحفظ. الفواتير المالية لمن لديه canSeeFinancial فقط */}
            <FormSection id="new-asset-notes" icon={NotebookPen} title={L.sections.notesDocs} hint={L.hints.notesDocs}>
              <div className="md:col-span-2">
                <Field label={af.fields.notes}>
                  <textarea className={`${inputClass} resize-none`} rows={3} value={f.notes} onChange={(e) => set("notes")(e.target.value)} />
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 md:col-span-2">
                <FileField label={t.assetDetail.docs.devicePhoto} accept="image/*" file={docPhoto} onPick={setDocPhoto} />
                {fin && <FileField label={t.assetDetail.docs.warrantyInvoice} accept="image/*,application/pdf" file={docWarranty} onPick={setDocWarranty} financial={L.financialChip} />}
                {fin && <FileField label={t.assetDetail.docs.purchaseInvoice} accept="image/*,application/pdf" file={docPurchase} onPick={setDocPurchase} financial={L.financialChip} />}
              </div>
            </FormSection>

            <div className="ui-surface sticky bottom-3 z-10 flex flex-wrap items-center justify-end gap-2 px-4 py-3 shadow-modal">
              <Link href="/assets" className={buttonClass("ghost", "md")}>{t.common.cancel}</Link>
              <Button type="submit" disabled={saving}><Save aria-hidden="true" className="h-4 w-4" />{saving ? af.saving : af.save}</Button>
            </div>
          </div>

          <NewAssetAside
            equipment={{ name: f.name, serial_number: f.serial_number, category: catObj, special_attributes: tmplVals }} templateId={template?.id}
            label={L.asideLabel}
            name={f.name.trim() || modelLabel || catName || ""}
            sub={[catName, locName].filter(Boolean).join(" · ")}
            groups={groups}
            missing={missingLabels}
          />
        </div>
      </form>
      )}

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

// قسم مرئي في نموذج الأصل — بطاقة بعنوان h2 + وصف + شبكة عمودين. لا يغيّر أي منطق حفظ/تحقّق.
function FormSection({ id, icon: Icon, title, hint, children }: { id: string; icon: LucideIcon; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="ui-surface px-5 pb-5 pt-[18px]">
      <div className="mb-4 flex items-center gap-3">
        <span aria-hidden="true" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-sunk text-fg-2">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h2 id={id} className="font-display text-[15px] font-semibold text-fg">{title}</h2>
          {hint && <p className="text-[12.5px] text-muted">{hint}</p>}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-x-[18px] gap-y-4 md:grid-cols-2">{children}</div>
    </section>
  );
}

// حقل رفع ملف بسيط للمرفقات أثناء إنشاء الأصل
function FileField({ label, accept, file, onPick, financial }: {
  label: string; accept: string; file: File | null; onPick: (f: File | null) => void; financial?: string;
}) {
  return (
    <div className="rounded-xl border border-line p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-fg-2">
        {label}
        {financial && <span className="inline-flex h-5 items-center rounded-full bg-sunk px-2 text-[11px] font-semibold text-fg-2">{financial}</span>}
      </p>
      <FileInput accept={accept} file={file} onPick={onPick} />
    </div>
  );
}
