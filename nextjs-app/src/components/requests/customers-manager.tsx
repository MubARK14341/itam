"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Power, KeyRound, Copy, Ban, Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, SearchInput, Select, inputClass } from "@/components/ui/form";
import { FilterChip } from "@/components/ui/filter-chip";
import { StatusChip } from "@/components/ui/status-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { Toast, type ToastState } from "@/components/ui/toast";
import {
  listCustomers, createCustomer, updateCustomer, setCustomerActive, approveCustomer, type CustomerRow, type CustomerInput,
  createPortalInvite, revokePortalInvite, setPortalUserActive, listPortalInvites, listPortalUsers,
  type PortalInviteRow, type PortalUserRow, type PortalRoleKey,
} from "@/lib/requests";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { PortalSettingsSection } from "@/components/requests/portal-settings-section";

// إدارة العملاء الخارجيين — admin/it_manager فقط (RLS يفرضها أيضًا). لا حذف؛ تعطيل بـ is_active.
export function CustomersManager() {
  const { t } = useAppPreferences();
  const tc = t.customers;
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [editing, setEditing] = useState<CustomerRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [portalFor, setPortalFor] = useState<CustomerRow | null>(null);

  async function load() {
    const { rows, error } = await listCustomers();
    if (error) setToast({ type: "error", message: tc.error + error });
    setRows(rows); setLoading(false);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => rows.filter((r) => {
    if (activeOnly && !r.is_active) return false;
    if (pendingOnly && r.approval_status !== "pending") return false;
    if (q && !`${r.name} ${r.phone ?? ""} ${r.city ?? ""} ${r.contact_person ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [rows, q, activeOnly, pendingOnly]);
  const pendingCount = useMemo(() => rows.filter((r) => r.approval_status === "pending").length, [rows]);

  async function toggleActive(r: CustomerRow) {
    const e = await setCustomerActive(r.id, !r.is_active);
    if (e) { setToast({ type: "error", message: tc.error + e }); return; }
    setToast({ type: "success", message: tc.updated });
    load();
  }
  // اعتماد/رفض عميل مسجَّل ذاتيًا (يفعّل/يعطّل بوابته عبر RPC آمن)
  async function decide(r: CustomerRow, approve: boolean) {
    const e = await approveCustomer(r.id, approve);
    if (e) { setToast({ type: "error", message: tc.error + e }); return; }
    setToast({ type: "success", message: tc.updated });
    load();
  }

  const actionsFor = (r: CustomerRow) => (
    <div className="flex flex-wrap gap-1.5">
      {r.approval_status === "pending" && (
        <>
          <Button size="sm" onClick={() => decide(r, true)}><Power aria-hidden="true" />{tc.approve}</Button>
          <Button size="sm" variant="danger-ghost" onClick={() => decide(r, false)}><Ban aria-hidden="true" />{tc.reject}</Button>
        </>
      )}
      <Button size="sm" variant="ghost" onClick={() => setEditing(r)}><Pencil aria-hidden="true" />{t.common.edit}</Button>
      <Button size="sm" variant="ghost" onClick={() => setPortalFor(r)}><KeyRound aria-hidden="true" />{t.portal.invite.manageTitle}</Button>
      <Button size="sm" variant="outline" onClick={() => toggleActive(r)}><Power aria-hidden="true" />{r.is_active ? tc.disable : tc.enable}</Button>
    </div>
  );

  const statusChips = (r: CustomerRow) => (
    <div className="flex flex-wrap items-center gap-1">
      <StatusChip tone={r.is_active ? "ok" : "neu"} size="sm">{r.is_active ? tc.active : tc.inactive}</StatusChip>
      {r.approval_status === "pending" && <StatusChip tone="warn" size="sm">{tc.pendingBadge}</StatusChip>}
      {r.approval_status === "rejected" && <StatusChip tone="bad" size="sm">{tc.rejectedBadge}</StatusChip>}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted">{tc.subtitle}</p>
        <Button onClick={() => setAddOpen(true)}><Plus aria-hidden="true" />{tc.add}</Button>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface-2 p-4">
        <SearchInput label={tc.search} value={q} onChange={(e) => setQ(e.target.value)} onClear={() => setQ("")}
          clearLabel={t.common.clearSearch} placeholder={tc.search} containerClassName="min-w-[220px] flex-1" />
        <FilterChip pressed={activeOnly} onClick={() => setActiveOnly((v) => !v)}>{tc.activeOnly}</FilterChip>
        <FilterChip pressed={pendingOnly} onClick={() => setPendingOnly((v) => !v)} count={pendingCount > 0 ? pendingCount : undefined}>{tc.pendingOnly}</FilterChip>
      </div>

      <div className="space-y-3 md:hidden">
        {loading ? <Card className="flex justify-center p-8"><Spinner /></Card>
          : filtered.length === 0 ? <Card><EmptyState compact icon={Users} title={tc.empty} /></Card>
          : filtered.map((r) => (
            <Card key={r.id} className={`p-5 ${!r.is_active ? "opacity-60" : ""}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-fg">{r.name}</p>
                  <p className="mt-0.5 text-xs text-muted">{r.contact_person ?? "—"}</p>
                </div>
                <div className="shrink-0">{statusChips(r)}</div>
              </div>
              <dl className="my-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                <div><dt className="text-muted">{tc.phone}</dt><dd className="mt-0.5 truncate tabular-nums text-fg-2" dir="ltr">{r.phone ?? "—"}</dd></div>
                <div><dt className="text-muted">{tc.city}</dt><dd className="mt-0.5 truncate text-fg-2">{r.city ?? "—"}</dd></div>
              </dl>
              <div className="border-t border-line pt-3">{actionsFor(r)}</div>
            </Card>
          ))}
      </div>

      <Card className="hidden overflow-hidden md:block">
        <div tabIndex={0} className="overflow-x-auto">
          <table className="ui-table">
            <caption className="sr-only">{tc.title}</caption>
            <thead>
              <tr>
                <th scope="col">{tc.name}</th>
                <th scope="col">{tc.contactPerson}</th>
                <th scope="col">{tc.phone}</th>
                <th scope="col">{tc.city}</th>
                <th scope="col">{tc.status}</th>
                <th scope="col">{tc.actions}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <tr><td colSpan={6} className="py-12 text-center"><Spinner /></td></tr>
              : filtered.length === 0 ? <tr><td colSpan={6} className="!h-auto"><EmptyState compact icon={Users} title={tc.empty} /></td></tr>
              : filtered.map((r) => (
                <tr key={r.id} className={!r.is_active ? "opacity-60" : ""}>
                  <td className="font-semibold text-fg">{r.name}</td>
                  <td className="text-[13px] text-fg-2">{r.contact_person ?? "—"}</td>
                  <td className="text-[13px] tabular-nums text-fg-2" dir="ltr">{r.phone ?? "—"}</td>
                  <td className="text-[13px] text-fg-2">{r.city ?? "—"}</td>
                  <td>{statusChips(r)}</td>
                  <td className="!py-2">{actionsFor(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <CustomerDialog open={addOpen} t={t} onClose={() => setAddOpen(false)}
        onDone={(m) => { setAddOpen(false); setToast(m); load(); }} />
      <CustomerDialog open={!!editing} row={editing} t={t} onClose={() => setEditing(null)}
        onDone={(m) => { setEditing(null); setToast(m); load(); }} />

      {portalFor && <PortalAccessDialog customer={portalFor} t={t} onClose={() => setPortalFor(null)} onToast={setToast} />}

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

// مُصدَّر ليُعاد استخدامه من صفحة إنشاء الطلب («إضافة عميل جديد» دون مغادرة النموذج).
// onDone تُرجع معرف العميل الجديد عند الإنشاء (null عند التعديل/الفشل) للاختيار التلقائي.
export function CustomerDialog({ open, row, t, onClose, onDone }: {
  open: boolean; row?: CustomerRow | null; t: any;
  onClose: () => void; onDone: (m: ToastState, newId?: string | null) => void;
}) {
  const tc = t.customers;
  const empty = { name: "", contact_person: "", phone: "", email: "", city: "", address: "", notes: "", is_active: true };
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!open) return;
    setF(row ? {
      name: row.name ?? "", contact_person: row.contact_person ?? "", phone: row.phone ?? "",
      email: row.email ?? "", city: row.city ?? "", address: row.address ?? "", notes: row.notes ?? "",
      is_active: row.is_active,
    } : empty);
    setErr("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, row]);

  async function submit() {
    if (!f.name.trim()) { setErr(tc.nameRequired); return; }
    setBusy(true);
    const payload: CustomerInput = {
      name: f.name, contact_person: f.contact_person.trim() || null, phone: f.phone.trim() || null,
      email: f.email.trim() || null, city: f.city.trim() || null, address: f.address.trim() || null,
      notes: f.notes.trim() || null, is_active: f.is_active,
    };
    let e: string | null; let newId: string | null = null;
    if (row) { e = await updateCustomer(row.id, payload); }
    else { const res = await createCustomer(payload); e = res.error; newId = res.id; }
    setBusy(false);
    const msg = e ? ((t.requests.err as Record<string, string>)[e] ?? e) : "";
    onDone(e ? { type: "error", message: tc.error + msg } : { type: "success", message: row ? tc.updated : tc.saved }, e ? null : newId);
  }

  const set = (k: keyof typeof empty) => (e: any) => setF((s) => ({ ...s, [k]: e.target.value }));

  return (
    <Dialog open={open} onClose={onClose} title={row ? tc.edit : tc.add} size="xl"
      footer={<><Button variant="outline" onClick={onClose}>{tc.cancel}</Button><Button onClick={submit} disabled={busy}>{busy ? tc.saving : tc.save}</Button></>}>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field label={tc.name} required error={err}>
          <input className={inputClass} value={f.name} onChange={set("name")} />
        </Field>
        <Field label={tc.contactPerson}>
          <input className={inputClass} value={f.contact_person} onChange={set("contact_person")} />
        </Field>
        <Field label={tc.phone}>
          <input className={inputClass} value={f.phone} onChange={set("phone")} dir="ltr" />
        </Field>
        <Field label={tc.email}>
          <input className={inputClass} value={f.email} onChange={set("email")} dir="ltr" />
        </Field>
        <Field label={tc.city}>
          <input className={inputClass} value={f.city} onChange={set("city")} />
        </Field>
        <Field label={tc.address}>
          <input className={inputClass} value={f.address} onChange={set("address")} />
        </Field>
        <div className="sm:col-span-2">
          <Field label={tc.notes}>
            <textarea className={`${inputClass} resize-none`} rows={2} value={f.notes} onChange={set("notes")} />
          </Field>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[13.5px] text-fg-2 sm:col-span-2">
          <input type="checkbox" checked={f.is_active} onChange={(e) => setF((s) => ({ ...s, is_active: e.target.checked }))} className="h-4 w-4 rounded accent-brand" />
          {tc.active}
        </label>
      </div>
    </Dialog>
  );
}

// إدارة وصول بوابة العميل — إنشاء/إبطال دعوات + تفعيل/تعطيل مستخدمي البوابة (admin/it_manager).
function PortalAccessDialog({ customer, t, onClose, onToast }: {
  customer: CustomerRow; t: any; onClose: () => void; onToast: (m: ToastState) => void;
}) {
  const ti = t.portal.invite;
  const [invites, setInvites] = useState<PortalInviteRow[]>([]);
  const [users, setUsers] = useState<PortalUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<PortalRoleKey>("authorized_requester");
  const [days, setDays] = useState("14");
  const [busy, setBusy] = useState(false);
  const [newCode, setNewCode] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const [inv, usr] = await Promise.all([listPortalInvites(customer.id), listPortalUsers(customer.id)]);
    setInvites(inv); setUsers(usr); setLoading(false);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [customer.id]);

  const roleLabel = (r: string) => (ti.roles as Record<string, string>)[r] ?? r;

  async function generate() {
    setBusy(true); setNewCode(null);
    const { code, error } = await createPortalInvite(customer.id, role, Math.max(1, Number(days) || 14));
    setBusy(false);
    if (error || !code) { onToast({ type: "error", message: ti.createError + (error ?? "") }); return; }
    setNewCode(code); load();
  }
  async function revoke(id: string) {
    const e = await revokePortalInvite(id);
    if (e) { onToast({ type: "error", message: ti.createError + e }); return; }
    load();
  }
  async function toggleUser(u: PortalUserRow) {
    const e = await setPortalUserActive(u.id, !u.is_active);
    if (e) { onToast({ type: "error", message: ti.createError + e }); return; }
    load();
  }
  function copy(code: string) {
    try { navigator.clipboard?.writeText(code); onToast({ type: "success", message: ti.copied }); } catch { /* noop */ }
  }

  return (
    <Dialog open onClose={onClose} title={`${ti.manageTitle} — ${customer.name}`} size="2xl">
      <div className="space-y-5">
        {/* إعدادات بوابة العميل (Phase 5) */}
        <PortalSettingsSection customerId={customer.id} onToast={onToast} />

        {/* إنشاء دعوة */}
        <section aria-labelledby="portal-invite-create" className="rounded-xl border border-line p-4">
          <h3 id="portal-invite-create" className="mb-3 text-sm font-semibold text-fg">{ti.create}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={ti.role}><Select value={role} onChange={(v) => setRole(v as PortalRoleKey)} options={(["project_manager", "authorized_requester", "viewer"] as const).map((k) => ({ value: k, label: roleLabel(k) }))} /></Field>
            <Field label={ti.validDays}><input className={`${inputClass} tabular-nums`} type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} dir="ltr" /></Field>
            <div className="flex items-end"><Button className="w-full" disabled={busy} onClick={generate}><KeyRound aria-hidden="true" />{ti.generate}</Button></div>
          </div>
          {newCode && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-ok-soft px-3.5 py-2.5">
              <span className="text-[13px] text-fg">{ti.generated} <bdi dir="ltr" className="font-mono font-semibold">{newCode}</bdi></span>
              <Button size="sm" variant="outline" onClick={() => copy(newCode)}><Copy aria-hidden="true" />{ti.copy}</Button>
            </div>
          )}
        </section>

        {/* الدعوات النشطة */}
        <section aria-labelledby="portal-invite-existing">
          <h3 id="portal-invite-existing" className="mb-2 text-sm font-semibold text-fg">{ti.existing}</h3>
          {loading ? <Spinner />
            : invites.length === 0 ? <p className="text-xs text-muted">—</p>
              : <ul className="divide-y divide-line rounded-xl border border-line">{invites.map((iv) => (
                <li key={iv.id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 text-[13px]">
                  <div><bdi dir="ltr" className="font-mono font-semibold text-fg">{iv.code}</bdi> <span className="text-xs text-muted">· {roleLabel(iv.portal_role)} · <span className="tabular-nums">{iv.used_count}/{iv.max_uses}</span></span></div>
                  <Button size="sm" variant="ghost" onClick={() => revoke(iv.id)}><Ban aria-hidden="true" />{ti.revoke}</Button>
                </li>))}</ul>}
        </section>

        {/* مستخدمو البوابة */}
        <section aria-labelledby="portal-invite-users">
          <h3 id="portal-invite-users" className="mb-2 text-sm font-semibold text-fg">{ti.users}</h3>
          {loading ? <Spinner />
            : users.length === 0 ? <p className="text-xs text-muted">{ti.noUsers}</p>
              : <ul className="divide-y divide-line rounded-xl border border-line">{users.map((u) => (
                <li key={u.id} className={`flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 text-[13px] ${!u.is_active ? "opacity-60" : ""}`}>
                  <div className="text-fg">{u.contact_name} <span className="text-xs text-muted">· {roleLabel(u.portal_role)} · {u.is_active ? ti.active : ti.inactive}</span></div>
                  <Button size="sm" variant="outline" onClick={() => toggleUser(u)}><Power aria-hidden="true" />{u.is_active ? ti.deactivate : ti.activate}</Button>
                </li>))}</ul>}
        </section>
      </div>
    </Dialog>
  );
}
