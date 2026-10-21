"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Save, PackageOpen } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button, buttonClass } from "@/components/ui/button";
import { Field, Select, inputClass } from "@/components/ui/form";
import { FileInput } from "@/components/ui/file-input";
import type { ToastState } from "@/components/ui/toast";
import { createConsumableFull, uploadConsumableAttachment, type ConsumableInput } from "@/lib/queries";
import { type InventorySettings } from "@/lib/inventory-settings";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { parseStrictDecimal, parseStrictInteger } from "@/lib/numeric-validation";

const UNIT_KEYS = ["piece", "box", "ream", "set"] as const;

/**
 * نموذج إنشاء مستهلك من داخل تجربة «إضافة عنصر» (toggle = مستهلك).
 * يُحفظ في جدول consumables (سلوك مخزون) — لا Serial، لا عهدة، لا إرجاع.
 */
export function ConsumableNewForm({ opts, fin, write, setToast, defaults }: {
  opts: any; fin: boolean; write: boolean; setToast: (t: ToastState) => void; defaults?: InventorySettings | null;
}) {
  const router = useRouter();
  const { t } = useAppPreferences();
  const cf = t.consumables.form;
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  const [photo, setPhoto] = useState<File | null>(null);
  // قيم أولية من إعدادات المخزون: حد إعادة الطلب + الموقع الافتراضيان (لا يُطبَّق موقع غير موجود ضمن القائمة).
  const [f, setF] = useState(() => {
    const loc = defaults?.default_location_id;
    const locOk = !!loc && (opts?.locations ?? []).some((l: any) => l.id === loc);
    return {
      category_id: "", name: "", brand: "", sku: "", rfid_tag: "", unit: "piece",
      quantity_on_hand: "",
      reorder_level: defaults?.default_reorder_level ? String(defaults.default_reorder_level) : "",
      unit_cost: "",
      company_id: "", supplier_id: "", location_id: locOk ? loc! : "", notes: "",
    };
  });
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  // التصنيفات غير الأصول (مستهلك/ملحق/خاص) مناسبة للمستهلكات
  const cats = useMemo(() => (opts?.categories ?? []).filter((c: any) => c.kind !== "asset"), [opts]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const er: Record<string, string> = {};
    const quantity = parseStrictInteger(f.quantity_on_hand, { emptyValue: 0 });
    const reorderLevel = parseStrictInteger(f.reorder_level, { emptyValue: 0 });
    const unitCost = parseStrictDecimal(f.unit_cost);
    if (!f.category_id) er.category_id = cf.errCategory;
    if (!f.name.trim()) er.name = cf.errName;
    if (!quantity.ok) er.quantity_on_hand = cf.errInvalidNumber;
    if (!reorderLevel.ok) er.reorder_level = cf.errInvalidNumber;
    if (!unitCost.ok) er.unit_cost = cf.errInvalidNumber;
    setErr(er); if (Object.keys(er).length) return;
    if (!quantity.ok || !reorderLevel.ok || !unitCost.ok) return;
    setSaving(true);
    const input: ConsumableInput = {
      category_id: f.category_id, name: f.name, sku: f.sku || null, brand: f.brand || null,
      unit: f.unit, reorder_level: reorderLevel.value ?? 0, quantity_on_hand: quantity.value ?? 0,
      company_id: f.company_id || null, supplier_id: f.supplier_id || null, location_id: f.location_id || null,
      unit_cost: unitCost.value, rfid_tag: f.rfid_tag || null, notes: f.notes || null,
    };
    const { error, id } = await createConsumableFull(input);
    if (error || !id) { setSaving(false); setToast({ type: "error", message: cf.errName + " " + (error ?? "") }); return; }
    if (photo) await uploadConsumableAttachment(id, photo, "consumable_photo");
    setSaving(false);
    setToast({ type: "success", message: cf.added });
    setTimeout(() => router.push(`/consumables/${id}`), 600);
  }

  const o = (arr: any[]) => arr.map((x: any) => ({ value: x.id, label: x.name_ar ?? x.name }));

  return (
    <form onSubmit={submit}>
      <Card className="p-5 sm:p-7">
        <div className="mb-5 flex items-center gap-2 text-sm font-semibold text-brand-ink">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand-soft">
            <PackageOpen aria-hidden="true" className="h-4 w-4" />
          </span>
          {t.consumables.badge}
        </div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
          <Field label={cf.category} required error={err.category_id}>
            <Select value={f.category_id} onChange={set("category_id")} placeholder={cf.choose} options={o(cats)} />
          </Field>
          <Field label={cf.name} required error={err.name}>
            <input className={inputClass} value={f.name} onChange={(e) => set("name")(e.target.value)} />
          </Field>
          <Field label={cf.company}>
            <Select value={f.company_id} onChange={set("company_id")} placeholder={cf.chooseCompany}
              options={(opts?.companies ?? []).map((c: any) => ({ value: c.id, label: c.name }))} />
          </Field>
          <Field label={cf.supplier}>
            <Select value={f.supplier_id} onChange={set("supplier_id")} placeholder={cf.chooseSupplier} options={o(opts?.suppliers ?? [])} />
          </Field>
          <Field label={cf.location}>
            <Select value={f.location_id} onChange={set("location_id")} placeholder={cf.chooseLocation} options={o(opts?.locations ?? [])} />
          </Field>
          <Field label={cf.unit}>
            <Select value={f.unit} onChange={set("unit")} options={UNIT_KEYS.map((v) => ({ value: v, label: cf.units[v] }))} />
          </Field>
          <Field label={cf.quantity} error={err.quantity_on_hand}>
            <input className={inputClass} value={f.quantity_on_hand} onChange={(e) => set("quantity_on_hand")(e.target.value)} dir="ltr" inputMode="numeric" />
          </Field>
          <Field label={cf.reorder} error={err.reorder_level}>
            <input className={inputClass} value={f.reorder_level} onChange={(e) => set("reorder_level")(e.target.value)} dir="ltr" inputMode="numeric" />
          </Field>
          {fin && (
            <Field label={cf.unitCost} error={err.unit_cost}>
              <input className={inputClass} value={f.unit_cost} onChange={(e) => set("unit_cost")(e.target.value)} dir="ltr" inputMode="decimal" placeholder="0.00" />
            </Field>
          )}
          <Field label={cf.sku}>
            <input className={inputClass} value={f.sku} onChange={(e) => set("sku")(e.target.value)} dir="ltr" />
          </Field>
          <Field label={cf.rfid}>
            <input className={inputClass} value={f.rfid_tag} onChange={(e) => set("rfid_tag")(e.target.value)} dir="ltr" />
          </Field>
          <Field label={cf.brand}>
            <input className={inputClass} value={f.brand} onChange={(e) => set("brand")(e.target.value)} />
          </Field>
          <div className="md:col-span-2">
            <Field label={cf.photo}>
              <FileInput accept="image/*" file={photo} onPick={setPhoto} />
            </Field>
          </div>
          <div className="md:col-span-2">
            <Field label={cf.notes}>
              <textarea className={`${inputClass} resize-none`} rows={2} value={f.notes} onChange={(e) => set("notes")(e.target.value)} />
            </Field>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-2 border-t border-line pt-5">
          <Link href="/assets" className={buttonClass("outline", "md")}>{t.common.cancel}</Link>
          <Button type="submit" disabled={saving || !write}><Save aria-hidden="true" className="h-4 w-4" />{saving ? cf.added : t.assetForm.saveConsumable}</Button>
        </div>
      </Card>
    </form>
  );
}
