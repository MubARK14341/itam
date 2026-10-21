"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Power, Factory } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, SearchInput, inputClass } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import {
  listCompaniesAdmin, createCompany, updateCompany, setCompanyActive, type CompanyAdminRow,
} from "@/lib/queries";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { ActiveChip, CheckboxFilter, TableMessage, Toolbar, checkboxClass } from "@/components/settings/settings-ui";

export function CompaniesSettings() {
  const { t } = useAppPreferences();
  const tc = t.companies;
  const [rows, setRows] = useState<CompanyAdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [editing, setEditing] = useState<CompanyAdminRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  async function load() {
    const { rows, error } = await listCompaniesAdmin();
    if (error) setToast({ type: "error", message: tc.error + error });
    setRows(rows); setLoading(false);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => rows.filter((r) => {
    if (activeOnly && !r.is_active) return false;
    if (q && !`${r.name} ${r.notes ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [rows, q, activeOnly]);

  async function toggleActive(r: CompanyAdminRow) {
    const e = await setCompanyActive(r.id, !r.is_active);
    if (e) { setToast({ type: "error", message: tc.error + e }); return; }
    setToast({ type: "success", message: tc.updated });
    load();
  }

  return (
    <div>
      <Card>
        <CardHeader
          title={tc.title}
          description={tc.subtitle}
          actions={<Button onClick={() => setAddOpen(true)}><Plus aria-hidden="true" />{tc.add}</Button>}
        />
        <Toolbar>
          <SearchInput label={tc.search} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tc.search}
            onClear={() => setQ("")} clearLabel={t.common.clearSearch}
            containerClassName="min-w-[220px] flex-1" />
          <CheckboxFilter label={tc.activeOnly} checked={activeOnly} onChange={setActiveOnly} />
          {!loading && (
            <span className="ms-auto text-[13px] tabular-nums text-muted">{filtered.length} / {rows.length}</span>
          )}
        </Toolbar>
        <div tabIndex={0} className="overflow-x-auto">
          <table className="ui-table">
            <thead>
              <tr>
                <th>{tc.name}</th>
                <th>{tc.notes}</th>
                <th>{tc.status}</th>
                <th>{tc.actions}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <TableMessage colSpan={4} loading />
              : filtered.length === 0 ? <TableMessage colSpan={4}><EmptyState compact icon={Factory} title={tc.empty} /></TableMessage>
              : filtered.map((r) => (
                <tr key={r.id}>
                  <td className={`font-medium ${r.is_active ? "text-fg" : "text-muted"}`}>{r.name}</td>
                  <td className="text-[13px] text-fg-2">{r.notes ?? "—"}</td>
                  <td><ActiveChip active={r.is_active} activeLabel={tc.active} inactiveLabel={tc.inactive} /></td>
                  <td>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(r)}><Pencil aria-hidden="true" />{t.common.edit}</Button>
                      <Button size="sm" variant="outline" onClick={() => toggleActive(r)}><Power aria-hidden="true" />{r.is_active ? tc.disable : tc.enable}</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <CompanyDialog open={addOpen} t={t} onClose={() => setAddOpen(false)}
        onDone={(m) => { setAddOpen(false); setToast(m); load(); }} />
      <CompanyDialog open={!!editing} row={editing} t={t} onClose={() => setEditing(null)}
        onDone={(m) => { setEditing(null); setToast(m); load(); }} />

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function CompanyDialog({ open, row, t, onClose, onDone }: {
  open: boolean; row?: CompanyAdminRow | null; t: any;
  onClose: () => void; onDone: (m: ToastState) => void;
}) {
  const tc = t.companies;
  const [f, setF] = useState({ name: "", notes: "", is_active: true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!open) return;
    setF(row ? { name: row.name ?? "", notes: row.notes ?? "", is_active: row.is_active }
             : { name: "", notes: "", is_active: true });
    setErr("");
  }, [open, row]);

  async function submit() {
    if (!f.name.trim()) { setErr(tc.nameRequired); return; }
    setBusy(true);
    const e = row
      ? await updateCompany(row.id, { name: f.name, notes: f.notes.trim() || null, is_active: f.is_active })
      : await createCompany({ name: f.name, notes: f.notes.trim() || null, is_active: f.is_active });
    setBusy(false);
    onDone(e ? { type: "error", message: tc.error + e } : { type: "success", message: row ? tc.updated : tc.saved });
  }

  return (
    <Dialog open={open} onClose={onClose} title={row ? tc.edit : tc.add}
      footer={<><Button variant="outline" onClick={onClose}>{tc.cancel}</Button><Button onClick={submit} disabled={busy}>{busy ? tc.saving : tc.save}</Button></>}>
      <div className="space-y-4">
        <Field label={tc.name} required error={err}>
          <input className={inputClass} value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} />
        </Field>
        <Field label={tc.notes}>
          <textarea className={`${inputClass} resize-none`} rows={2} value={f.notes} onChange={(e) => setF((s) => ({ ...s, notes: e.target.value }))} />
        </Field>
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-fg-2">
          <input type="checkbox" checked={f.is_active} onChange={(e) => setF((s) => ({ ...s, is_active: e.target.checked }))} className={checkboxClass} />
          {tc.active}
        </label>
      </div>
    </Dialog>
  );
}
