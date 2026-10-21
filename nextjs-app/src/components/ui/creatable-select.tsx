"use client";

import { useMemo, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/form";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";

const ADD = "__add_new__";

export type CreateField = {
  key: string; label: string; placeholder?: string; dir?: "rtl" | "ltr"; required?: boolean;
};

// قائمة منسدلة عادية + خيار «إضافة جديد» يفتح نافذة صغيرة لإدخال الاسم وحفظه ثم اختياره تلقائيًا.
// canCreate يتحكم بظهور خيار الإضافة (يُخفى عن Viewer). يحتفظ بالخيارات المُضافة محليًا حتى تظهر فورًا.
export function CreatableSelect({
  value, onChange, options, placeholder, disabled,
  canCreate, addLabel, dialogTitle, fields, onCreate, ...accessibilityProps
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  canCreate?: boolean;
  addLabel: string;
  dialogTitle: string;
  fields: CreateField[];
  onCreate: (vals: Record<string, string>) => Promise<{ value: string; label: string; error: string | null }>;
  "aria-describedby"?: string; "aria-invalid"?: boolean;
}) {
  const { t } = useAppPreferences();
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [extra, setExtra] = useState<{ value: string; label: string }[]>([]);

  const merged = useMemo(() => {
    const seen = new Set(options.map((o) => o.value));
    return [...options, ...extra.filter((e) => !seen.has(e.value))];
  }, [options, extra]);

  function handleChange(v: string) {
    if (v === ADD) { setVals({}); setErr(""); setOpen(true); return; }
    onChange(v);
  }

  async function submit() {
    for (const f of fields) {
      if (f.required && !(vals[f.key] ?? "").trim()) { setErr(`${f.label} ${t.common.required}`); return; }
    }
    setBusy(true);
    const res = await onCreate(vals);
    setBusy(false);
    if (res.error) { setErr(res.error); return; }
    setExtra((s) => [...s, { value: res.value, label: res.label }]);
    onChange(res.value); // اختيار القيمة الجديدة تلقائيًا
    setOpen(false);
  }

  return (
    <>
      <select value={value} disabled={disabled} onChange={(e) => handleChange(e.target.value)} className={inputClass} {...accessibilityProps}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {merged.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        {canCreate && !disabled && <option value={ADD}>+ {addLabel}</option>}
      </select>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={dialogTitle}
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)} type="button">{t.common.cancel}</Button>
            <Button onClick={submit} disabled={busy} type="button">{busy ? t.common.saving : t.common.save}</Button>
          </>
        }
      >
        <div className="space-y-3">
          {fields.map((f) => (
            <Field key={f.key} label={f.label} required={f.required}>
              <input
                className={inputClass}
                dir={f.dir ?? "rtl"}
                placeholder={f.placeholder}
                value={vals[f.key] ?? ""}
                onChange={(e) => setVals((s) => ({ ...s, [f.key]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
              />
            </Field>
          ))}
          {err && <p role="alert" className="text-xs font-medium text-bad">{err}</p>}
        </div>
      </Dialog>
    </>
  );
}
