"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Upload, ExternalLink, Paperclip, UserPlus, Undo2, MoveRight, Wrench, Wallet, History, FileText,
  Store, Camera, MapPin,
} from "lucide-react";
import { Drawer } from "@/components/ui/drawer";
import { EquipmentPhoto } from "@/components/assets/equipment-photo";
import { Button, buttonClass } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";
import { StatusBadge } from "@/components/ui/badge";
import { Field, Select, inputClass } from "@/components/ui/form";
import type { ToastState } from "@/components/ui/toast";
import { formatSAR, formatDate, formatDateTime } from "@/lib/format";
import { safeHttpUrl } from "@/lib/safe-url";
import type { AssetStatus } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import {
  addMaintenanceTimeEntry,
  assignMaintenanceTechnician,
  confirmMaintenanceHandoff,
  getAttachmentUrl,
  getMaintenanceExtras,
  planMaintenancePart,
  updateMaintenance,
  uploadMaintenanceAttachment,
} from "@/lib/queries";
import {
  PRIORITY_OPTS, STAGE_OPTS,
  MTYPE_OPTS, PROBLEM_TYPE_OPTS, DEFAULT_PROBLEM_TYPE, maintenanceDisplayLabel,
} from "@/lib/maintenance";
import { PRIORITY_TONE, STAGE_TONE } from "@/lib/tone";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { friendlyErrorStrict } from "@/lib/user-facing-errors";

type Extras = Awaited<ReturnType<typeof getMaintenanceExtras>> | null;

// نافذة إدارة الصيانة المشتركة — تُستخدم في /maintenance وفي تبويب الصيانة بصفحة الأصل.
// تعرض: ملخّص الأصل + تاريخ الجهاز + تفاصيل السجل + نموذج تحديث (للمخوّلين).
export function MaintenanceModal({
  record, canWrite, canSeeFinancial = false, canSeeMaintenanceCost = false, onClose, onDone,
}: {
  record: any | null;
  canWrite: boolean;
  canSeeFinancial?: boolean;       // إجمالي تكلفة الصيانة (تجميعي/مالي حسّاس)
  canSeeMaintenanceCost?: boolean; // تكلفة السجل الواحد (تشغيلي)
  onClose: () => void;
  onDone: (t: ToastState) => void;
}) {
  const { t, lang } = useAppPreferences();
  const tm = t.maintenance.modal;
  const [extras, setExtras] = useState<Extras>(null);
  const [loading, setLoading] = useState(true);
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [upBusy, setUpBusy] = useState(false);
  const [upMsg, setUpMsg] = useState("");
  const [assignBusy, setAssignBusy] = useState(false);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string; name_ar: string | null }[]>([]);
  const [consumables, setConsumables] = useState<{ id: string; name: string; unit: string }[]>([]);
  const [timeForm, setTimeForm] = useState({ startedAt: "", endedAt: "", note: "" });
  const [partForm, setPartForm] = useState({ consumableId: "", description: "", quantity: "1" });
  const [evidenceBusy, setEvidenceBusy] = useState(false);

  useEffect(() => {
    if (!record) { setExtras(null); setF(null); return; }
    setLoading(true); setErr(""); setUpMsg("");
    setTimeForm({ startedAt: "", endedAt: "", note: "" });
    setPartForm({ consumableId: "", description: "", quantity: "1" });
    const stage = record.workflow_stage ?? (record.status === "completed" ? "completed" : record.status === "in_progress" ? "investigating" : "open");
    setF({
      _recordId: record.id,
      type: record.type ?? "corrective", stage, priority: record.priority ?? "medium",
      ptype: record.problem_type ?? DEFAULT_PROBLEM_TYPE,
      problem: record.problem_description ?? "", action: record.action_taken ?? "",
      followNote: "",
      cost: record.cost != null ? String(record.cost) : "", invoice: record.invoice_number ?? "",
      summary: record.final_summary ?? "", next: record.next_due_date ?? "",
      // Phase 5 — جهة الصيانة الخارجية / المحل
      vendorSupplierId: record.vendor_supplier_id ?? "", vendorName: record.vendor_name ?? "",
      vendorPhone: record.vendor_phone ?? "", vendorLocation: record.vendor_location ?? "",
      vendorMapLink: record.vendor_map_link ?? "", invoiceDate: record.invoice_date ?? "",
      receiverName: record.receiver_name ?? "", handoffNotes: record.handoff_notes ?? "",
      diagnosis: record.diagnosis ?? "", causeCode: record.cause_code ?? "",
      resolutionCode: record.resolution_code ?? "", waitingReason: record.waiting_reason ?? "",
      laborMinutes: String(record.labor_minutes ?? 0),
      safetyChecked: Boolean(record.repair_checklist?.safety_checked),
      functionChecked: Boolean(record.repair_checklist?.function_checked),
      dataChecked: Boolean(record.repair_checklist?.data_checked),
      functionalPassed: record.functional_test_passed === true,
      functionalNotes: record.functional_test_notes ?? "",
    });
    let alive = true;
    getMaintenanceExtras(
      { id: record.id, asset_id: record.asset_id, technician_id: record.technician_id },
      canSeeFinancial,
    )
      .then((x) => { if (alive) { setExtras(x); setLoading(false); } });
    // قائمة الموردين المُسجَّلين (لربط جهة الصيانة اختياريًا) — تُدار من الإعدادات
    createClient().from("suppliers").select("id,name,name_ar").eq("is_active", true).order("name")
      .then(({ data }) => { if (alive) setSuppliers((data as any) ?? []); });
    createClient().from("consumables").select("id,name,unit").eq("is_active", true).order("name")
      .then(({ data }) => { if (alive) setConsumables((data as any) ?? []); });
    return () => { alive = false; };
  }, [record, canSeeFinancial]);

  if (!record) return null;
  // حماية من الانهيار: عند فتح سجل، تُعرَض النافذة قبل أن تُهيّئ useEffect حالة النموذج (f=null)
  // في أول إطار. نرجع null حتى تُهيَّأ القيم الآمنة، فلا تُقرأ خصائص من كائن null (BLOCKER: f.ptype).
  if (!f || f._recordId !== record.id) return null;
  const set = (k: string) => (v: string) => setF((s: any) => ({ ...s, [k]: v }));
  // يضمن ظهور القيمة الحالية في القائمة حتى لو كانت قيمة قديمة غير قياسية (بلا فقدان البيانات)
  const optWith = (opts: [string, string][], v: string, label: string): [string, string][] =>
    (!v || opts.some(([k]) => k === v)) ? opts : [...opts, [v, label]];
  const tLabel = (group: Record<string, string>, v: string) => maintenanceDisplayLabel(v, lang, group[v] ?? v);
  const probOpts = PROBLEM_TYPE_OPTS.map(([v]) => [v, tLabel(t.problemType, v)] as [string, string]);
  const prioOpts = PRIORITY_OPTS.map(([v]) => [v, tLabel(t.priority, v)] as [string, string]);
  const stageOpts = STAGE_OPTS.map(([v]) => [v, tLabel(t.stage, v)] as [string, string]);
  const typeOpts = MTYPE_OPTS.map(([v]) => [v, tLabel(t.mtype, v)] as [string, string]);
  const asset = extras?.asset ?? record.asset ?? null;
  const h = extras?.history;
  const assetStatus: AssetStatus = (asset?.status ?? "available") as AssetStatus;
  const reporter = record.reporter?.full_name_ar ?? record.reporter?.full_name ?? tm.defaultReporter;
  const tv = t.maintenance.vendor;
  const supplierName = (id: string) => { const s = suppliers.find((x) => x.id === id); return s ? (s.name_ar ?? s.name) : null; };
  const vendorDisplay = record.vendor_name || (record.vendor_supplier_id ? supplierName(record.vendor_supplier_id) : null);
  const kindLabel = (k: string | null) => (
    k === "device_photo"
      ? tv.kindDevicePhoto
      : k === "invoice" || k === "maintenance_invoice"
        ? tv.kindInvoice
        : tv.kindOther
  );
  const mapHref = safeHttpUrl(record.vendor_map_link);
  const hasVendorInfo = vendorDisplay || record.vendor_phone || record.vendor_location || record.vendor_map_link || (canSeeMaintenanceCost && record.invoice_date) || record.receiver_name || record.handoff_notes;
  const visibleAttachments = canSeeMaintenanceCost
    ? (extras?.attachments ?? [])
    : (extras?.attachments ?? []).filter(
      (a: any) => a.classification !== "financial"
        && a.kind !== "invoice"
        && a.kind !== "maintenance_invoice",
    );

  async function submit() {
    if (!f.problem.trim()) { setErr(tm.problemRequired); return; }
    if (
      (f.stage === "completed" || f.stage === "unrepairable")
      && (!f.diagnosis.trim() || !f.causeCode.trim() || !f.resolutionCode.trim())
    ) {
      setErr("يتطلب إغلاق الصيانة التشخيص والسبب والحل.");
      return;
    }
    if (
      f.stage === "completed"
      && (!f.functionalPassed || !f.safetyChecked || !f.functionChecked || !f.dataChecked)
    ) {
      setErr("يتطلب الإغلاق الناجح اجتياز الاختبار الوظيفي وإكمال قائمة الفحص.");
      return;
    }
    if ((f.stage === "awaiting_parts" || f.stage === "at_vendor") && !f.waitingReason.trim()) {
      setErr("سبب الانتظار مطلوب لهذه المرحلة.");
      return;
    }
    setBusy(true);
    // ملاحظة المتابعة تُضاف إلى «الإجراء المتّخذ» مع حفظ ما سبق
    const action = f.followNote.trim()
      ? `${f.action.trim() ? f.action.trim() + "\n" : ""}${tm.form.followLabel} (${formatDate(new Date().toISOString(), lang)}): ${f.followNote.trim()}`
      : (f.action.trim() || null);
    const payload = {
      type: f.type, workflowStage: f.stage, priority: f.priority, problemType: f.ptype,
      problem: f.problem.trim() || null, action,
      finalSummary: f.summary.trim() || null, nextDue: f.next || null,
      vendorSupplierId: f.vendorSupplierId || null, vendorName: f.vendorName.trim() || null,
      vendorPhone: f.vendorPhone.trim() || null, vendorLocation: f.vendorLocation.trim() || null,
      vendorMapLink: f.vendorMapLink.trim() || null,
      receiverName: f.receiverName.trim() || null, handoffNotes: f.handoffNotes.trim() || null,
      diagnosis: f.diagnosis.trim() || null,
      causeCode: f.causeCode.trim() || null,
      resolutionCode: f.resolutionCode.trim() || null,
      waitingReason: f.waitingReason.trim() || null,
      laborMinutes: Number.isFinite(Number(f.laborMinutes))
        ? Math.max(0, Math.trunc(Number(f.laborMinutes)))
        : 0,
      repairChecklist: {
        safety_checked: f.safetyChecked,
        function_checked: f.functionChecked,
        data_checked: f.dataChecked,
      },
      functionalTestPassed: f.functionalPassed,
      functionalTestNotes: f.functionalNotes.trim() || null,
      ...(canSeeMaintenanceCost ? {
        cost: f.cost.trim() === "" || !Number.isFinite(Number(f.cost))
          ? null
          : Number(f.cost),
        invoiceNumber: f.invoice.trim() || null,
        invoiceDate: f.invoiceDate || null,
      } : {}),
    };
    const { error: e, warning } = await updateMaintenance(record.id, record.asset_id, assetStatus, payload);
    setBusy(false);
    onDone(
      e ? { type: "error", message: tm.updateError + e }
      : warning ? { type: "error", message: tm.statusSyncWarn }
      : { type: "success", message: tm.updated },
    );
  }

  async function uploadFile(ev: React.ChangeEvent<HTMLInputElement>, kind: "device_photo" | "invoice" | "other") {
    const file = ev.target.files?.[0]; if (!file) return;
    setUpBusy(true); setUpMsg("");
    const err = await uploadMaintenanceAttachment(record.id, file, kind);
    ev.target.value = "";
    if (err) { setUpBusy(false); setUpMsg(friendlyErrorStrict(err, lang)); return; }
    setUpBusy(false); setUpMsg(tm.uploaded);
    const x = await getMaintenanceExtras(
      { id: record.id, asset_id: record.asset_id, technician_id: record.technician_id },
      canSeeFinancial,
    );
    setExtras(x);
  }

  async function refreshExtras() {
    const next = await getMaintenanceExtras({
      id: record.id,
      asset_id: record.asset_id,
      technician_id: record.technician_id,
    }, canSeeFinancial);
    setExtras(next);
  }

  async function addTime() {
    if (!timeForm.startedAt || !timeForm.endedAt) return;
    setEvidenceBusy(true);
    const error = await addMaintenanceTimeEntry({
      maintenanceId: record.id,
      startedAt: new Date(timeForm.startedAt).toISOString(),
      endedAt: new Date(timeForm.endedAt).toISOString(),
      note: timeForm.note.trim() || null,
    });
    setEvidenceBusy(false);
    if (error) { setErr(friendlyErrorStrict(error, lang)); return; }
    setTimeForm({ startedAt: "", endedAt: "", note: "" });
    await refreshExtras();
  }

  async function addPart() {
    const quantity = Number(partForm.quantity);
    if ((!partForm.consumableId && !partForm.description.trim()) || !Number.isFinite(quantity) || quantity <= 0) return;
    setEvidenceBusy(true);
    const error = await planMaintenancePart({
      maintenanceId: record.id,
      consumableId: partForm.consumableId || null,
      description: partForm.description.trim() || null,
      plannedQuantity: quantity,
    });
    setEvidenceBusy(false);
    if (error) { setErr(friendlyErrorStrict(error, lang)); return; }
    setPartForm({ consumableId: "", description: "", quantity: "1" });
    await refreshExtras();
  }

  async function openAttachment(path: string, fileName: string) {
    const { url } = await getAttachmentUrl(path, fileName);
    if (url) window.open(url, "_blank");
  }


  const currentStage = record.workflow_stage ?? f?.stage ?? "";
  const sectionTitle = "mb-2.5 flex items-center gap-1.5 text-[13px] font-semibold text-muted";
  const detailsBox = "overflow-hidden rounded-2xl border border-line bg-surface";
  const summaryClass = "flex min-h-12 cursor-pointer items-center gap-2 px-4 text-sm font-semibold text-fg-2 hover:bg-surface-2 hover:text-fg";
  const checkboxClass = "h-4 w-4 shrink-0 accent-brand";
  const fileLabelClass = `${buttonClass("outline", "sm")} cursor-pointer focus-within:ring-2 focus-within:ring-brand`;

  return (
    <Drawer
      open={!!record}
      onClose={onClose}
      width="lg"
      eyebrow={tm.title}
      title={<span className="tag">{asset?.asset_tag ?? "—"}</span>}
      footer={
        <>
          <Button variant="outline" onClick={onClose} type="button">{t.common.close}</Button>
          {asset?.id && (
            <Link href={`/assets/${asset.id}`} className={buttonClass("outline", "md")}>
              <ExternalLink aria-hidden="true" className="h-4 w-4" />{tm.openAsset}
            </Link>
          )}
          {canWrite && <Button onClick={submit} disabled={busy || loading} type="button">{busy ? tm.savingUpdate : tm.saveUpdate}</Button>}
        </>
      }
    >
      <div className="space-y-6">
        {/* ملخّص الأصل */}
        <section aria-label={tm.assetSummary}>
          <EquipmentPhoto asset={asset} size="preview" className="mb-5" />
          <h3 className="font-display text-xl font-semibold leading-snug text-fg">{asset?.name ?? asset?.category?.name_ar ?? "—"}</h3>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {asset && <StatusBadge status={assetStatus} />}
            {currentStage && <StatusChip tone={STAGE_TONE[currentStage]}>{tLabel(t.stage, currentStage) || "—"}</StatusChip>}
            {record.priority && <StatusChip tone={PRIORITY_TONE[record.priority]}>{tm.form.priority} {tLabel(t.priority, record.priority) ?? "—"}</StatusChip>}
            <StatusChip tone="neu" dot={false}>{record.problem_type ? tLabel(t.problemType, record.problem_type) : tLabel(t.mtype, record.type)}</StatusChip>
            <span className="text-xs text-muted">{tLabel(t.mtype, record.type)}</span>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-line bg-surface-2 p-4 text-[13.5px] sm:grid-cols-3">
            <Cell label={tm.cells.category} value={asset?.category?.name_ar ?? asset?.category?.name} />
            <Cell label={tm.cells.currentStatus} value={asset ? t.status[assetStatus] : null} />
            <Cell label={tm.cells.serial} value={asset?.serial_number} mono />
            <Cell label={tm.cells.location} value={asset?.location?.name_ar ?? asset?.location?.name} />
            <Cell label={tm.cells.holder} value={asset?.holder?.full_name_ar ?? asset?.holder?.full_name} />
          </dl>
        </section>

        {/* تاريخ الجهاز — مرجع ثانوي، مطوي افتراضيًا حتى تبقى المشكلة الحالية والإجراء في المقدمة. */}
        <details className={detailsBox}>
          <summary className={summaryClass}><History aria-hidden="true" className="h-4 w-4 text-muted" />{tm.deviceHistory}</summary>
          <div className="grid grid-cols-2 gap-2 border-t border-line p-4 sm:grid-cols-3">
            <HistStat icon={UserPlus} label={tm.hist.assigned} value={h?.assigned ?? 0} loading={loading} />
            <HistStat icon={Undo2} label={tm.hist.returned} value={h?.returned ?? 0} loading={loading} />
            <HistStat icon={MoveRight} label={tm.hist.transferred} value={h?.transferred ?? 0} loading={loading} />
            <HistStat icon={Wrench} label={tm.hist.maintenanceCount} value={h?.maintenanceCount ?? 0} loading={loading} />
            {canSeeFinancial && (
              <HistStat
                icon={Wallet}
                label={`${tm.hist.totalMaint} · ${h?.totalMaintCostCoverage ?? 0}%`}
                value={h?.totalMaintCost != null ? formatSAR(h.totalMaintCost, lang) : "—"}
                loading={loading}
                small
              />
            )}
            <HistStat icon={History} label={tm.hist.lastMaint} value={h?.lastMaintAt ? formatDate(h.lastMaintAt, lang) : "—"} loading={loading} small />
          </div>
        </details>

        {/* تفاصيل سجل الصيانة الحالي */}
        <section className="border-t border-line pt-5">
          <h4 className={sectionTitle}><FileText aria-hidden="true" className="h-4 w-4" />{tm.currentRecord}</h4>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-[13.5px] sm:grid-cols-2">
            <Cell label={tm.cells.reporter} value={reporter} />
            <Cell label={tm.cells.reportedAt} value={formatDateTime(record.reported_at, lang)} />
            <Cell label={tm.cells.technician} value={extras?.technician ?? "—"} />
            {canSeeMaintenanceCost && <Cell label={tm.cells.cost} value={formatSAR(record.cost, lang)} />}
            {canSeeMaintenanceCost && <Cell label={tm.cells.invoice} value={record.invoice_number} mono />}
            <Cell label={tm.cells.closedAt} value={record.completed_at ? formatDateTime(record.completed_at, lang) : "—"} />
            <Cell label={tm.cells.slaDue} value={record.sla_due_at ? formatDateTime(record.sla_due_at, lang) : "—"} />
            <Cell label={tm.cells.handoffStatus} value={maintenanceDisplayLabel(record.handoff_state, lang, record.handoff_state ?? "—")} />
          </dl>
          {/* «أسندها لي» — إسناد الفني يُعد إجراء متابعة (يُخرج السجل من تنبيه «بلا إجراء»).
              RLS ops يحكم الكتابة؛ الزر يظهر فقط لسجل مفتوح بلا فنيّ ولمن يملك canWrite. */}
          {canWrite && !record.technician_id && record.status !== "completed" && record.status !== "cancelled" && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-2 p-3">
              <Button
                size="sm" variant="outline"
                disabled={assignBusy}
                onClick={async () => {
                  setAssignBusy(true);
                  const e = await assignMaintenanceTechnician(record.id);
                  setAssignBusy(false);
                  onDone(e
                    ? { type: "error", message: friendlyErrorStrict(e, lang) }
                    : { type: "success", message: tm.assignedToMe });
                }}
              >
                <UserPlus aria-hidden="true" className="h-3.5 w-3.5" />{assignBusy ? t.common.saving : tm.assignToMe}
              </Button>
            </div>
          )}
          {record.problem_description && <p className="mt-3 rounded-xl bg-surface-2 p-3 text-[13.5px] text-fg"><span className="text-muted">{tm.problem}</span>{record.problem_description}</p>}
          {record.action_taken && <p className="mt-2 whitespace-pre-line text-[13px] text-fg-2"><span className="text-muted">{tm.actionTaken}</span>{record.action_taken}</p>}
          {record.final_summary && <p className="mt-1 text-[13px] text-fg-2"><span className="text-muted">{tm.finalSummary}</span>{record.final_summary}</p>}
          {canWrite && record.handoff_state === "ready_for_custody" && (
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              disabled={evidenceBusy}
              onClick={async () => {
                setEvidenceBusy(true);
                const error = await confirmMaintenanceHandoff(record.id);
                setEvidenceBusy(false);
                onDone(error
                  ? { type: "error", message: friendlyErrorStrict(error, lang) }
                  : { type: "success", message: tm.handoffConfirmed });
              }}
            >
              {tm.confirmHandoff}
            </Button>
          )}
          <div className="mt-4 space-y-2">
            {/* جهة الصيانة الخارجية / المحل */}
            {hasVendorInfo && (
              <details className={detailsBox}>
                <summary className={summaryClass}><Store aria-hidden="true" className="h-4 w-4 text-muted" />{tv.section}</summary>
                <div className="border-t border-line p-4">
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-[13.5px] sm:grid-cols-2">
                    <Cell label={tv.name} value={vendorDisplay} />
                    <Cell label={tv.phone} value={record.vendor_phone} mono />
                    <Cell label={tv.location} value={record.vendor_location} />
                    {canSeeMaintenanceCost && <Cell label={tv.invoiceDate} value={record.invoice_date ? formatDate(record.invoice_date, lang) : null} />}
                    <Cell label={tv.receiverName} value={record.receiver_name} />
                  </dl>
                  {mapHref && (
                    <a href={mapHref} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-brand-ink hover:text-brand-hover">
                      <MapPin aria-hidden="true" className="h-3.5 w-3.5" />{tv.openMap}
                    </a>
                  )}
                  {record.handoff_notes && <p className="mt-2 text-[13px] text-fg-2"><span className="text-muted">{tv.handoffNotes}: </span>{record.handoff_notes}</p>}
                </div>
              </details>
            )}
            {/* المرفقات / الصور / الفاتورة */}
            <details className={detailsBox}>
              <summary className={summaryClass}><Paperclip aria-hidden="true" className="h-4 w-4 text-muted" />{tv.photosTitle} · <span className="tabular-nums">{visibleAttachments.length}</span></summary>
              <div className="border-t border-line p-4">
                {visibleAttachments.length === 0 ? (
                  <p className="text-[13px] text-muted">{tm.noAttachments}</p>
                ) : (
                  <ul className="space-y-2">
                    {visibleAttachments.map((a: any) => (
                      <li key={a.id} className="flex flex-wrap items-center gap-2 text-[13px] text-fg-2">
                        <Paperclip aria-hidden="true" className="h-3.5 w-3.5 text-muted" />
                        <button
                          type="button"
                          onClick={() => openAttachment(a.storage_path, a.file_name)}
                          disabled={a.scan_status !== "clean"}
                          className="font-medium text-brand-ink hover:text-brand-hover disabled:cursor-not-allowed disabled:text-warn"
                        >
                          {a.file_name}
                        </button>
                        {a.scan_status !== "clean" && (
                          <StatusChip tone="warn" size="sm">
                            {t.assetDetail.docs.scan[a.scan_status as "pending" | "infected" | "error"]}
                          </StatusChip>
                        )}
                        <StatusChip tone="neu" dot={false} size="sm">{kindLabel(a.kind ?? null)}</StatusChip>
                        <span className="tabular-nums text-muted">· {formatDate(a.created_at, lang)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          </div>
          {extras?.lastMod?.by && (
            <p className="mt-3 text-xs text-muted">{tm.lastModBy} {extras.lastMod.by} · <span className="tabular-nums">{formatDateTime(extras.lastMod.at, lang)}</span></p>
          )}
        </section>

        {/* نموذج تحديث الصيانة */}
        {canWrite ? (
          <section className="rounded-2xl border border-line bg-surface-2 p-4 sm:p-5">
            <h4 className={sectionTitle}><Wrench aria-hidden="true" className="h-4 w-4" />{tm.updateTitle}</h4>
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={tm.form.problemType}><Select value={f.ptype} onChange={set("ptype")} options={optWith(probOpts, f.ptype, tLabel(t.problemType, f.ptype)).map(([v, l]) => ({ value: v, label: l }))} /></Field>
                <Field label={tm.form.priority}><Select value={f.priority} onChange={set("priority")} options={optWith(prioOpts, f.priority, tLabel(t.priority, f.priority)).map(([v, l]) => ({ value: v, label: l }))} /></Field>
                <Field label={tm.form.stage}><Select value={f.stage} onChange={set("stage")} options={optWith(stageOpts, f.stage, tLabel(t.stage, f.stage)).map(([v, l]) => ({ value: v, label: l }))} /></Field>
                <Field label={tm.form.type}><Select value={f.type} onChange={set("type")} options={optWith(typeOpts, f.type, tLabel(t.mtype, f.type)).map(([v, l]) => ({ value: v, label: l }))} /></Field>
              </div>
              <Field label={tm.form.problem} required error={err}><textarea className={`${inputClass} resize-none`} rows={2} value={f.problem} onChange={(e) => set("problem")(e.target.value)} /></Field>
              <Field label={tm.form.action}><textarea className={`${inputClass} resize-none`} rows={2} value={f.action} onChange={(e) => set("action")(e.target.value)} /></Field>
              <Field label={tm.form.followNote}><textarea className={`${inputClass} resize-none`} rows={2} value={f.followNote} onChange={(e) => set("followNote")(e.target.value)} placeholder={tm.form.followNotePlaceholder} /></Field>
              <details open={["completed", "unrepairable", "awaiting_parts", "at_vendor"].includes(f.stage) || undefined} className={detailsBox}>
                <summary className={summaryClass}>{tm.sections.diagnostics}</summary>
                <div className="border-t border-line p-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label={tm.advanced.diagnosis}><textarea className={`${inputClass} resize-none`} rows={2} value={f.diagnosis} onChange={(e) => set("diagnosis")(e.target.value)} /></Field>
                    <Field label={tm.advanced.waitingReason}>
                      <textarea className={`${inputClass} resize-none`} rows={2} value={f.waitingReason} onChange={(e) => set("waitingReason")(e.target.value)} />
                    </Field>
                    <Field label={tm.advanced.causeCode}><input className={inputClass} value={f.causeCode} onChange={(e) => set("causeCode")(e.target.value)} /></Field>
                    <Field label={tm.advanced.resolutionCode}><input className={inputClass} value={f.resolutionCode} onChange={(e) => set("resolutionCode")(e.target.value)} /></Field>
                    <Field label={tm.advanced.laborMinutes}>
                      <input className={inputClass} type="number" min={0} max={100000} value={f.laborMinutes} onChange={(e) => set("laborMinutes")(e.target.value)} dir="ltr" />
                    </Field>
                    <Field label={tm.advanced.functionalNotes}>
                      <textarea className={`${inputClass} resize-none`} rows={2} value={f.functionalNotes} onChange={(e) => set("functionalNotes")(e.target.value)} />
                    </Field>
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-2 text-[13.5px] text-fg sm:grid-cols-2">
                    {[
                      ["safetyChecked", tm.advanced.safetyChecked],
                      ["functionChecked", tm.advanced.functionChecked],
                      ["dataChecked", tm.advanced.dataChecked],
                      ["functionalPassed", tm.advanced.functionalPassed],
                    ].map(([key, label]) => (
                      <label key={key} className="flex min-h-10 items-center gap-2.5 rounded-control border border-line px-3">
                        <input
                          type="checkbox"
                          className={checkboxClass}
                          checked={Boolean(f[key])}
                          onChange={(e) => setF((current: any) => ({ ...current, [key]: e.target.checked }))}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
              </details>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {canSeeMaintenanceCost && <Field label={tm.form.cost}><input className={inputClass} value={f.cost} onChange={(e) => set("cost")(e.target.value)} dir="ltr" inputMode="decimal" placeholder="0" /></Field>}
                {canSeeMaintenanceCost && <Field label={tm.form.invoice}><input className={inputClass} value={f.invoice} onChange={(e) => set("invoice")(e.target.value)} dir="ltr" /></Field>}
                <Field label={tm.form.nextDue} hint={t.common.dateHint}><input type="date" className={inputClass} value={f.next} onChange={(e) => set("next")(e.target.value)} dir="ltr" /></Field>
              </div>
              <Field label={tm.form.summary}><textarea className={`${inputClass} resize-none`} rows={2} value={f.summary} onChange={(e) => set("summary")(e.target.value)} /></Field>

              {/* جهة الصيانة الخارجية / المحل */}
              <details open={f.stage === "at_vendor" || undefined} className={detailsBox}>
                <summary className={summaryClass}><Store aria-hidden="true" className="h-4 w-4 text-muted" />{tm.sections.optionalVendor}</summary>
                <div className="space-y-3 border-t border-line p-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label={tv.supplier}>
                      <Select value={f.vendorSupplierId} onChange={set("vendorSupplierId")} placeholder={tv.supplierNone}
                        options={suppliers.map((s) => ({ value: s.id, label: s.name_ar ?? s.name }))} />
                    </Field>
                    <Field label={tv.name}><input className={inputClass} value={f.vendorName} onChange={(e) => set("vendorName")(e.target.value)} /></Field>
                    <Field label={tv.phone}><input className={inputClass} value={f.vendorPhone} onChange={(e) => set("vendorPhone")(e.target.value)} dir="ltr" inputMode="tel" /></Field>
                    <Field label={tv.location}><input className={inputClass} value={f.vendorLocation} onChange={(e) => set("vendorLocation")(e.target.value)} /></Field>
                    <Field label={tv.mapLink}><input className={inputClass} value={f.vendorMapLink} onChange={(e) => set("vendorMapLink")(e.target.value)} dir="ltr" placeholder="https://maps.google.com/…" /></Field>
                    {canSeeMaintenanceCost && <Field label={tv.invoiceDate} hint={t.common.dateHint}><input type="date" className={inputClass} value={f.invoiceDate} onChange={(e) => set("invoiceDate")(e.target.value)} dir="ltr" /></Field>}
                    <Field label={tv.receiverName}><input className={inputClass} value={f.receiverName} onChange={(e) => set("receiverName")(e.target.value)} /></Field>
                  </div>
                  <Field label={tv.handoffNotes}><textarea className={`${inputClass} resize-none`} rows={2} value={f.handoffNotes} onChange={(e) => set("handoffNotes")(e.target.value)} /></Field>
                </div>
              </details>

              <details className={detailsBox}>
                <summary className={summaryClass}>{tm.sections.timeAndParts}</summary>
                <div className="grid grid-cols-1 gap-3 border-t border-line p-4 sm:grid-cols-2">
                  <div className="rounded-xl border border-line p-3">
                    <p className="mb-3 text-[13px] font-semibold text-fg-2">{tm.advanced.timeTracking}</p>
                    <div className="space-y-2">
                      <Field label={tm.advanced.start}><input type="datetime-local" className={inputClass} value={timeForm.startedAt} onChange={(e) => setTimeForm((x) => ({ ...x, startedAt: e.target.value }))} dir="ltr" /></Field>
                      <Field label={tm.advanced.end}><input type="datetime-local" className={inputClass} value={timeForm.endedAt} onChange={(e) => setTimeForm((x) => ({ ...x, endedAt: e.target.value }))} dir="ltr" /></Field>
                      <Field label={tm.advanced.note}><input className={inputClass} value={timeForm.note} onChange={(e) => setTimeForm((x) => ({ ...x, note: e.target.value }))} /></Field>
                      <Button size="sm" variant="outline" type="button" disabled={evidenceBusy || !timeForm.startedAt || !timeForm.endedAt} onClick={addTime}>{tm.advanced.addTime}</Button>
                    </div>
                    <ul className="mt-3 space-y-1 text-xs text-muted">
                      {(extras?.timeEntries ?? []).map((entry: any) => (
                        <li key={entry.id}><span className="tabular-nums">{entry.minutes}</span> {tm.advanced.minutes} · <span className="tabular-nums">{formatDateTime(entry.started_at, lang)}</span>{entry.note ? ` · ${entry.note}` : ""}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="rounded-xl border border-line p-3">
                    <p className="mb-3 text-[13px] font-semibold text-fg-2">{tm.advanced.plannedParts}</p>
                    <div className="space-y-2">
                      <Field label={tm.advanced.registeredConsumable}>
                        <Select value={partForm.consumableId} onChange={(value) => setPartForm((x) => ({ ...x, consumableId: value }))} placeholder={tm.advanced.freeDescription}
                          options={consumables.map((item) => ({ value: item.id, label: `${item.name} (${item.unit})` }))} />
                      </Field>
                      <Field label={tm.advanced.description}><input className={inputClass} value={partForm.description} onChange={(e) => setPartForm((x) => ({ ...x, description: e.target.value }))} /></Field>
                      <Field label={tm.advanced.plannedQuantity}><input type="number" min={0.01} step="any" className={inputClass} value={partForm.quantity} onChange={(e) => setPartForm((x) => ({ ...x, quantity: e.target.value }))} dir="ltr" /></Field>
                      <Button size="sm" variant="outline" type="button" disabled={evidenceBusy || (!partForm.consumableId && !partForm.description.trim())} onClick={addPart}>{tm.advanced.addPart}</Button>
                    </div>
                    <ul className="mt-3 space-y-1 text-xs text-muted">
                      {(extras?.parts ?? []).map((part: any) => (
                        <li key={part.id}>{part.consumable?.name ?? part.description ?? "—"} · <span className="tabular-nums">{part.used_quantity}/{part.planned_quantity}</span></li>
                      ))}
                    </ul>
                    <p className="mt-2 text-xs font-medium text-warn">{tm.advanced.planningOnly}</p>
                  </div>
                </div>
              </details>

              {/* رفع صورة الجهاز / الفاتورة / مرفقات */}
              <details className={detailsBox}>
                <summary className={summaryClass}>{tm.sections.uploadEvidence}</summary>
                <div className="border-t border-line p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className={fileLabelClass}>
                      <Camera aria-hidden="true" className="h-4 w-4" /> {upBusy ? tm.form.uploading : tv.uploadDevicePhoto}
                      <input type="file" accept="image/*" className="sr-only" onChange={(e) => uploadFile(e, "device_photo")} disabled={upBusy} />
                    </label>
                    {canSeeMaintenanceCost && (
                      <label className={fileLabelClass}>
                        <Upload aria-hidden="true" className="h-4 w-4" /> {upBusy ? tm.form.uploading : tv.uploadOther}
                        <input type="file" className="sr-only" onChange={(e) => uploadFile(e, "invoice")} disabled={upBusy} />
                      </label>
                    )}
                  </div>
                  {upMsg && <p role="status" className="mt-2 text-xs text-muted">{upMsg}</p>}
                </div>
              </details>
            </div>
          </section>
        ) : (
          <p className="rounded-xl bg-sunk px-3 py-2.5 text-center text-[13px] text-fg-2">{tm.viewOnly}</p>
        )}
      </div>
    </Drawer>
  );
}

function Cell({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-0.5 break-words text-fg ${mono ? "tag" : ""}`}>{value || "—"}</dd>
    </div>
  );
}

function HistStat({ icon: Icon, label, value, loading, small }: { icon: any; label: string; value: React.ReactNode; loading?: boolean; small?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2 p-3 text-center">
      <Icon aria-hidden="true" className="mx-auto h-4 w-4 text-muted" />
      <p className={`mt-1 font-display font-semibold tabular-nums text-fg ${small ? "text-[13px]" : "text-lg"}`}>{loading ? "…" : value}</p>
      <p className="mt-0.5 text-[11.5px] text-muted">{label}</p>
    </div>
  );
}
