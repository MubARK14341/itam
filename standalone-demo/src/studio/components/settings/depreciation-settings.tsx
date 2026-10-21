"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Power, TrendingDown, TriangleAlert } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusChip } from "@/components/ui/status-chip";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, inputClass } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import {
  listDepreciationRules, createDepreciationRule, updateDepreciationRule, setDepreciationRuleActive, getFormOptions,
  type DepreciationRuleRow, type DepreciationRuleInput,
} from "@/lib/queries";
import { ALL_TEMPLATE_IDS } from "@/lib/asset-type-templates";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { parseStrictDecimal, parseStrictInteger } from "@/lib/numeric-validation";
import { ActiveChip, TableMessage, checkboxClass } from "@/components/settings/settings-ui";

type Cat = { id: string; name: string; name_ar: string | null };
type Comp = { id: string; name: string };

export function DepreciationSettings() {
  const { t } = useAppPreferences();
  const td = t.depreciation;
  const [rows, setRows] = useState<DepreciationRuleRow[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [companies, setCompanies] = useState<Comp[]>([]);
  const [loading, setLoading] = useState(true);
  const [lifecycleAvailable, setLifecycleAvailable] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [editing, setEditing] = useState<DepreciationRuleRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  async function load() {
    const { rows, error, lifecycleAvailable } = await listDepreciationRules();
    if (error) setToast({ type: "error", message: td.error + error });
    setRows(rows); setLifecycleAvailable(lifecycleAvailable); setLoading(false);
  }
  useEffect(() => {
    load();
    getFormOptions().then((o) => {
      setCats((o.categories as Cat[]) ?? []);
      setCompanies((o.companies as Comp[]) ?? []);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const catLabel = useMemo(() => {
    const m = new Map<string, string>();
    cats.forEach((c) => m.set(c.id, c.name_ar ?? c.name));
    return m;
  }, [cats]);

  const compLabel = useMemo(() => {
    const m = new Map<string, string>();
    companies.forEach((c) => m.set(c.id, c.name));
    return m;
  }, [companies]);

  async function toggleActive(r: DepreciationRuleRow) {
    const e = await setDepreciationRuleActive(r.id, !r.is_active);
    if (e) { setToast({ type: "error", message: td.error + e }); return; }
    setToast({ type: "success", message: td.updated });
    load();
  }

  return (
    <div>
      <Card>
        <CardHeader
          title={td.title}
          description={td.subtitle}
          actions={lifecycleAvailable && (
            <Button onClick={() => setAddOpen(true)}><Plus aria-hidden="true" />{td.add}</Button>
          )}
        />

        {!lifecycleAvailable && !loading && (
          <div className="border-b border-line px-5 py-4">
            <section
              className="flex items-start gap-2.5 rounded-xl bg-warn-soft px-4 py-3 text-warn"
              role="status"
            >
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">{td.projectionUnavailableTitle}</h3>
                <p className="mt-1 text-[13px] leading-6 text-fg-2">
                  {td.projectionUnavailableDesc}
                </p>
              </div>
            </section>
          </div>
        )}

        <div tabIndex={0} className="overflow-x-auto">
          <table className="ui-table">
            <thead>
              <tr>
                <th>{td.company}</th>
                <th>{td.category}</th>
                <th>{td.assetType}</th>
                <th>{td.usefulLife}</th>
                <th>{td.annualRate}</th>
                <th>{td.salvageRate}</th>
                <th>{td.status}</th>
                <th>{td.actions}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <TableMessage colSpan={8} loading />
              : rows.length === 0 ? <TableMessage colSpan={8}><EmptyState compact icon={TrendingDown} title={td.empty} /></TableMessage>
              : rows.map((r) => (
                <tr key={r.id}>
                  <td className="text-fg-2">{r.company_id ? (compLabel.get(r.company_id) ?? "—") : td.anyCompany}</td>
                  <td className={`font-medium ${r.is_active ? "text-fg" : "text-muted"}`}>{r.category_id ? (catLabel.get(r.category_id) ?? "—") : td.anyCategory}</td>
                  <td className="text-fg-2">{r.asset_type ? ((t.assetTemplates as any)?.[r.asset_type]?.label ?? r.asset_type) : "—"}</td>
                  <td className="tabular-nums text-fg-2"><bdi dir="ltr">{r.useful_life_years != null ? `${r.useful_life_years} ${td.years}` : "—"}</bdi></td>
                  <td className="font-medium tabular-nums text-fg"><bdi dir="ltr">{r.annual_rate != null ? `${r.annual_rate}%` : "—"}</bdi></td>
                  <td className="tabular-nums text-fg-2"><bdi dir="ltr">{r.salvage_rate != null ? `${r.salvage_rate}%` : "—"}</bdi></td>
                  <td><ActiveChip active={r.is_active} activeLabel={td.active} inactiveLabel={td.inactive} /></td>
                  <td>
                    <div className="flex gap-1">
                      {lifecycleAvailable ? (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(r)}><Pencil aria-hidden="true" />{t.common.edit}</Button>
                          <Button size="sm" variant="outline" onClick={() => toggleActive(r)}><Power aria-hidden="true" />{r.is_active ? td.disable : td.enable}</Button>
                        </>
                      ) : (
                        <StatusChip tone="neu" dot={false} size="sm">{td.readOnly}</StatusChip>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <RuleDialog open={addOpen} cats={cats} companies={companies} t={t} onClose={() => setAddOpen(false)}
        onDone={(m) => { setAddOpen(false); setToast(m); load(); }} />
      <RuleDialog open={!!editing} row={editing} cats={cats} companies={companies} t={t} onClose={() => setEditing(null)}
        onDone={(m) => { setEditing(null); setToast(m); load(); }} />

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function RuleDialog({ open, row, cats, companies, t, onClose, onDone }: {
  open: boolean; row?: DepreciationRuleRow | null; cats: Cat[]; companies: Comp[]; t: any;
  onClose: () => void; onDone: (m: ToastState) => void;
}) {
  const td = t.depreciation;
  const [f, setF] = useState({
    category_id: "", company_id: "", asset_type: "", annual_rate: "", salvage_rate: "",
    useful_life_years: "", alert_before_days: "30", priority: "100", is_active: true,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    if (row) {
      setF({
        category_id: row.category_id ?? "", company_id: row.company_id ?? "", asset_type: row.asset_type ?? "",
        annual_rate: row.annual_rate != null ? String(row.annual_rate) : "",
        salvage_rate: row.salvage_rate != null ? String(row.salvage_rate) : "0",
        useful_life_years: row.useful_life_years != null ? String(row.useful_life_years) : "",
        alert_before_days: String(row.alert_before_days ?? 30), priority: String(row.priority ?? 100),
        is_active: row.is_active,
      });
    } else {
      setF({
        category_id: "", company_id: "", asset_type: "", annual_rate: "", salvage_rate: "0",
        useful_life_years: "", alert_before_days: "30", priority: "100", is_active: true,
      });
    }
    setErr({});
  }, [open, row]);

  const set = (k: string) => (v: string | boolean) => setF((s) => ({ ...s, [k]: v }));

  async function submit() {
    const e: Record<string, string> = {};
    const hasLife = f.useful_life_years.trim() !== "";
    const usefulLife = parseStrictDecimal(f.useful_life_years, {
      min: Number.EPSILON, max: 1000,
    });
    const annualRateInput = parseStrictDecimal(f.annual_rate, {
      required: !hasLife, max: 100,
    });
    const salvageRate = parseStrictDecimal(f.salvage_rate, { required: true, max: 100 });
    const alertDays = parseStrictInteger(f.alert_before_days, { emptyValue: 30, max: 36500 });
    const priority = parseStrictInteger(f.priority, { emptyValue: 100, max: 1000000 });
    if (!annualRateInput.ok) e.annual_rate = td.rateOrLife;
    if (!usefulLife.ok) e.useful_life_years = td.lifeRange;
    if (!salvageRate.ok) e.salvage_rate = td.rateRange;
    if (!alertDays.ok) e.alert_before_days = td.integerRange;
    if (!priority.ok) e.priority = td.integerRange;
    const life = usefulLife.ok ? usefulLife.value : null;
    const salvage = salvageRate.ok ? (salvageRate.value ?? 0) : 0;
    const derivedAnnualRate = life != null
      ? (100 - salvage) / life
      : annualRateInput.ok ? annualRateInput.value : null;
    if (derivedAnnualRate != null && derivedAnnualRate > 100) e.useful_life_years = td.lifeRange;
    setErr(e); if (Object.keys(e).length) return;
    if (!usefulLife.ok || !annualRateInput.ok || !salvageRate.ok || !alertDays.ok || !priority.ok) return;

    // نخزّن annual_rate دائمًا (مطلوب في العرض المالي)؛ يُشتق من العمر الافتراضي عند إدخاله.
    const annualRate = derivedAnnualRate ?? 0;

    const payload: DepreciationRuleInput = {
      category_id: f.category_id || null, company_id: f.company_id || null,
      asset_type: f.asset_type.trim() || null, method: "straight_line",
      annual_rate: annualRate, salvage_rate: salvage,
      useful_life_years: life,
      alert_before_days: alertDays.value ?? 30,
      priority: priority.value ?? 100,
      is_active: f.is_active,
    };
    setBusy(true);
    const msg = row ? await updateDepreciationRule(row.id, payload) : await createDepreciationRule(payload);
    setBusy(false);
    onDone(msg ? { type: "error", message: td.error + msg } : { type: "success", message: row ? td.updated : td.saved });
  }

  return (
    <Dialog open={open} onClose={onClose} title={row ? td.edit : td.add}
      footer={<><Button variant="outline" onClick={onClose}>{td.cancel}</Button><Button onClick={submit} disabled={busy}>{busy ? td.saving : td.save}</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={td.company} error={err.company_id}>
            <Select value={f.company_id} onChange={(v) => set("company_id")(v)} placeholder={td.anyCompany}
              options={companies.map((c) => ({ value: c.id, label: c.name }))} />
          </Field>
          <Field label={td.category}>
            <Select value={f.category_id} onChange={(v) => set("category_id")(v)} placeholder={td.anyCategory}
              options={cats.map((c) => ({ value: c.id, label: c.name_ar ?? c.name }))} />
          </Field>
        </div>
        <Field label={td.assetTypeOptional}>
          <Select value={f.asset_type} onChange={(v) => set("asset_type")(v)} placeholder={td.anyType}
            options={ALL_TEMPLATE_IDS.map((id) => ({ value: id, label: t.assetTemplates?.[id]?.label ?? id }))} />
        </Field>
        <Field label={td.method}>
          <input className={inputClass} value={td.methodStraightLine} disabled readOnly />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={td.usefulLifeOptional} hint={td.usefulLifeHint} error={err.useful_life_years}>
            <input className={inputClass} value={f.useful_life_years} onChange={(e) => set("useful_life_years")(e.target.value)} dir="ltr" inputMode="decimal" placeholder="4" />
          </Field>
          <Field label={td.annualRate} error={err.annual_rate} hint={td.annualRateHint}>
            <input className={inputClass} value={f.annual_rate} onChange={(e) => set("annual_rate")(e.target.value)} dir="ltr" inputMode="decimal" placeholder="20" />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label={td.salvageRate} error={err.salvage_rate}>
            <input className={inputClass} value={f.salvage_rate} onChange={(e) => set("salvage_rate")(e.target.value)} dir="ltr" inputMode="decimal" placeholder="10" />
          </Field>
          <Field label={td.alertBeforeDays} error={err.alert_before_days}>
            <input className={inputClass} value={f.alert_before_days} onChange={(e) => set("alert_before_days")(e.target.value)} dir="ltr" inputMode="numeric" placeholder="30" />
          </Field>
          <Field label={td.priority} hint={td.priorityHint} error={err.priority}>
            <input className={inputClass} value={f.priority} onChange={(e) => set("priority")(e.target.value)} dir="ltr" inputMode="numeric" placeholder="100" />
          </Field>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-fg-2">
          <input type="checkbox" checked={f.is_active} onChange={(e) => set("is_active")(e.target.checked)} className={checkboxClass} />
          {td.active}
        </label>
      </div>
    </Dialog>
  );
}
