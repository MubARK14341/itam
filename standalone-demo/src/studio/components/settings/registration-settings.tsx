"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Check, X, RotateCcw, Save, ShieldCheck, Inbox } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { StatusChip } from "@/components/ui/status-chip";
import type { Tone } from "@/lib/tone";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, inputClass } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import { useSession, isAdmin as isAdminFn, type Role } from "@/lib/session";
import { ASSIGNABLE_TECHNICAL_ROLES, assignableTechnicalRole, userFacingRole } from "@/lib/user-facing-role";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import {
  getRegistrationSettings, updateRegistrationSettings, type RegistrationSettingsRow,
  listRegistrationRequests, approveUser, approveEmployeeUser, rejectUser, resetUserPending, userMgmtError, type RegistrationRequest,
} from "@/lib/queries";
import { formatDate } from "@/lib/format";
import { Callout, TableMessage, UnsavedChangesBar, differs } from "@/components/settings/settings-ui";
import { EmployeeApprovalSelect } from "@/components/settings/employee-approval-select";

const MODE_KEYS = ["closed", "open_with_approval", "gradual", "invite_only"] as const;

// تبويب «التسجيل» — إعدادات وضع التسجيل + المقاعد + رموز الدعوة + طلبات التسجيل (قبول/رفض).
// (كان سابقًا مدمجًا مع المستخدمين؛ فُصلت قائمة المستخدمين إلى UsersSettings.)
export function RegistrationSettings() {
  const { t, lang } = useAppPreferences();
  const tu = t.usersAdmin;
  const { role } = useSession();
  const isAdmin = isAdminFn(role);
  const [toast, setToast] = useState<ToastState>(null);

  // الأدوار المتاحة للتعيين/الافتراضي (admin يُمنح من admin فقط)
  const roleLabel = (technicalRole: string | null) => {
    const state = userFacingRole(technicalRole as Role);
    return state ? (t.roles[state] ?? state) : "—";
  };
  const assignRoleOpts = ASSIGNABLE_TECHNICAL_ROLES.map((k) => ({ value: k, label: roleLabel(k) }));
  const defaultRoleOpts = assignRoleOpts;

  // ---------- registration settings ----------
  const [settings, setSettings] = useState<RegistrationSettingsRow | null>(null);
  // لقطة الإعدادات المحمّلة/المحفوظة — لشريط «تغييرات غير محفوظة» فقط (واجهة).
  const [loadedSettings, setLoadedSettings] = useState<RegistrationSettingsRow | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  async function loadSettings() {
    const { row, error } = await getRegistrationSettings();
    if (error) setToast({ type: "error", message: tu.loadError + error });
    if (row) { setSettings(row); setLoadedSettings(row); }
  }
  async function saveSettings() {
    if (!settings) return;
    setSavingSettings(true);
    // الموظفون الداخليون لا يحتاجون تأكيد بريد — الموافقة الإدارية وحدها هي البوابة.
    const e = await updateRegistrationSettings({ ...settings, require_email_verification: false });
    setSavingSettings(false);
    if (!e) setLoadedSettings(settings);
    setToast(e ? { type: "error", message: tu.settingsError + e } : { type: "success", message: tu.settingsSaved });
  }

  // ملاحظة: أكواد الدعوة أُخفيت من هذا التبويب (واجهة فقط). الجدول/الدوال/السياسات تبقى بلا تغيير،
  // ومسار التسجيل بالدعوة في /register ما زال يعمل عبر validateInvite. لإعادة عرض الإدارة هنا: أعِد
  // بطاقة الأكواد + InviteDialog + دوال listInvites/createInvite/updateInvite/setInviteActive.

  // ---------- requests ----------
  const [requests, setRequests] = useState<RegistrationRequest[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [loadingReq, setLoadingReq] = useState(true);
  const [approveFor, setApproveFor] = useState<RegistrationRequest | null>(null);
  const [rejectFor, setRejectFor] = useState<RegistrationRequest | null>(null);

  async function loadRequests() {
    setLoadingReq(true);
    const { rows, error } = await listRegistrationRequests(statusFilter || undefined);
    if (error) setToast({ type: "error", message: tu.loadError + error });
    setRequests(rows); setLoadingReq(false);
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadSettings(); }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadRequests(); }, [statusFilter]);

  async function onReset(r: RegistrationRequest) {
    const e = await resetUserPending(r.id);
    if (e) { setToast({ type: "error", message: userMgmtError(tu, e) }); return; }
    setToast({ type: "success", message: tu.resetOk }); loadRequests();
  }

  const statusTone = (s: string): Tone => (s === "approved" ? "ok" : s === "rejected" ? "bad" : s === "pending" ? "warn" : "neu");
  const statusLabel = (s: string) => ({ pending: tu.pending, approved: tu.approved, rejected: tu.rejected } as Record<string, string>)[s] ?? s;
  const settingsDirty = !!settings && !!loadedSettings && differs(settings, loadedSettings);

  return (
    <div className="space-y-4">
      {/* ============ Registration settings ============ */}
      <div>
        <Card>
          <CardHeader
            title={tu.settingsSection}
            description={tu.settingsSectionHint}
            actions={settings ? <Button onClick={saveSettings} disabled={savingSettings}><Save aria-hidden="true" />{savingSettings ? t.common.saving : tu.saveSettings}</Button> : undefined}
          />
          {!settings ? <div className="flex justify-center py-10"><Spinner label={t.common.loading} /></div> : (
            <div className="space-y-4 px-5 py-5">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label={tu.mode} hint={modeHint(tu, settings.mode)}>
                  <Select value={settings.mode} onChange={(v) => setSettings({ ...settings, mode: v })}
                    options={MODE_KEYS.map((k) => ({ value: k, label: modeLabel(tu, k) }))} />
                </Field>
                <Field label={tu.defaultRole}>
                  <Select value={settings.default_requested_role} onChange={(v) => setSettings({ ...settings, default_requested_role: v })}
                    options={defaultRoleOpts} />
                </Field>
                {settings.mode === "gradual" && (
                  <Field label={tu.setSlots}>
                    <input className={`${inputClass} tabular-nums`} dir="ltr" inputMode="numeric" value={String(settings.remaining_slots)}
                      onChange={(e) => setSettings({ ...settings, remaining_slots: Math.max(0, Number(e.target.value) || 0) })} />
                  </Field>
                )}
              </div>
              <Callout tone="neutral" icon={ShieldCheck}>{tu.emailConfirmNote}</Callout>
            </div>
          )}
        </Card>
        <UnsavedChangesBar
          show={settingsDirty}
          onDiscard={() => setSettings(loadedSettings)}
          onSave={saveSettings}
          busy={savingSettings}
          saveLabel={savingSettings ? t.common.saving : tu.saveSettings}
        />
      </div>

      {/* ============ Invite codes — أُخفيت من الواجهة (البيانات/السياسات باقية) ============ */}

      {/* ============ Staff requests ============ */}
      <Card>
        <CardHeader
          title={tu.requestsSection}
          description={tu.requestsSectionHint}
          actions={<>
            <div className="min-w-[160px]">
              <Select value={statusFilter} onChange={setStatusFilter} placeholder={tu.allStatuses}
                options={[{ value: "pending", label: tu.pending }, { value: "approved", label: tu.approved }, { value: "rejected", label: tu.rejected }]} />
            </div>
            <Button size="sm" variant="outline" onClick={loadRequests}><RefreshCw aria-hidden="true" />{tu.refresh}</Button>
          </>}
        />
        <div tabIndex={0} className="overflow-x-auto">
          <table className="ui-table">
            <thead>
              <tr>
                <th>{tu.name}</th>
                <th>{tu.email}</th>
                <th>{tu.phone}</th>
                <th>{tu.department}</th>
                <th>{tu.registeredAt}</th>
                <th>{tu.emailVerified}</th>
                <th>{tu.status}</th>
                <th>{tu.actions}</th>
              </tr>
            </thead>
            <tbody>
              {loadingReq ? <TableMessage colSpan={8} loading />
              : requests.length === 0 ? <TableMessage colSpan={8}><EmptyState compact icon={Inbox} title={tu.noRequests} /></TableMessage>
              : requests.map((r) => (
                  <tr key={r.id}>
                    <td className="!py-2.5">
                      <span className="font-medium text-fg">{r.full_name ?? "—"}</span>
                      {r.registration_note ? <p className="mt-0.5 text-xs text-muted">{tu.note}: {r.registration_note}</p> : null}
                    </td>
                    <td className="text-[13px] text-fg-2 [unicode-bidi:isolate]" dir="ltr">{r.email}</td>
                    <td className="text-[13px] tabular-nums text-fg-2 [unicode-bidi:isolate]" dir="ltr">{r.phone ?? "—"}</td>
                    <td className="text-fg-2">{r.department_name ?? "—"}</td>
                    <td className="whitespace-nowrap text-[13px] tabular-nums text-fg-2">{formatDate(r.created_at, lang)}</td>
                    <td>
                      <StatusChip tone={r.email_confirmed ? "ok" : "warn"} size="sm">{r.email_confirmed ? tu.verified : tu.notVerified}</StatusChip>
                    </td>
                    <td><StatusChip tone={statusTone(r.approval_status)}>{statusLabel(r.approval_status)}</StatusChip></td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {r.approval_status !== "approved" && (
                          <Button size="sm" onClick={() => setApproveFor(r)}><Check aria-hidden="true" />{tu.approve}</Button>
                        )}
                        {r.approval_status !== "rejected" && (
                          <Button size="sm" variant="danger-ghost" onClick={() => setRejectFor(r)}><X aria-hidden="true" />{tu.reject}</Button>
                        )}
                        {r.approval_status !== "pending" && (
                          <Button size="sm" variant="ghost" onClick={() => onReset(r)}><RotateCcw aria-hidden="true" />{tu.resetPending}</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* dialogs */}
      <ApproveDialog req={approveFor} t={t} roleOpts={assignRoleOpts} onClose={() => setApproveFor(null)}
        onDone={(m) => { setApproveFor(null); setToast(m); loadRequests(); }} />
      <RejectDialog req={rejectFor} t={t} onClose={() => setRejectFor(null)}
        onDone={(m) => { setRejectFor(null); setToast(m); loadRequests(); }} />

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function modeLabel(tu: any, k: string) {
  return { closed: tu.modeClosed, open_with_approval: tu.modeOpen, gradual: tu.modeGradual, invite_only: tu.modeInvite }[k] ?? k;
}
function modeHint(tu: any, k: string) {
  return { closed: tu.modeClosedHint, open_with_approval: tu.modeOpenHint, gradual: tu.modeGradualHint, invite_only: tu.modeInviteHint }[k];
}

function ApproveDialog({ req, t, roleOpts, onClose, onDone }: {
  req: RegistrationRequest | null; t: any; roleOpts: { value: string; label: string }[];
  onClose: () => void; onDone: (m: ToastState) => void;
}) {
  const tu = t.usersAdmin;
  const [roleKey, setRoleKey] = useState("viewer");
  const [employeeId, setEmployeeId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!req) return;
    setRoleKey(assignableTechnicalRole(req.requested_role as Role));
    setEmployeeId(""); setError(null);
  }, [req]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!req) return null;
  async function submit() {
    setBusy(true);
    const e = roleKey === "employee" ? await approveEmployeeUser(req!.id, employeeId) : await approveUser(req!.id, roleKey);
    setBusy(false);
    if (e) { setError(userMgmtError(tu, e)); return; }
    onDone({ type: "success", message: tu.approvedOk });
  }
  return (
    <Dialog open={!!req} onClose={onClose} title={tu.approveTitle}
      footer={<><Button variant="outline" onClick={onClose}>{t.common.cancel}</Button><Button onClick={submit} disabled={busy || (roleKey === "employee" && !employeeId)}>{busy ? "…" : tu.confirmApprove}</Button></>}>
      <div className="space-y-3">
        <p className="text-sm font-medium text-fg">{req.full_name ?? req.email}</p>
        {req.requested_role && <p className="text-xs text-muted">{tu.requestedRole}: {userFacingRole(req.requested_role as Role) ? (t.roles[userFacingRole(req.requested_role as Role)!] ?? req.requested_role) : req.requested_role}</p>}
        <Field label={tu.assignRole}>
          <Select value={roleKey} disabled={busy} onChange={(value) => { setRoleKey(value); setEmployeeId(""); setError(null); }} options={roleOpts} />
        </Field>
        {roleKey === "employee" && <EmployeeApprovalSelect value={employeeId} onChange={(value) => { setEmployeeId(value); setError(null); }} disabled={busy} />}
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      </div>
    </Dialog>
  );
}

function RejectDialog({ req, t, onClose, onDone }: {
  req: RegistrationRequest | null; t: any; onClose: () => void; onDone: (m: ToastState) => void;
}) {
  const tu = t.usersAdmin;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setReason(""); }, [req]);
  if (!req) return null;
  async function submit() {
    setBusy(true);
    const e = await rejectUser(req!.id, reason.trim() || null);
    setBusy(false);
    if (e) { onDone({ type: "error", message: userMgmtError(tu, e) }); return; }
    onDone({ type: "success", message: tu.rejectedOk });
  }
  return (
    <Dialog open={!!req} onClose={onClose} title={tu.rejectTitle}
      footer={<><Button variant="outline" onClick={onClose}>{t.common.cancel}</Button><Button onClick={submit} disabled={busy}>{busy ? "…" : tu.confirmReject}</Button></>}>
      <div className="space-y-3">
        <p className="text-sm font-medium text-fg">{req.full_name ?? req.email}</p>
        <Field label={tu.rejectReason} hint={tu.rejectReasonOptional}>
          <textarea className={`${inputClass} resize-none`} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
