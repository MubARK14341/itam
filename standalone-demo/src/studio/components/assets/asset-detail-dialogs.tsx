"use client";

// حوارات صفحة تفاصيل الأصل (تسليم / إرجاع / نقل / صيانة / تغيير حالة / تعديل).
// نُقلت كما هي من صفحة التفاصيل — نفس الاستدعاءات والتحقق والرسائل؛ التغيير في العرض فقط.

import { useEffect, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, inputClass } from "@/components/ui/form";
import { CreatableSelect } from "@/components/ui/creatable-select";
import { FileInput } from "@/components/ui/file-input";
import type { ToastState } from "@/components/ui/toast";
import type { SaveFeedback } from "@/lib/save-feedback";
import {
  PRIORITY_OPTS, STAGE_OPTS, MTYPE_OPTS, PROBLEM_TYPE_OPTS, DEFAULT_PROBLEM_TYPE,
} from "@/lib/maintenance";
import type { AssetStatus } from "@/lib/types";
import { useSession, canManageSettings } from "@/lib/session";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import type { Dict } from "@/lib/i18n";
import {
  assignAsset, returnAsset, moveAsset, changeStatus, addMaintenance, updateAsset,
  createModel, createLocation, uploadMaintenanceAttachment,
} from "@/lib/queries";
import { filterSuppliersByCategory } from "@/lib/suppliers";
import { AssetDynamicFields } from "@/components/assets/asset-dynamic-fields";
import { ASSET_POOLS_UI_VISIBLE } from "@/lib/asset-pools-visibility";
import { getTemplateByCategoryOrSection, TEMPLATES, buildSpecialAttributesForSave } from "@/lib/asset-type-templates";
import { parseStrictDecimal } from "@/lib/numeric-validation";

// User-facing primary-state transitions. Custody and delivery remain
// relationships; they never create a fourth primary status.
export const NEXT: Record<AssetStatus, AssetStatus[]> = {
  available: ["in_maintenance"],
  reserved: ["in_maintenance"],
  in_maintenance: ["available"],
};

type DoneMsg = ToastState;

// ترجمة رموز أخطاء RPCs العهدة (asset_assign/asset_return/asset_change_status)
function assetRpcError(d: any, e: string): string {
  return d.rpcErr?.[e] ?? e;
}

export function AssignDialog({ open, onClose, assetId, fromStatus, employees, onDone }: any) {
  const { t } = useAppPreferences(); const d = t.assetDialogs;
  const [emp, setEmp] = useState(""); const [due, setDue] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  async function submit() {
    if (!emp) { setErr(d.errEmployee); return; }
    setBusy(true); const e = await assignAsset({ assetId, employeeId: emp, dueDate: due || null });
    setBusy(false);
    onDone(e ? { type: "error", message: d.errAssign + assetRpcError(d, e) } as DoneMsg : { type: "success", message: d.doneAssign });
  }
  return (
    <Dialog open={open} onClose={onClose} title={d.assignTitle}
      footer={<><Button variant="outline" onClick={onClose}>{t.common.cancel}</Button><Button onClick={submit} disabled={busy}>{busy?"…":d.assignBtn}</Button></>}>
      <div className="space-y-4">
        <Field label={d.employee} required error={err}>
          <Select value={emp} onChange={setEmp} placeholder={d.chooseEmployee}
            options={(employees ?? []).map((x: any) => ({ value: x.id, label: x.full_name_ar ?? x.full_name }))} />
        </Field>
        <Field label={d.expectedReturn} hint={t.common.dateHint}><input type="date" className={inputClass} value={due} onChange={(e)=>setDue(e.target.value)} dir="ltr" /></Field>
      </div>
    </Dialog>
  );
}

export function ReturnDialog({ open, onClose, assetId, fromStatus, onDone }: any) {
  const { t } = useAppPreferences(); const d = t.assetDialogs;
  const [cond, setCond] = useState(""); const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); const e = await returnAsset({ assetId, condition: cond || null });
    setBusy(false);
    onDone(e ? { type:"error", message:d.errReturn+assetRpcError(d, e) } : { type:"success", message:d.doneReturn });
  }
  return (
    <Dialog open={open} onClose={onClose} title={d.returnTitle}
      footer={<><Button variant="outline" onClick={onClose}>{t.common.cancel}</Button><Button onClick={submit} disabled={busy}>{busy?"…":d.returnBtn}</Button></>}>
      <Field label={d.conditionOnReturn}>
        <Select value={cond} onChange={setCond} placeholder={d.optional}
          options={(["new","good","fair","poor"] as const).map((v)=>({value:v,label:t.condition[v]}))} />
      </Field>
    </Dialog>
  );
}

export function MoveDialog({ open, onClose, assetId, fromLocation, locations, departments, canCreate, setToast, onDone }: any) {
  const { t } = useAppPreferences(); const d = t.assetDialogs; const af = t.assetForm;
  const [loc, setLoc] = useState(""); const [dep, setDep] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  async function submit() {
    if (!loc) { setErr(d.errLocation); return; }
    setBusy(true); const e = await moveAsset({ assetId, toLocationId: loc, fromLocationId: fromLocation ?? null, toDepartmentId: dep || null });
    setBusy(false);
    onDone(e ? { type:"error", message:d.errMove+e } : { type:"success", message:d.doneMove });
  }
  async function onCreateLoc(vals: Record<string, string>) {
    const { error, row } = await createLocation({ name: vals.name ?? "" });
    if (error || !row) { setToast?.({ type: "error", message: af.toasts.locationError + (error ?? "") }); return { value: "", label: "", error: error ?? "" }; }
    setToast?.({ type: "success", message: af.toasts.locationSaved });
    return { value: row.id as string, label: (row.name_ar ?? row.name) as string, error: null };
  }
  return (
    <Dialog open={open} onClose={onClose} title={d.moveTitle}
      footer={<><Button variant="outline" onClick={onClose}>{t.common.cancel}</Button><Button onClick={submit} disabled={busy}>{busy?"…":d.moveBtn}</Button></>}>
      <div className="space-y-4">
        <Field label={d.newLocation} required error={err}>
          <CreatableSelect value={loc} onChange={setLoc} placeholder={d.chooseLocation} options={(locations??[]).map((x:any)=>({value:x.id,label:x.name_ar??x.name}))}
            canCreate={canCreate} addLabel={af.addLocation} dialogTitle={af.addLocation}
            fields={[{ key: "name", label: af.locationName, required: true }]}
            onCreate={onCreateLoc} />
        </Field>
        <Field label={d.departmentOptional}>
          <Select value={dep} onChange={setDep} placeholder={d.noChange} options={(departments??[]).map((x:any)=>({value:x.id,label:x.name_ar??x.name}))} />
        </Field>
      </div>
    </Dialog>
  );
}

const MAINT_FIELDS = (t: Dict, f: any, set: (k: string) => (v: string) => void, err: string, showCost: boolean) => {
  const fm = t.maintenance.dialog;
  const tl = (g: Record<string, string>, v: string) => g[v] ?? v;
  return (
  <>
    <div className="grid grid-cols-2 gap-3">
      <Field label={fm.priority}><Select value={f.priority} onChange={set("priority")} options={PRIORITY_OPTS.map(([v]) => ({ value: v, label: tl(t.priority, v) }))} /></Field>
      <Field label={fm.problemType}><Select value={f.ptype} onChange={set("ptype")} options={PROBLEM_TYPE_OPTS.map(([v]) => ({ value: v, label: tl(t.problemType, v) }))} /></Field>
      <Field label={fm.type}><Select value={f.type} onChange={set("type")} options={MTYPE_OPTS.map(([v]) => ({ value: v, label: tl(t.mtype, v) }))} /></Field>
      <Field label={fm.stage}><Select value={f.stage} onChange={set("stage")} options={STAGE_OPTS.map(([v]) => ({ value: v, label: tl(t.stage, v) }))} /></Field>
    </div>
    <Field label={fm.problem} required error={err}><textarea className={`${inputClass} resize-none`} rows={2} value={f.problem} onChange={(e) => set("problem")(e.target.value)} /></Field>
    <Field label={fm.action}><textarea className={`${inputClass} resize-none`} rows={2} value={f.action} onChange={(e) => set("action")(e.target.value)} /></Field>
    <div className="grid grid-cols-3 gap-3">
      {/* HIGH-1 (Strict): technician لا يرى/يُدخل تكلفة الصيانة — تُعرض للمدراء فقط. */}
      {showCost && <Field label={fm.cost}><input className={inputClass} value={f.cost} onChange={(e) => set("cost")(e.target.value)} dir="ltr" inputMode="decimal" placeholder="0" /></Field>}
      {showCost && <Field label={fm.invoice}><input className={inputClass} value={f.invoice} onChange={(e) => set("invoice")(e.target.value)} dir="ltr" /></Field>}
      <Field label={fm.nextDue} hint={t.common.dateHint}><input type="date" className={inputClass} value={f.next} onChange={(e) => set("next")(e.target.value)} dir="ltr" /></Field>
    </div>
    <Field label={fm.summary}><textarea className={`${inputClass} resize-none`} rows={2} value={f.summary} onChange={(e) => set("summary")(e.target.value)} /></Field>
  </>
  );
};

const EMPTY_MAINT = {
  type: "corrective", stage: "open", priority: "medium", ptype: DEFAULT_PROBLEM_TYPE, problem: "", action: "",
  cost: "", invoice: "", summary: "", next: "",
  vendorSupplierId: "", vendorName: "", vendorPhone: "", vendorLocation: "", vendorMapLink: "",
  invoiceDate: "", receiverName: "", handoffNotes: "",
};

export function MaintDialog({ open, onClose, assetId, assetStatus, employees, suppliers, showCost, onDone }: {
  open: boolean; onClose: () => void; assetId: string; assetStatus: AssetStatus;
  employees: any[]; suppliers: any[]; showCost: boolean;
  onDone: (message: SaveFeedback) => void;
}) {
  const { t } = useAppPreferences(); const fm = t.maintenance.dialog; const tv = t.maintenance.vendor;
  const [f, setF] = useState<any>({ ...EMPTY_MAINT, reporterEmp: "" });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  useEffect(() => { if (open) { setF({ ...EMPTY_MAINT, reporterEmp: "" }); setErr(""); setPhoto(null); } }, [open]);
  const set = (k: string) => (v: string) => setF((s: any) => ({ ...s, [k]: v }));
  async function submit() {
    if (!f.problem.trim()) { setErr(fm.problemRequired); return; }
    setBusy(true);
    const { error, id, warning } = await addMaintenance({
      assetId, assetStatus, type: f.type, workflowStage: f.stage, priority: f.priority, problemType: f.ptype,
      reporterEmployeeId: f.reporterEmp || null, problem: f.problem.trim() || null, action: f.action.trim() || null,
      cost: showCost && f.cost.trim() !== "" && Number.isFinite(Number(f.cost))
        ? Number(f.cost)
        : null,
      invoiceNumber: showCost ? (f.invoice.trim() || null) : null,
      finalSummary: f.summary.trim() || null, nextDue: f.next || null,
      vendorSupplierId: f.vendorSupplierId || null, vendorName: f.vendorName.trim() || null,
      vendorPhone: f.vendorPhone.trim() || null, vendorLocation: f.vendorLocation.trim() || null,
      vendorMapLink: f.vendorMapLink.trim() || null,
      invoiceDate: showCost ? (f.invoiceDate || null) : null,
      receiverName: f.receiverName.trim() || null, handoffNotes: f.handoffNotes.trim() || null,
    });
    // رفع صورة الجهاز (إن وُجدت) بعد إنشاء السجل لتوفّر معرّف السجل
    const upErr = (!error && id && photo) ? await uploadMaintenanceAttachment(id, photo, "device_photo") : null;
    setBusy(false);
    onDone(
      error ? { type: "error", message: fm.saveError + error, persisted: false }
      : upErr ? { type: "error", message: fm.savedNoPhoto + upErr, persisted: true }
      : warning ? { type: "error", message: fm.statusSyncWarn, persisted: true }
      : { type: "success", message: fm.saved, persisted: true },
    );
  }
  return (
    <Dialog open={open} onClose={onClose} title={fm.newTitle}
      footer={<><Button variant="outline" onClick={onClose}>{t.common.cancel}</Button><Button onClick={submit} disabled={busy}>{busy ? "…" : fm.save}</Button></>}>
      <div className="space-y-4">
        {MAINT_FIELDS(t, f, set, err, showCost)}
        <Field label={fm.reporter} hint={fm.reporterHint}>
          <Select value={f.reporterEmp} onChange={set("reporterEmp")} placeholder={fm.reporterPlaceholder}
            options={(employees ?? []).map((x: any) => ({ value: x.id, label: x.full_name_ar ?? x.full_name }))} />
        </Field>

        {/* جهة الصيانة الخارجية / المحل */}
        <fieldset className="rounded-xl border border-line p-4">
          <legend className="px-1 text-[13px] font-semibold text-fg-2">{tv.section}</legend>
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={tv.supplier}>
                <Select value={f.vendorSupplierId} onChange={set("vendorSupplierId")} placeholder={tv.supplierNone}
                  options={(suppliers ?? []).map((s: any) => ({ value: s.id, label: s.name_ar ?? s.name }))} />
              </Field>
              <Field label={tv.name}><input className={inputClass} value={f.vendorName} onChange={(e) => set("vendorName")(e.target.value)} /></Field>
              <Field label={tv.phone}><input className={inputClass} value={f.vendorPhone} onChange={(e) => set("vendorPhone")(e.target.value)} dir="ltr" inputMode="tel" /></Field>
              <Field label={tv.location}><input className={inputClass} value={f.vendorLocation} onChange={(e) => set("vendorLocation")(e.target.value)} /></Field>
              <Field label={tv.mapLink}><input className={inputClass} value={f.vendorMapLink} onChange={(e) => set("vendorMapLink")(e.target.value)} dir="ltr" placeholder="https://maps.google.com/…" /></Field>
              {showCost && <Field label={tv.invoiceDate} hint={t.common.dateHint}><input type="date" className={inputClass} value={f.invoiceDate} onChange={(e) => set("invoiceDate")(e.target.value)} dir="ltr" /></Field>}
              <Field label={tv.receiverName}><input className={inputClass} value={f.receiverName} onChange={(e) => set("receiverName")(e.target.value)} /></Field>
            </div>
            <Field label={tv.handoffNotes}><textarea className={`${inputClass} resize-none`} rows={2} value={f.handoffNotes} onChange={(e) => set("handoffNotes")(e.target.value)} /></Field>
            <Field label={tv.devicePhoto}>
              <FileInput accept="image/*" file={photo} onPick={setPhoto} />
            </Field>
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}

export function StatusDialog({ open, onClose, assetId, fromStatus, onDone }: any) {
  const { t } = useAppPreferences(); const d = t.assetDialogs;
  const [to, setTo] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const choices = NEXT[fromStatus as AssetStatus] ?? [];
  async function submit() {
    if (!to) { setErr(d.errStatus); return; }
    setBusy(true); const e = await changeStatus({ assetId, toStatus: to as AssetStatus });
    setBusy(false);
    onDone(e ? { type:"error", message:d.errTransition+assetRpcError(d, e) } : { type:"success", message:d.doneStatus });
  }
  return (
    <Dialog open={open} onClose={onClose} title={d.statusTitle}
      footer={<><Button variant="outline" onClick={onClose}>{t.common.cancel}</Button><Button onClick={submit} disabled={busy}>{busy?"…":d.changeBtn}</Button></>}>
      <Field label={d.newStatus} required error={err} hint={`${d.currentStatus}: ${t.status[fromStatus as AssetStatus]}`}>
        <Select value={to} onChange={setTo} placeholder={d.chooseStatus}
          options={choices.map((s)=>({ value:s, label: t.status[s] }))} />
      </Field>
    </Dialog>
  );
}

export function EditAssetDialog({ open, onClose, asset, opts, canCreate, canSeeFinancial, setToast, onDone }: any) {
  const { t } = useAppPreferences(); const af = t.assetForm;
  const { role } = useSession();
  const canSettings = canManageSettings(role);
  const cur: AssetStatus = asset?.status ?? "available";
  const [f, setF] = useState<any>(null);
  const [attrs, setAttrs] = useState<{ k: string; v: string }[]>([]); // صفوف «حقول أخرى» جديدة فقط
  const [tmplVals, setTmplVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});

  async function onCreateModel(vals: Record<string, string>) {
    const { error, row } = await createModel({ categoryId: f.category_id, brand: vals.brand ?? "", modelName: vals.model_name ?? "" });
    if (error || !row) { setToast?.({ type: "error", message: af.toasts.modelError + (error ?? "") }); return { value: "", label: "", error: error ?? "" }; }
    setToast?.({ type: "success", message: af.toasts.modelSaved });
    return { value: row.id as string, label: `${row.brand} ${row.model_name}`, error: null };
  }
  async function onCreateLocation(vals: Record<string, string>) {
    const { error, row } = await createLocation({ name: vals.name ?? "" });
    if (error || !row) { setToast?.({ type: "error", message: af.toasts.locationError + (error ?? "") }); return { value: "", label: "", error: error ?? "" }; }
    setToast?.({ type: "success", message: af.toasts.locationSaved });
    return { value: row.id as string, label: (row.name_ar ?? row.name) as string, error: null };
  }

  useEffect(() => {
    if (!open || !asset) return;
    setF({
      name: asset.name ?? "", category_id: asset.category_id ?? "", model_id: asset.model_id ?? "",
      serial_number: asset.serial_number ?? "", status: asset.status ?? "available",
      location_id: asset.location_id ?? "", department_id: asset.department_id ?? "",
      supplier_id: asset.supplier_id ?? "", company_id: asset.company_id ?? "", pool_id: asset.pool_id ?? "", rfid_tag: asset.rfid_tag ?? "", purchase_date: asset.purchase_date ?? "",
      purchase_cost: asset.purchase_cost != null ? String(asset.purchase_cost) : "",
      warranty_end: asset.warranty_end ?? "", condition_grade: asset.condition_grade ?? "", notes: asset.notes ?? "",
    });
    // القيم المنظَّمة للقالب تُبذر من كل المفاتيح الحالية (نصّيًا)؛ صفوف «حقول أخرى» تبدأ فارغة
    setTmplVals(
      Object.fromEntries(
        Object.entries(asset.special_attributes ?? {}).map(([k, v]) => [k, v === true ? "true" : v === false ? "false" : String(v)]),
      ),
    );
    setAttrs([]);
    setErr({});
  }, [open, asset]);

  if (!open || !f) return null;
  const set = (k: string) => (v: string) => setF((s: any) => ({ ...s, [k]: v }));
  const models = (opts?.models ?? []).filter((m: any) => !f.category_id || m.category_id === f.category_id);
  const statusOpts = asset?.assigned_to_employee_id ? [] : Array.from(new Set([cur, ...(NEXT[cur] ?? [])]));

  // القالب المكتشف من التصنيف المختار + الاسم + القسم (طبقة عرض فقط)
  const catObj = (opts?.categories ?? []).find((c: any) => c.id === f.category_id);
  const sectionVal = (asset?.special_attributes?.section as string | undefined) ?? null;
  const templateId = f.category_id
    ? getTemplateByCategoryOrSection(catObj?.name, catObj?.name_ar, sectionVal, f.name, f.serial_number, asset?.special_attributes)
    : "other";
  const template = TEMPLATES[templateId];
  const templateKeys = new Set(template.fields.map((x) => x.key));
  const legacyEntries = Object.entries(asset?.special_attributes ?? {}).filter(([k]) => !templateKeys.has(k));
  const typeChanged = f.category_id && asset?.category_id && f.category_id !== asset.category_id;

  async function submit() {
    const e: Record<string, string> = {};
    if (!f.category_id) e.category_id = af.errors.category;
    // asset_update_atomic rejects a missing location/company (required_asset_fields).
    if (!f.location_id) e.location_id = af.errors.location;
    if (!f.company_id) e.company_id = af.errors.company;
    const purchaseCost = parseStrictDecimal(f.purchase_cost);
    if (!purchaseCost.ok) e.purchase_cost = af.errors.cost;
    setErr(e); if (Object.keys(e).length) return;
    if (!purchaseCost.ok) return;
    setBusy(true);
    // دمج آمن: لا يُحذف أي مفتاح قديم/محميّ
    const special = buildSpecialAttributesForSave(asset.special_attributes ?? null, template, tmplVals, attrs);
    const msg = await updateAsset(asset.id, cur, {
      name: f.name.trim() || null, category_id: f.category_id, model_id: f.model_id || null,
      serial_number: f.serial_number.trim() || null,
      status: (asset?.assigned_to_employee_id ? cur : f.status) as AssetStatus,
      location_id: f.location_id || null, department_id: f.department_id || null, supplier_id: f.supplier_id || null,
      company_id: f.company_id || null, pool_id: f.pool_id || null, rfid_tag: f.rfid_tag.trim() || null,
      purchase_date: f.purchase_date || null,
      // HIGH-1: لا نمرّر purchase_cost إلا من مخوّل مالي (وإلا يُحذف من الـ patch فلا يُمسح بالخطأ).
      ...(canSeeFinancial ? { purchase_cost: purchaseCost.value } : {}),
      warranty_end: f.warranty_end || null, condition_grade: f.condition_grade || null,
      notes: f.notes.trim() || null, special_attributes: special,
    });
    setBusy(false);
    onDone(msg ? { type: "error", message: af.toasts.updateError + msg } : { type: "success", message: af.toasts.updated });
  }

  return (
    <Dialog open={open} onClose={onClose} title={af.editTitle} size="2xl"
      footer={<><Button variant="outline" onClick={onClose}>{t.common.cancel}</Button><Button onClick={submit} disabled={busy}>{busy ? "…" : af.saveEdit}</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={af.fields.name}><input className={inputClass} value={f.name} onChange={(e) => set("name")(e.target.value)} /></Field>
          <Field label={af.fields.category} required error={err.category_id}>
            <Select value={f.category_id} onChange={(v) => {
              set("category_id")(v); set("model_id")("");
              // صفّر المورد إن لم يَعُد ضمن موردي التصنيف الجديد
              const ok = filterSuppliersByCategory(opts?.suppliers ?? [], opts?.supplierCategories ?? [], v).some((s: any) => s.id === f.supplier_id);
              if (!ok) set("supplier_id")("");
            }} placeholder={af.placeholders.category}
              options={(opts?.categories ?? []).map((c: any) => ({ value: c.id, label: c.name_ar ?? c.name }))} />
          </Field>
          <Field label={af.fields.model}>
            <CreatableSelect key={f.category_id || "no-cat"} value={f.model_id} onChange={set("model_id")} disabled={!f.category_id} placeholder={af.placeholders.none}
              options={models.map((m: any) => ({ value: m.id, label: `${m.brand} ${m.model_name}` }))}
              canCreate={canCreate} addLabel={af.addModel} dialogTitle={af.addModel}
              fields={[{ key: "brand", label: af.brand, placeholder: "Dell", required: true }, { key: "model_name", label: af.modelName, placeholder: "Latitude 5440", required: true }]}
              onCreate={onCreateModel} />
          </Field>
          <Field label={af.fields.serial}><input className={inputClass} value={f.serial_number} onChange={(e) => set("serial_number")(e.target.value)} dir="ltr" /></Field>
          <Field label={af.fields.status} hint={asset?.assigned_to_employee_id ? af.assignedHint : undefined}>
            <Select value={asset?.assigned_to_employee_id ? "" : f.status} onChange={set("status")} disabled={Boolean(asset?.assigned_to_employee_id)}
              placeholder={asset?.assigned_to_employee_id ? af.assignedPlaceholder : undefined}
              options={statusOpts.map((s) => ({ value: s, label: t.status[s] }))} />
          </Field>
          <Field label={af.fields.conditionGrade}>
            <Select value={f.condition_grade} onChange={set("condition_grade")} placeholder={t.unspecified}
              options={(["new", "good", "fair", "poor"] as const).map((v) => ({ value: v, label: t.condition[v] }))} />
          </Field>
          <Field label={af.fields.location} required error={err.location_id}>
            <CreatableSelect value={f.location_id} onChange={set("location_id")} placeholder={af.placeholders.none}
              options={(opts?.locations ?? []).map((l: any) => ({ value: l.id, label: l.name_ar ?? l.name }))}
              canCreate={canCreate} addLabel={af.addLocation} dialogTitle={af.addLocation}
              fields={[{ key: "name", label: af.locationName, required: true }]}
              onCreate={onCreateLocation} />
          </Field>
          <Field label={af.fields.department}>
            <Select value={f.department_id} onChange={set("department_id")} placeholder={af.placeholders.none}
              options={(opts?.departments ?? []).map((dep: any) => ({ value: dep.id, label: dep.name_ar ?? dep.name }))} />
          </Field>
          <div>
            {(() => {
              const supOpts = filterSuppliersByCategory(opts?.suppliers ?? [], opts?.supplierCategories ?? [], f.category_id);
              return (
                <>
                  <Field label={af.fields.supplier}>
                    <Select value={f.supplier_id} onChange={set("supplier_id")} placeholder={af.chooseSupplier}
                      options={supOpts.map((s: any) => ({ value: s.id, label: s.name_ar ?? s.name }))} />
                  </Field>
                  {f.category_id && supOpts.length === 0 && (
                    <p className="mt-1.5 text-xs text-warn">
                      {af.noSuppliersForCategory}
                      {canSettings && <Link href="/settings" className="ms-1 font-medium text-brand-ink hover:underline">{af.manageSuppliers}</Link>}
                    </p>
                  )}
                </>
              );
            })()}
          </div>
          <Field label={af.fields.company} required error={err.company_id}>
            <Select value={f.company_id} onChange={set("company_id")} placeholder={af.chooseCompany}
              options={(opts?.companies ?? []).map((c: any) => ({ value: c.id, label: c.name }))} />
          </Field>
          {/* حقل مجموعة الأصل — مُخفى من الواجهة مؤقتًا؛ pool_id يبقى في الحالة والحفظ (لا يُمسح عند التعديل) */}
          {ASSET_POOLS_UI_VISIBLE && (
          <Field label={t.pools.field}>
            {(() => {
              // خيارات المجموعات النشطة + المجموعة الحالية للأصل حتى لو صارت معطّلة (لئلا تختفي عند التعديل)
              const opt = (opts?.pools ?? []).map((p: any) => ({ value: p.id, label: p.name_ar ?? p.name }));
              if (asset?.pool_id && !opt.some((o: any) => o.value === asset.pool_id)) {
                opt.unshift({ value: asset.pool_id, label: `${asset.pool?.name_ar ?? asset.pool?.name ?? asset.pool_id} (${t.pools.inactive})` });
              }
              return <Select value={f.pool_id} onChange={set("pool_id")} placeholder={t.pools.select} options={opt} />;
            })()}
          </Field>
          )}
          <Field label={af.fields.rfid} hint={af.rfidOptional}>
            <input className={inputClass} value={f.rfid_tag} onChange={(e) => set("rfid_tag")(e.target.value)} dir="ltr" />
          </Field>
          {canSeeFinancial && <Field label={af.fields.purchaseCost} error={err.purchase_cost}><input className={inputClass} value={f.purchase_cost} onChange={(e) => set("purchase_cost")(e.target.value)} dir="ltr" inputMode="decimal" /></Field>}
          <Field label={af.fields.purchaseDate} hint={t.common.dateHint}><input type="date" className={inputClass} value={f.purchase_date} onChange={(e) => set("purchase_date")(e.target.value)} dir="ltr" /></Field>
          <Field label={af.fields.warrantyEnd} hint={t.common.dateHint}><input type="date" className={inputClass} value={f.warranty_end} onChange={(e) => set("warranty_end")(e.target.value)} dir="ltr" /></Field>
        </div>
        <Field label={af.fields.notes}><textarea className={`${inputClass} resize-none`} rows={2} value={f.notes} onChange={(e) => set("notes")(e.target.value)} /></Field>

        {typeChanged && (
          <p role="status" className="rounded-xl bg-warn-soft px-3 py-2.5 text-xs text-warn">{t.assetTemplateWarnings.changeType}</p>
        )}

        <AssetDynamicFields
          template={template}
          values={tmplVals}
          onChange={(k, v) => setTmplVals((s) => ({ ...s, [k]: v }))}
          canSeeFinancial={canSeeFinancial}
          canWrite={canCreate}
          collapsible={false}
        />

        <div className="rounded-xl border border-line p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[13px] font-semibold text-fg-2">{t.assetTemplates.ui.otherFieldsTitle}</p>
            <Button type="button" size="sm" variant="ghost" className="text-brand-ink" onClick={() => setAttrs((a) => [...a, { k: "", v: "" }])}>{t.assetTemplates.ui.addOtherField}</Button>
          </div>
          {legacyEntries.length > 0 && (
            <div className="mb-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {legacyEntries.map(([k, v]) => (
                <div key={k} className="flex items-center gap-1 text-xs">
                  <span className="text-muted" dir="ltr">{k}:</span>
                  <span className="tag text-fg-2">{String(v)}</span>
                </div>
              ))}
            </div>
          )}
          {attrs.length === 0
            ? legacyEntries.length === 0 && <p className="text-xs text-muted">{af.noSpecialFields}</p>
            : (
              <div className="space-y-2">
                {attrs.map((row, i) => (
                  <div key={i} className="flex gap-2">
                    <input className={inputClass} aria-label={t.assetTemplates.ui.fieldKey} placeholder={t.assetTemplates.ui.fieldKey} value={row.k} dir="ltr" onChange={(e) => setAttrs((a) => a.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} />
                    <input className={inputClass} aria-label={t.assetTemplates.ui.fieldValue} placeholder={t.assetTemplates.ui.fieldValue} value={row.v} onChange={(e) => setAttrs((a) => a.map((x, j) => j === i ? { ...x, v: e.target.value } : x))} />
                    <Button type="button" variant="danger-ghost" size="icon" onClick={() => setAttrs((a) => a.filter((_, j) => j !== i))} aria-label={af.ledger.removeField}>
                      <X aria-hidden="true" className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          <p className="mt-2 text-[11.5px] text-muted">{t.assetTemplates.ui.otherFieldsHint}</p>
        </div>
      </div>
    </Dialog>
  );
}
