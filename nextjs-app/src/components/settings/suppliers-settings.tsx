"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Power, Building2, Truck } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusChip } from "@/components/ui/status-chip";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, SearchInput, Select, inputClass } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import {
  listSuppliersAdmin, createSupplierFull, updateSupplierFull, setSupplierActive, getFormOptions,
  type SupplierAdminRow, type SupplierInput,
} from "@/lib/queries";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { friendlyErrorStrict, type UiLang } from "@/lib/user-facing-errors";
import { ActiveChip, CheckboxFilter, TableMessage, Toolbar, checkboxClass } from "@/components/settings/settings-ui";

type Cat = { id: string; name: string; name_ar: string | null };

export function SuppliersSettings() {
  const { t, lang } = useAppPreferences();
  const ts = t.suppliers;
  const [rows, setRows] = useState<SupplierAdminRow[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [editing, setEditing] = useState<SupplierAdminRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  async function load() {
    const { rows, error } = await listSuppliersAdmin();
    if (error) setToast({ type: "error", message: friendlyErrorStrict(error, lang) });
    setRows(rows); setLoading(false);
  }
  useEffect(() => {
    load();
    getFormOptions().then((o) => setCats((o.categories as Cat[]) ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const catLabel = useMemo(() => {
    const m = new Map<string, string>();
    cats.forEach((c) => m.set(c.id, c.name_ar ?? c.name));
    return m;
  }, [cats]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (activeOnly && !r.is_active) return false;
    if (catFilter && !r.category_ids.includes(catFilter)) return false;
    if (q && !`${r.name} ${r.name_ar ?? ""} ${r.phone ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [rows, q, catFilter, activeOnly]);

  async function toggleActive(r: SupplierAdminRow) {
    const e = await setSupplierActive(r.id, !r.is_active);
    if (e) { setToast({ type: "error", message: friendlyErrorStrict(e, lang) }); return; }
    setToast({ type: "success", message: ts.updated });
    load();
  }

  return (
    <div>
      <Card>
        <CardHeader
          title={ts.title}
          description={ts.subtitle}
          actions={<Button onClick={() => setAddOpen(true)}><Plus aria-hidden="true" />{ts.add}</Button>}
        />
        <Toolbar>
          <SearchInput label={ts.search} value={q} onChange={(e) => setQ(e.target.value)} placeholder={ts.search}
            onClear={() => setQ("")} clearLabel={t.common.clearSearch}
            containerClassName="min-w-[220px] flex-1" />
          <div className="min-w-[200px]">
            <Select value={catFilter} onChange={setCatFilter} placeholder={ts.allCategories}
              options={cats.map((c) => ({ value: c.id, label: c.name_ar ?? c.name }))} />
          </div>
          <CheckboxFilter label={ts.activeOnly} checked={activeOnly} onChange={setActiveOnly} />
          {!loading && (
            <span className="ms-auto text-[13px] tabular-nums text-muted">{filtered.length} / {rows.length}</span>
          )}
        </Toolbar>
        <div tabIndex={0} className="overflow-x-auto">
          <table className="ui-table">
            <thead>
              <tr>
                <th>{ts.name}</th>
                <th>{ts.categories}</th>
                <th>{ts.phone}</th>
                <th>{ts.status}</th>
                <th>{ts.actions}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <TableMessage colSpan={5} loading />
              : filtered.length === 0 ? <TableMessage colSpan={5}><EmptyState compact icon={Truck} title={ts.empty} /></TableMessage>
              : filtered.map((r) => (
                <tr key={r.id}>
                  <td className={`font-medium ${r.is_active ? "text-fg" : "text-muted"}`}>{r.name_ar ?? r.name}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {r.category_ids.length === 0 ? <span className="text-xs text-muted">{ts.noCategories}</span> :
                        r.category_ids.map((cid) => (
                          <StatusChip key={cid} tone="neu" dot={false} size="sm" className="font-medium">{catLabel.get(cid) ?? "—"}</StatusChip>
                        ))}
                    </div>
                  </td>
                  <td className="tag font-mono text-[13px] tabular-nums text-fg-2 [unicode-bidi:isolate]" dir="ltr">{r.phone ?? "—"}</td>
                  <td><ActiveChip active={r.is_active} activeLabel={ts.active} inactiveLabel={ts.inactive} /></td>
                  <td>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(r)}><Pencil aria-hidden="true" />{t.common.edit}</Button>
                      <Button size="sm" variant="outline" onClick={() => toggleActive(r)}><Power aria-hidden="true" />{r.is_active ? ts.disable : ts.enable}</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <SupplierDialog open={addOpen} cats={cats} t={t} lang={lang} onClose={() => setAddOpen(false)}
        onDone={(m) => { setAddOpen(false); setToast(m); load(); }} />
      <SupplierDialog open={!!editing} row={editing} cats={cats} t={t} lang={lang} onClose={() => setEditing(null)}
        onDone={(m) => { setEditing(null); setToast(m); load(); }} />

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function SupplierDialog({ open, row, cats, t, lang, onClose, onDone }: {
  open: boolean; row?: SupplierAdminRow | null; cats: Cat[]; t: any; lang: UiLang;
  onClose: () => void; onDone: (m: ToastState) => void;
}) {
  const ts = t.suppliers;
  const [f, setF] = useState<SupplierInput>({
    name: "", name_ar: "", contact_person: "", phone: "", email: "", address: "", notes: "", is_active: true, category_ids: [],
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!open) return;
    if (row) {
      setF({
        name: row.name ?? "", name_ar: row.name_ar ?? "", contact_person: row.contact_person ?? "",
        phone: row.phone ?? "", email: row.email ?? "", address: row.address ?? "", notes: row.notes ?? "",
        is_active: row.is_active, category_ids: [...row.category_ids],
      });
    } else {
      setF({ name: "", name_ar: "", contact_person: "", phone: "", email: "", address: "", notes: "", is_active: true, category_ids: [] });
    }
    setErr("");
  }, [open, row]);

  const set = <K extends keyof SupplierInput>(k: K) => (v: SupplierInput[K]) => setF((s) => ({ ...s, [k]: v }));
  const toggleCat = (id: string) => setF((s) => ({
    ...s, category_ids: s.category_ids.includes(id) ? s.category_ids.filter((c) => c !== id) : [...s.category_ids, id],
  }));

  async function submit() {
    const nameAr = (f.name_ar ?? "").trim();
    if (!f.name.trim() && !nameAr) { setErr(ts.nameRequired); return; }
    const payload: SupplierInput = { ...f, name: (f.name.trim() || nameAr), name_ar: (nameAr || f.name.trim()) };
    setBusy(true);
    const e = row ? await updateSupplierFull(row.id, payload) : await createSupplierFull(payload);
    setBusy(false);
    onDone(e
      ? { type: "error", message: friendlyErrorStrict(e, lang) }
      : { type: "success", message: row ? ts.updated : ts.saved });
  }

  return (
    <Dialog open={open} onClose={onClose} size="2xl" title={row ? ts.edit : ts.add}
      footer={<><Button variant="outline" onClick={onClose}>{ts.cancel}</Button><Button onClick={submit} disabled={busy}>{busy ? ts.saving : ts.save}</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={ts.name} required error={err}><input className={inputClass} value={f.name} onChange={(e) => set("name")(e.target.value)} /></Field>
          <Field label={ts.nameAr}><input className={inputClass} value={f.name_ar ?? ""} onChange={(e) => set("name_ar")(e.target.value)} /></Field>
          <Field label={ts.contactPerson}><input className={inputClass} value={f.contact_person ?? ""} onChange={(e) => set("contact_person")(e.target.value)} /></Field>
          <Field label={ts.phone}><input className={inputClass} value={f.phone ?? ""} onChange={(e) => set("phone")(e.target.value)} dir="ltr" inputMode="tel" /></Field>
          <Field label={ts.email}><input className={inputClass} value={f.email ?? ""} onChange={(e) => set("email")(e.target.value)} dir="ltr" inputMode="email" /></Field>
          <Field label={ts.address}><input className={inputClass} value={f.address ?? ""} onChange={(e) => set("address")(e.target.value)} /></Field>
        </div>
        <Field label={ts.notes}><textarea className={`${inputClass} resize-none`} rows={2} value={f.notes ?? ""} onChange={(e) => set("notes")(e.target.value)} /></Field>

        <div>
          <p className="ui-label flex items-center gap-1.5"><Building2 aria-hidden="true" className="h-4 w-4 text-muted" />{ts.categories}</p>
          <p className="mb-2 text-xs text-muted">{ts.chooseCategories}</p>
          <div className="grid max-h-44 grid-cols-2 gap-1 overflow-y-auto rounded-control border border-line p-2 sm:grid-cols-3">
            {cats.map((c) => (
              <label key={c.id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm text-fg-2 hover:bg-surface-2">
                <input type="checkbox" checked={f.category_ids.includes(c.id)} onChange={() => toggleCat(c.id)} className={checkboxClass} />
                {c.name_ar ?? c.name}
              </label>
            ))}
          </div>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-fg-2">
          <input type="checkbox" checked={f.is_active} onChange={(e) => set("is_active")(e.target.checked)} className={checkboxClass} />
          {ts.active}
        </label>
      </div>
    </Dialog>
  );
}
