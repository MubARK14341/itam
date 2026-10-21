"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Search, Power, Layers } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, inputClass } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import {
  listPoolsAdmin, createPool, updatePool, setPoolActive, getFormOptions,
  type PoolAdminRow, type PoolInput,
} from "@/lib/queries";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";

type Opt = { id: string; name: string; name_ar?: string | null };

// إدارة مجموعات الأصول داخل تبويب «المخزون». admin/it_manager فقط (الوصول لـ Settings محكوم بالفعل).
export function AssetPoolsSettings() {
  const { t, lang } = useAppPreferences();
  const tp = t.pools;
  const [rows, setRows] = useState<PoolAdminRow[]>([]);
  const [cats, setCats] = useState<Opt[]>([]);
  const [comps, setComps] = useState<Opt[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [catF, setCatF] = useState("");
  const [compF, setCompF] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [editing, setEditing] = useState<PoolAdminRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  async function load() {
    const [{ rows, error }, opts] = await Promise.all([listPoolsAdmin(), getFormOptions()]);
    if (error) setToast({ type: "error", message: tp.error + error });
    setRows(rows);
    setCats((opts.categories ?? []).filter((c: any) => c.kind !== "consumable") as Opt[]);
    setComps((opts.companies ?? []) as Opt[]);
    setLoading(false);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  const nm = (o: { name: string; name_ar?: string | null } | null | undefined) =>
    o ? (lang === "ar" ? (o.name_ar ?? o.name) : o.name) : "—";

  const filtered = useMemo(() => rows.filter((r) => {
    if (activeOnly && !r.is_active) return false;
    if (catF && r.category_id !== catF) return false;
    if (compF && r.company_id !== compF) return false;
    if (q && !`${r.name} ${r.name_ar ?? ""} ${r.description ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [rows, q, catF, compF, activeOnly]);

  async function toggleActive(r: PoolAdminRow) {
    const e = await setPoolActive(r.id, !r.is_active);
    if (e) { setToast({ type: "error", message: tp.error + e }); return; }
    setToast({ type: "success", message: tp.updated });
    load();
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <Layers className="h-4 w-4 text-accent" />{tp.section}
        </h2>
        <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" />{tp.add}</Button>
      </div>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">{tp.sectionSubtitle}</p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tp.search} aria-label={tp.search}
            className="w-full rounded-lg border border-slate-300 py-2.5 pe-9 ps-3 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100" />
        </div>
        <div className="min-w-[150px]"><Select value={catF} onChange={setCatF} placeholder={tp.category} options={[{ value: "", label: tp.category }, ...cats.map((c) => ({ value: c.id, label: nm(c) }))]} /></div>
        <div className="min-w-[150px]"><Select value={compF} onChange={setCompF} placeholder={tp.company} options={[{ value: "", label: tp.company }, ...comps.map((c) => ({ value: c.id, label: c.name }))]} /></div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="h-4 w-4 rounded accent-indigo-600" />
          {tp.activeOnly}
        </label>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <table className="w-full text-start text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-400">
            <tr>
              <th className="px-4 py-3 text-start font-medium">{tp.name}</th>
              <th className="px-4 py-3 text-start font-medium">{tp.category}</th>
              <th className="px-4 py-3 text-start font-medium">{tp.company}</th>
              <th className="px-4 py-3 text-start font-medium">{tp.status}</th>
              <th className="px-4 py-3 text-start font-medium">{tp.actions}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {loading ? <tr><td colSpan={5} className="py-12 text-center text-slate-400">{tp.loading}</td></tr>
            : filtered.length === 0 ? <tr><td colSpan={5} className="py-12 text-center text-slate-400">{tp.empty}</td></tr>
            : filtered.map((r) => (
              <tr key={r.id} className={`hover:bg-slate-50 dark:hover:bg-slate-800/50 ${!r.is_active ? "opacity-60" : ""}`}>
                <td className="px-4 py-3 font-medium text-slate-700 dark:text-slate-300">{lang === "ar" ? (r.name_ar ?? r.name) : r.name}</td>
                <td className="px-4 py-3 text-slate-600 dark:text-slate-400">{nm(r.category)}</td>
                <td className="px-4 py-3 text-slate-600 dark:text-slate-400">{r.company?.name ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.is_active ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" : "bg-slate-100 text-slate-500 dark:bg-slate-700/40 dark:text-slate-400"}`}>{r.is_active ? tp.active : tp.inactive}</span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(r)}><Pencil className="h-3.5 w-3.5" />{t.common.edit}</Button>
                    <Button size="sm" variant="outline" onClick={() => toggleActive(r)}><Power className="h-3.5 w-3.5" />{r.is_active ? tp.disable : tp.enable}</Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PoolDialog open={addOpen} cats={cats} comps={comps} t={t} lang={lang} onClose={() => setAddOpen(false)}
        onDone={(m) => { setAddOpen(false); setToast(m); load(); }} />
      <PoolDialog open={!!editing} row={editing} cats={cats} comps={comps} t={t} lang={lang} onClose={() => setEditing(null)}
        onDone={(m) => { setEditing(null); setToast(m); load(); }} />

      <Toast toast={toast} onDone={() => setToast(null)} />
    </Card>
  );
}

function PoolDialog({ open, row, cats, comps, t, lang, onClose, onDone }: {
  open: boolean; row?: PoolAdminRow | null; cats: Opt[]; comps: Opt[]; t: any; lang: string;
  onClose: () => void; onDone: (m: ToastState) => void;
}) {
  const tp = t.pools;
  const [f, setF] = useState<PoolInput>({ name: "", name_ar: "", category_id: "", company_id: "", description: "", is_active: true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!open) return;
    setF(row
      ? { name: row.name ?? "", name_ar: row.name_ar ?? "", category_id: row.category_id ?? "", company_id: row.company_id ?? "", description: row.description ?? "", is_active: row.is_active }
      : { name: "", name_ar: "", category_id: "", company_id: "", description: "", is_active: true });
    setErr("");
  }, [open, row]);
  const nm = (o: Opt) => (lang === "ar" ? (o.name_ar ?? o.name) : o.name);

  async function submit() {
    if (!f.name.trim()) { setErr(tp.nameRequired); return; }
    setBusy(true);
    const payload: PoolInput = {
      name: f.name, name_ar: f.name_ar?.trim() || null,
      category_id: f.category_id || null, company_id: f.company_id || null,
      description: f.description?.trim() || null, is_active: f.is_active,
    };
    const e = row ? await updatePool(row.id, payload) : await createPool(payload);
    setBusy(false);
    if (e) { onDone({ type: "error", message: e === "pool_name_duplicate" ? tp.nameDuplicate : tp.error + e }); return; }
    onDone({ type: "success", message: row ? tp.updated : tp.saved });
  }

  return (
    <Dialog open={open} onClose={onClose} size="2xl" title={row ? tp.edit : tp.add}
      footer={<><Button variant="outline" onClick={onClose}>{tp.cancel}</Button><Button onClick={submit} disabled={busy}>{busy ? tp.saving : tp.save}</Button></>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={tp.name} required error={err}><input className={inputClass} value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} /></Field>
        <Field label={tp.nameAr}><input className={inputClass} value={f.name_ar ?? ""} onChange={(e) => setF((s) => ({ ...s, name_ar: e.target.value }))} dir="rtl" /></Field>
        <Field label={tp.category}><Select value={f.category_id ?? ""} onChange={(v) => setF((s) => ({ ...s, category_id: v }))} placeholder={tp.chooseCategory} options={cats.map((c) => ({ value: c.id, label: nm(c) }))} /></Field>
        <Field label={tp.company}><Select value={f.company_id ?? ""} onChange={(v) => setF((s) => ({ ...s, company_id: v }))} placeholder={tp.chooseCompany} options={comps.map((c) => ({ value: c.id, label: c.name }))} /></Field>
        <div className="sm:col-span-2"><Field label={tp.description}><textarea className={`${inputClass} resize-none`} rows={2} value={f.description ?? ""} onChange={(e) => setF((s) => ({ ...s, description: e.target.value }))} /></Field></div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-300 sm:col-span-2">
          <input type="checkbox" checked={f.is_active} onChange={(e) => setF((s) => ({ ...s, is_active: e.target.checked }))} className="h-4 w-4 rounded accent-indigo-600" />
          {tp.active}
        </label>
      </div>
    </Dialog>
  );
}
