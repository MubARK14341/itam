"use client";

import { useEffect, useMemo, useState } from "react";
import { Info, Save } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Select, inputClass } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import { getFormOptions } from "@/lib/queries";
import {
  getInventorySettings, updateInventorySettings,
  DEFAULT_INVENTORY_SETTINGS, type InventorySettings,
} from "@/lib/inventory-settings";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { Callout, SectionLoading, UnsavedChangesBar, differs } from "@/components/settings/settings-ui";

// تبويب «المخزون» — القيم الافتراضية للمخزون على مستوى النظام. admin/it_manager فقط
// (وصول الإعدادات + RLS). تُخزَّن في inventory_settings وتُستخدم كقيم أولية عند إنشاء
// عناصر جديدة (أصل/مستهلك) — لا تُغيّر أي بيانات موجودة.
export function InventorySettings() {
  const { t } = useAppPreferences();
  const ti = t.settings.inventory;
  const [s, setS] = useState<InventorySettings>(DEFAULT_INVENTORY_SETTINGS);
  // لقطة القيم المحمّلة/المحفوظة — لإظهار شريط «تغييرات غير محفوظة» فقط (واجهة).
  const [loaded, setLoaded] = useState<InventorySettings>(DEFAULT_INVENTORY_SETTINGS);
  const [locations, setLocations] = useState<{ id: string; name: string; name_ar?: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  useEffect(() => {
    Promise.all([getInventorySettings(), getFormOptions()]).then(([settings, opts]) => {
      setS(settings);
      setLoaded(settings);
      setLocations((opts?.locations ?? []) as { id: string; name: string; name_ar?: string | null }[]);
      setLoading(false);
    });
  }, []);

  const locationOptions = useMemo(
    () => locations.map((l) => ({ value: l.id, label: l.name_ar ?? l.name })),
    [locations],
  );

  async function save() {
    setBusy(true);
    const err = await updateInventorySettings(s);
    setBusy(false);
    if (!err) setLoaded(s);
    setToast(err ? { type: "error", message: ti.error + err } : { type: "success", message: ti.saved });
  }

  if (loading) return <SectionLoading />;

  return (
    <div>
      <Card>
        <CardHeader
          title={ti.section}
          description={t.settings.subtitle}
          actions={<Button onClick={save} disabled={busy}><Save aria-hidden="true" />{busy ? ti.saving : ti.save}</Button>}
        />
        <div className="space-y-5 px-5 py-5">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field label={ti.defaultWarehouse} hint={ti.defaultWarehouseHint}>
              <Select value={s.default_location_id ?? ""} placeholder={ti.chooseWarehouse} options={locationOptions}
                onChange={(v) => setS((p) => ({ ...p, default_location_id: v || null }))} />
            </Field>
            <Field label={ti.defaultReorder} hint={ti.defaultReorderHint}>
              <input className={`${inputClass} tabular-nums`} dir="ltr" inputMode="numeric" placeholder="0"
                value={s.default_reorder_level ? String(s.default_reorder_level) : ""}
                onChange={(e) => setS((p) => ({ ...p, default_reorder_level: Math.max(0, Math.trunc(Number(e.target.value) || 0)) }))} />
            </Field>
          </div>
          <Callout tone="info" icon={Info}>{ti.note}</Callout>
        </div>
      </Card>
      <UnsavedChangesBar
        show={differs(s, loaded)}
        onDiscard={() => setS(loaded)}
        onSave={save}
        busy={busy}
        saveLabel={busy ? ti.saving : ti.save}
      />
      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}
