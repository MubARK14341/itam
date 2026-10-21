"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Select, inputClass } from "@/components/ui/form";
import { FileInput } from "@/components/ui/file-input";
import type { ToastState } from "@/components/ui/toast";
import type { SaveFeedback } from "@/lib/save-feedback";
import {
  replenishConsumable, issueConsumable, updateConsumable, uploadConsumableAttachment,
} from "@/lib/queries";
import type { Dict } from "@/lib/i18n";
import { parseStrictDecimal, parseStrictInteger } from "@/lib/numeric-validation";
import { idempotentOperationError } from "@/lib/idempotent-operation-error";
import { reportOperationalFailure } from "@/lib/observability";

const UNIT_KEYS = ["piece", "box", "ream", "set"] as const;

// معاينة «الرصيد بعد العملية» — عرض فقط، محسوب من الكمية المدخلة؛ الـRPC الذرّي هو الحكم.
function BalanceAfter({ t, current, after, reorder, unit }: {
  t: Dict; current: number; after: number | null; reorder: number; unit: string;
}) {
  const tone = after == null ? "text-fg-2" : after <= 0 ? "text-bad" : after <= reorder ? "text-warn" : "text-ok";
  const unitLabel = (t.consumables.form.units as Record<string, string>)[unit] ?? unit;
  return (
    <div className="flex items-center gap-3 rounded-card border border-line bg-surface-2 px-3.5 py-3">
      <span className="text-[13px] text-muted">{t.consumables.ledgerUx.balanceAfter}</span>
      <div className="flex-1" />
      <span className="text-[15px] tabular-nums text-fg-2">{current}</span>
      <ArrowLeft aria-hidden="true" className="h-4 w-4 text-muted ltr:rotate-180" />
      <span className={`font-display text-xl font-semibold tabular-nums ${tone}`}>{after ?? "—"}</span>
      <span className="text-xs text-muted">{unitLabel}</span>
    </div>
  );
}

// ---------------- توريد (Replenishment) — سعر/مورد/فاتورة لكل عملية ----------------
export function ReplenishDialog({ item, suppliers, fin, t, onClose, onDone }: {
  item: any | null; suppliers: any[]; fin: boolean; t: Dict;
  onClose: () => void; onDone: (m: SaveFeedback) => void;
}) {
  const tr = t.consumables.replenish;
  const [f, setF] = useState({ quantity: "", unitCost: "", supplier_id: "", invoice_number: "", invoice_date: "", notes: "" });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const inFlight = useRef(false);
  const operationId = useRef<string | null>(null);
  useEffect(() => {
    if (!item) return;
    setF({ quantity: "", unitCost: "", supplier_id: item.supplier_id ?? "", invoice_number: "", invoice_date: "", notes: "" });
    setFile(null); setErr("");
    operationId.current = null;
  }, [item]);
  if (!item) return null;
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const totalQuantity = parseStrictInteger(f.quantity, { required: true, min: 1 });
  const totalUnitCost = parseStrictDecimal(f.unitCost, { required: true });
  const total = totalQuantity.ok && totalUnitCost.ok
    ? (totalQuantity.value ?? 0) * (totalUnitCost.value ?? 0)
    : null;

  async function submit() {
    if (inFlight.current) return;
    const quantity = parseStrictInteger(f.quantity, { required: true, min: 1 });
    const unitCost = parseStrictDecimal(f.unitCost);
    if (!quantity.ok || !unitCost.ok) { setErr(tr.invalidQty); return; }
    const qty = quantity.value as number;
    inFlight.current = true;
    setBusy(true);
    operationId.current ??= crypto.randomUUID();
    try {
      const e = await replenishConsumable({
        consumableId: item.id, current: item.quantity_on_hand, quantity: qty,
        operationId: operationId.current,
        unitCost: fin ? unitCost.value : null,
        supplierId: f.supplier_id || null,
        invoiceNumber: fin ? (f.invoice_number.trim() || null) : null,
        invoiceDate: fin ? (f.invoice_date || null) : null,
        notes: f.notes.trim() || null,
      });
      if (e && e !== "operation_previous_completed") {
        onDone({ type: "error", message: idempotentOperationError(e, t.common) ? e : tr.error + e, persisted: false });
        return;
      }
      operationId.current = null;
      if (e === "operation_previous_completed") {
        onDone({ type: "success", message: t.common.operationPreviousCompleted, persisted: true });
        return;
      }
      // Stock is committed. An invoice upload failure must never replay it.
      let upErr: string | null = null;
      if (fin && file) {
        try { upErr = await uploadConsumableAttachment(item.id, file, "replenishment_invoice"); }
        catch (error) {
          reportOperationalFailure("replenishment_invoice_upload_failed", error);
          upErr = t.common.attachmentUploadFailed;
        }
      }
      onDone(upErr
        ? { type: "error", message: tr.uploadWarn + upErr, persisted: true }
        : { type: "success", message: tr.saved, persisted: true });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const close = () => { if (!inFlight.current) onClose(); };

  return (
    <Dialog open={!!item} onClose={close} size="2xl" title={`${tr.title} — ${item.name}`}
      footer={<><Button variant="outline" onClick={close} disabled={busy}>{t.common.cancel}</Button><Button onClick={submit} disabled={busy}>{busy ? t.common.saving : tr.save}</Button></>}>
      <fieldset disabled={busy} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={tr.quantity} required error={err}><input className={inputClass} value={f.quantity} onChange={(e) => set("quantity")(e.target.value)} dir="ltr" inputMode="numeric" /></Field>
          {fin && <Field label={tr.unitCost}><input className={inputClass} value={f.unitCost} onChange={(e) => set("unitCost")(e.target.value)} dir="ltr" inputMode="decimal" placeholder="0.00" /></Field>}
          <Field label={tr.supplier}><Select value={f.supplier_id} onChange={set("supplier_id")} placeholder={tr.chooseSupplier} options={(suppliers ?? []).map((s) => ({ value: s.id, label: s.name_ar ?? s.name }))} /></Field>
          {fin && total != null && <Field label={tr.totalCost}><input className={inputClass} value={String(total)} dir="ltr" readOnly /></Field>}
          {fin && <Field label={tr.invoiceNumber}><input className={inputClass} value={f.invoice_number} onChange={(e) => set("invoice_number")(e.target.value)} dir="ltr" /></Field>}
          {fin && <Field label={tr.invoiceDate} hint={t.common.dateHint}><input type="date" className={inputClass} value={f.invoice_date} onChange={(e) => set("invoice_date")(e.target.value)} dir="ltr" /></Field>}
        </div>
        <BalanceAfter t={t} current={Number(item.quantity_on_hand)} reorder={Number(item.reorder_level)} unit={item.unit}
          after={totalQuantity.ok && totalQuantity.value != null ? Number(item.quantity_on_hand) + totalQuantity.value : null} />
        {fin && (
          <Field label={tr.attachment}>
            <FileInput accept="image/*,application/pdf" file={file} onPick={setFile} />
          </Field>
        )}
        <Field label={tr.notes}><input className={inputClass} value={f.notes} onChange={(e) => set("notes")(e.target.value)} /></Field>
      </fieldset>
    </Dialog>
  );
}

// ---------------- صرف (Issue) — ينقص الكمية فقط، بلا عهدة/إرجاع ----------------
export function IssueDialog({ item, employees, departments, t, onClose, onDone }: {
  item: any | null; employees: any[]; departments: any[]; t: Dict;
  onClose: () => void; onDone: (m: ToastState) => void;
}) {
  const ti = t.consumables.issueForm;
  const [f, setF] = useState({ quantity: "", employee_id: "", department_id: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const inFlight = useRef(false);
  const operationId = useRef<string | null>(null);
  useEffect(() => { if (item) { setF({ quantity: "", employee_id: "", department_id: "", reason: "" }); setErr(""); operationId.current = null; } }, [item]);
  if (!item) return null;
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const issueQuantity = parseStrictInteger(f.quantity, { required: true, min: 1 });

  async function submit() {
    if (inFlight.current) return;
    const quantity = parseStrictInteger(f.quantity, { required: true, min: 1 });
    if (!quantity.ok) { setErr(t.consumables.replenish.invalidQty); return; }
    const qty = quantity.value as number;
    // The DB validates the balance. A refreshed balance must not prevent
    // acknowledging a previously committed operation whose response was lost.
    inFlight.current = true;
    setBusy(true);
    operationId.current ??= crypto.randomUUID();
    try {
      const e = await issueConsumable({
        consumableId: item.id, current: item.quantity_on_hand, quantity: qty, operationId: operationId.current,
        employeeId: f.employee_id || null, departmentId: f.department_id || null, reason: f.reason.trim() || null,
      });
      if (!e || e === "operation_previous_completed") operationId.current = null;
      onDone(e && e !== "operation_previous_completed"
        ? { type: "error", message: idempotentOperationError(e, t.common) ? e : ti.error + e }
        : { type: "success", message: e ? t.common.operationPreviousCompleted : ti.saved });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const close = () => { if (!inFlight.current) onClose(); };

  return (
    <Dialog open={!!item} onClose={close} title={`${ti.title} — ${item.name}`}
      footer={<><Button variant="outline" onClick={close} disabled={busy}>{t.common.cancel}</Button><Button onClick={submit} disabled={busy}>{busy ? t.common.saving : ti.save}</Button></>}>
      <fieldset disabled={busy} className="space-y-4">
        <p className="rounded-card border border-line bg-surface-2 px-3.5 py-2.5 text-sm text-fg-2">{t.consumables.txn.currentStock}: <b className="font-semibold tabular-nums text-fg">{item.quantity_on_hand}</b> {(t.consumables.form.units as Record<string, string>)[item.unit] ?? item.unit}</p>
        <Field label={ti.quantity} required error={err}><input className={inputClass} value={f.quantity} onChange={(e) => set("quantity")(e.target.value)} dir="ltr" inputMode="numeric" /></Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={ti.employee}><Select value={f.employee_id} onChange={set("employee_id")} placeholder={ti.none} options={(employees ?? []).map((x) => ({ value: x.id, label: x.full_name_ar ?? x.full_name }))} /></Field>
          <Field label={ti.department}><Select value={f.department_id} onChange={set("department_id")} placeholder={ti.none} options={(departments ?? []).map((x) => ({ value: x.id, label: x.name_ar ?? x.name }))} /></Field>
        </div>
        <Field label={ti.reason}><input className={inputClass} value={f.reason} onChange={(e) => set("reason")(e.target.value)} /></Field>
        <BalanceAfter t={t} current={Number(item.quantity_on_hand)} reorder={Number(item.reorder_level)} unit={item.unit}
          after={issueQuantity.ok && issueQuantity.value != null ? Number(item.quantity_on_hand) - issueQuantity.value : null} />
      </fieldset>
    </Dialog>
  );
}

// ---------------- تعديل بيانات المستهلك (بروفايل كامل) ----------------
export function EditConsumableDialog({ item, cats, companies, suppliers, locations, t, onClose, onDone }: {
  item: any | null; cats: any[]; companies: any[]; suppliers: any[]; locations: any[]; t: Dict;
  onClose: () => void; onDone: (m: ToastState) => void;
}) {
  const cf = t.consumables.form;
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!item) { setF(null); return; }
    setF({
      category_id: item.category_id ?? "", name: item.name ?? "", sku: item.sku ?? "", brand: item.brand ?? "",
      unit: item.unit ?? "piece", company_id: item.company_id ?? "", supplier_id: item.supplier_id ?? "",
      location_id: item.location_id ?? "", rfid_tag: item.rfid_tag ?? "",
      reorder_level: String(item.reorder_level ?? 0), quantity_on_hand: String(item.quantity_on_hand ?? 0), notes: item.notes ?? "",
    });
    setErr({});
  }, [item]);
  if (!item || !f) return null;
  const set = (k: string) => (v: string) => setF((s: any) => ({ ...s, [k]: v }));

  async function submit() {
    const e: Record<string, string> = {};
    const reorderLevel = parseStrictInteger(f.reorder_level, { required: true });
    if (!f.name.trim()) e.name = cf.errName;
    if (!f.category_id) e.category_id = cf.errCategory;
    if (!reorderLevel.ok) e.reorder_level = cf.errInvalidNumber;
    setErr(e); if (Object.keys(e).length) return;
    if (!reorderLevel.ok) return;
    setBusy(true);
    const msg = await updateConsumable(item.id, {
      category_id: f.category_id, name: f.name.trim(), sku: f.sku.trim() || null, brand: f.brand.trim() || null,
      unit: f.unit, reorder_level: reorderLevel.value ?? 0, notes: f.notes.trim() || null,
      company_id: f.company_id || null,
      supplier_id: f.supplier_id || null, location_id: f.location_id || null, rfid_tag: f.rfid_tag.trim() || null,
    });
    setBusy(false);
    onDone(msg ? { type: "error", message: msg } : { type: "success", message: cf.updated });
  }

  const o = (arr: any[]) => arr.map((x: any) => ({ value: x.id, label: x.name_ar ?? x.name }));
  return (
    <Dialog open={!!item} onClose={onClose} size="2xl" title={`${cf.editPrefix}${item.name}`}
      footer={<><Button variant="outline" onClick={onClose}>{t.common.cancel}</Button><Button onClick={submit} disabled={busy}>{busy ? t.common.saving : t.common.save}</Button></>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={cf.category} required error={err.category_id}><Select value={f.category_id} onChange={set("category_id")} placeholder={cf.choose} options={o(cats)} /></Field>
        <Field label={cf.name} required error={err.name}><input className={inputClass} value={f.name} onChange={(e) => set("name")(e.target.value)} /></Field>
        <Field label={cf.company}><Select value={f.company_id} onChange={set("company_id")} placeholder={cf.chooseCompany} options={(companies ?? []).map((c) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label={cf.supplier}><Select value={f.supplier_id} onChange={set("supplier_id")} placeholder={cf.chooseSupplier} options={o(suppliers)} /></Field>
        <Field label={cf.location}><Select value={f.location_id} onChange={set("location_id")} placeholder={cf.chooseLocation} options={o(locations)} /></Field>
        <Field label={cf.unit}><Select value={f.unit} onChange={set("unit")} options={UNIT_KEYS.map((v) => ({ value: v, label: cf.units[v] }))} /></Field>
        <Field label={cf.qtyOnHand} hint={cf.qtyHint}><input className={inputClass} value={f.quantity_on_hand} readOnly aria-readonly="true" dir="ltr" inputMode="numeric" /></Field>
        <Field label={cf.reorderLevel} error={err.reorder_level}><input className={inputClass} value={f.reorder_level} onChange={(e) => set("reorder_level")(e.target.value)} dir="ltr" inputMode="numeric" /></Field>
        <Field label={cf.sku}><input className={inputClass} value={f.sku} onChange={(e) => set("sku")(e.target.value)} dir="ltr" /></Field>
        <Field label={cf.rfid}><input className={inputClass} value={f.rfid_tag} onChange={(e) => set("rfid_tag")(e.target.value)} dir="ltr" /></Field>
        <Field label={cf.brand}><input className={inputClass} value={f.brand} onChange={(e) => set("brand")(e.target.value)} /></Field>
        <div className="sm:col-span-2"><Field label={cf.notes}><textarea className={`${inputClass} resize-none`} rows={2} value={f.notes} onChange={(e) => set("notes")(e.target.value)} /></Field></div>
      </div>
    </Dialog>
  );
}
