"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Pencil, Power, Play, RotateCcw, Mail, Lock, Users as UsersIcon } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusChip } from "@/components/ui/status-chip";
import type { Tone } from "@/lib/tone";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, SearchInput, Select } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import { useSession, isAdmin as isAdminFn, type Role } from "@/lib/session";
import { ASSIGNABLE_TECHNICAL_ROLES, assignableTechnicalRole, userFacingRole } from "@/lib/user-facing-role";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import {
  listRegistrationRequests, approveUser, approveEmployeeUser, rejectUser, resetUserPending, userMgmtError,
  type RegistrationRequest,
} from "@/lib/queries";
import { formatDate } from "@/lib/format";
import { CheckboxFilter, TableMessage, Toolbar } from "@/components/settings/settings-ui";
import { EmployeeApprovalSelect } from "@/components/settings/employee-approval-select";

// تبويب «المستخدمون» — قائمة مستخدمي النظام الداخليين (app_users) مع إدارة الأدوار والوصول.
// يعيد استخدام مصدر البيانات والدوال الأمنية القائمة (list_registration_requests + approve/reject/reset).
// لا يخلط مع العملاء الخارجيين (customers) الذين يُدارون في نظام الطلبات.
export function UsersSettings() {
  const { t, lang } = useAppPreferences();
  const tu = t.usersAdmin;
  const { role, email: myEmail } = useSession();
  const isAdmin = isAdminFn(role);

  const roleLabel = (technicalRole: string | null) => {
    const state = userFacingRole(technicalRole as Role);
    return state ? (t.roles[state] ?? state) : "—";
  };
  const roleOpts = ASSIGNABLE_TECHNICAL_ROLES.map((k) => ({ value: k, label: roleLabel(k) }));

  const [rows, setRows] = useState<RegistrationRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [q, setQ] = useState("");
  // إخفاء حسابات الاختبار افتراضيًا لتنظيف القائمة (حالة واجهة محلية فقط — قابلة للإلغاء بالمربّع).
  const [hideTest, setHideTest] = useState(true);
  // تمييز حسابات الاختبار (اشتقاق من الاسم/البريد فقط — بلا تغيير أي حالة أو دور).
  // نستخدم «qa.» في البريد بدل «qa» لتفادي مطابقة نطاق قطر (‎@…‎.qa) خطأً.
  const isTest = (r: RegistrationRequest) => {
    const name = (r.full_name ?? "").trim().toLowerCase();
    const email = r.email.toLowerCase();
    const local = email.split("@")[0] ?? "";
    const domain = email.split("@")[1] ?? "";
    const testToken = /(^|[\s._-])(qa|test)([\s._-]|$)/;
    // (DATA-5) النطاق أيضًا: «.test» TLD محجوز للاختبار (RFC 6761، لا يطابق نطاقًا حقيقيًا) —
    // يلتقط حسابات @aone.test لكل دور؛ و«test.com» الصريح لحسابات الاختبار القديمة.
    const testDomain = domain.endsWith(".test") || domain === "test.com";
    return testToken.test(name) || testToken.test(local) || testDomain;
  };
  const [toast, setToast] = useState<ToastState>(null);
  const [roleFor, setRoleFor] = useState<RegistrationRequest | null>(null);
  const [deactivateFor, setDeactivateFor] = useState<RegistrationRequest | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const { rows, error } = await listRegistrationRequests(statusFilter || undefined);
    if (error) setToast({ type: "error", message: tu.loadError + error });
    setRows(rows);
    setLoading(false);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [statusFilter]);

  async function onActivate(r: RegistrationRequest) {
    if (r.assigned_role === "employee") { setRoleFor(r); return; }
    setBusyId(r.id);
    const e = await approveUser(r.id, r.assigned_role || "viewer");
    setBusyId(null);
    if (e) { setToast({ type: "error", message: userMgmtError(tu, e) }); return; }
    setToast({ type: "success", message: tu.activatedOk }); load();
  }
  async function onReset(r: RegistrationRequest) {
    setBusyId(r.id);
    const e = await resetUserPending(r.id);
    setBusyId(null);
    if (e) { setToast({ type: "error", message: userMgmtError(tu, e) }); return; }
    setToast({ type: "success", message: tu.resetOk }); load();
  }

  const filtered = rows.filter((r) => {
    // البحث يتجاوز إخفاء حسابات الاختبار حتى يظل أي حساب قابلًا للعثور عليه دائمًا.
    if (hideTest && !q && isTest(r)) return false;
    if (!q) return true;
    const hay = `${r.full_name ?? ""} ${r.email}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });
  // عدد حسابات الاختبار المخفية حاليًا (للعلم بأن الفلتر مُفعّل) — لا يُخفى شيء أثناء البحث.
  const hiddenTestCount = hideTest && !q ? rows.filter(isTest).length : 0;

  // حالة الحساب مشتقّة من approval_status (البوابة الفعلية للوصول عبر is_approved()).
  const accountStatus = (s: string) => {
    const map: Record<string, { label: string; tone: Tone }> = {
      approved: { label: tu.stActive, tone: "ok" },
      pending: { label: tu.stPending, tone: "warn" },
      rejected: { label: tu.stDisabled, tone: "neu" },
    };
    return map[s] ?? map.pending;
  };
  const approvalBadge = (s: string) => {
    const map: Record<string, { label: string; tone: Tone }> = {
      pending: { label: tu.pending, tone: "warn" },
      approved: { label: tu.approved, tone: "ok" },
      rejected: { label: tu.rejected, tone: "bad" },
    };
    return map[s] ?? { label: s, tone: "neu" as Tone };
  };
  const initials = (r: RegistrationRequest) => {
    const src = (r.full_name ?? "").trim() || r.email;
    const parts = src.split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : src.slice(0, 2)).toUpperCase();
  };

  return (
    <div>
      <Card>
        <CardHeader
          title={tu.usersSection}
          description={tu.usersSubtitle}
          actions={<Button size="sm" variant="outline" onClick={load}><RefreshCw aria-hidden="true" />{tu.refresh}</Button>}
        />
        <Toolbar>
          <SearchInput
            label={tu.searchUsers} placeholder={tu.searchUsers}
            value={q} onChange={(e) => setQ(e.target.value)}
            onClear={() => setQ("")} clearLabel={t.common.clearSearch}
            containerClassName="min-w-[220px] flex-1 sm:max-w-xs"
          />
          <div className="min-w-[150px]">
            <Select value={statusFilter} onChange={setStatusFilter} placeholder={tu.allUsers}
              options={[{ value: "approved", label: tu.stActive }, { value: "pending", label: tu.pending }, { value: "rejected", label: tu.stDisabled }]} />
          </div>
          <CheckboxFilter
            label={`${tu.hideTestAccounts}${hiddenTestCount > 0 ? ` (${hiddenTestCount})` : ""}`}
            checked={hideTest}
            onChange={setHideTest}
          />
          {!loading && <span className="ms-auto text-[13px] tabular-nums text-muted">{filtered.length} / {rows.length}</span>}
        </Toolbar>

        <div tabIndex={0} className="overflow-x-auto">
          <table className="ui-table">
            <thead>
              <tr>
                <th>{tu.name}</th>
                <th>{tu.email}</th>
                <th>{tu.role}</th>
                <th>{tu.loginMethod}</th>
                <th>{tu.accountStatus}</th>
                <th>{tu.approvalStatus}</th>
                <th>{tu.lastSignIn}</th>
                <th>{tu.actions}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <TableMessage colSpan={8} loading />
              ) : filtered.length === 0 ? (
                <TableMessage colSpan={8}><EmptyState compact icon={UsersIcon} title={tu.noUsers} /></TableMessage>
              ) : filtered.map((r) => {
                const st = accountStatus(r.approval_status);
                const ab = approvalBadge(r.approval_status);
                const isSelf = !!myEmail && r.email.toLowerCase() === myEmail.toLowerCase();
                const isAdminRow = r.assigned_role === "admin";
                // it_manager لا يدير حسابات admin؛ ولا أحد يدير حسابه (منع القفل الذاتي).
                const canManage = !isSelf && (isAdmin || !isAdminRow);
                const busy = busyId === r.id;
                return (
                  <tr key={r.id}>
                    <td className="!py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span aria-hidden="true" className="ui-avatar">{initials(r)}</span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-semibold text-fg">{r.full_name ?? "—"}</span>
                            {isSelf && <StatusChip tone="info" dot={false} size="sm">{tu.selfBadge}</StatusChip>}
                            {isTest(r) && <StatusChip tone="neu" dot={false} size="sm">{tu.testBadge}</StatusChip>}
                          </div>
                          <p className="mt-0.5 text-xs tabular-nums text-muted">{tu.registeredAt}: {formatDate(r.created_at, lang)}</p>
                        </div>
                      </div>
                    </td>
                    <td className="text-[13px] text-fg-2 [unicode-bidi:isolate]" dir="ltr">{r.email}</td>
                    <td className="whitespace-nowrap text-fg-2">{roleLabel(r.assigned_role)}</td>
                    <td>
                      <span className="inline-flex items-center gap-1 text-[13px] text-fg-2">
                        <Mail aria-hidden="true" className="h-3.5 w-3.5 text-muted" />{tu.loginEmail}
                      </span>
                      <p className={`mt-0.5 text-xs font-medium ${r.email_confirmed ? "text-ok" : "text-warn"}`}>
                        {r.email_confirmed ? tu.verified : tu.notVerified}
                      </p>
                    </td>
                    <td><StatusChip tone={st.tone}>{st.label}</StatusChip></td>
                    <td><StatusChip tone={ab.tone} dot={false} size="sm">{ab.label}</StatusChip></td>
                    <td className="text-[13px] text-muted" dir="ltr">{tu.never}</td>
                    <td>
                      {!canManage ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted"><Lock aria-hidden="true" className="h-3.5 w-3.5" />{isSelf ? tu.selfBadge : tu.protectedHint}</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRoleFor(r)}><Pencil aria-hidden="true" />{tu.changeRole}</Button>
                          {r.approval_status === "approved" ? (
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => setDeactivateFor(r)}><Power aria-hidden="true" />{tu.deactivate}</Button>
                          ) : (
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => onActivate(r)}><Play aria-hidden="true" />{tu.activate}</Button>
                          )}
                          {r.approval_status !== "pending" && (
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onReset(r)}><RotateCcw aria-hidden="true" />{tu.resetPending}</Button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <ChangeRoleDialog req={roleFor} t={t} roleOpts={roleOpts} onClose={() => setRoleFor(null)}
        onDone={(m) => { setRoleFor(null); setToast(m); load(); }} />
      <DeactivateDialog req={deactivateFor} t={t} onClose={() => setDeactivateFor(null)}
        onDone={(m) => { setDeactivateFor(null); setToast(m); load(); }} />

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function ChangeRoleDialog({ req, t, roleOpts, onClose, onDone }: {
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
    setRoleKey(assignableTechnicalRole(req.assigned_role as Role));
    setEmployeeId(""); setError(null);
  }, [req]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!req) return null;
  async function submit() {
    setBusy(true);
    const e = roleKey === "employee" ? await approveEmployeeUser(req!.id, employeeId) : await approveUser(req!.id, roleKey);
    setBusy(false);
    if (e) { setError(userMgmtError(tu, e)); return; }
    onDone({ type: "success", message: tu.roleChangedOk });
  }
  return (
    <Dialog open={!!req} onClose={onClose} title={tu.changeRoleTitle}
      footer={<><Button variant="outline" onClick={onClose}>{t.common.cancel}</Button><Button onClick={submit} disabled={busy || (roleKey === "employee" && !employeeId)}>{busy ? "…" : tu.confirmChangeRole}</Button></>}>
      <div className="space-y-3">
        <p className="text-sm font-medium text-fg">{req.full_name ?? req.email}</p>
        <Field label={tu.assignRole} hint={tu.changeRoleHint}>
          <Select value={roleKey} disabled={busy} onChange={(value) => { setRoleKey(value); setEmployeeId(""); setError(null); }} options={roleOpts} />
        </Field>
        {roleKey === "employee" && <EmployeeApprovalSelect value={employeeId} onChange={(value) => { setEmployeeId(value); setError(null); }} disabled={busy} />}
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      </div>
    </Dialog>
  );
}

function DeactivateDialog({ req, t, onClose, onDone }: {
  req: RegistrationRequest | null; t: any; onClose: () => void; onDone: (m: ToastState) => void;
}) {
  const tu = t.usersAdmin;
  const [busy, setBusy] = useState(false);
  if (!req) return null;
  async function submit() {
    setBusy(true);
    const e = await rejectUser(req!.id, null);
    setBusy(false);
    if (e) { onDone({ type: "error", message: userMgmtError(tu, e) }); return; }
    onDone({ type: "success", message: tu.deactivatedOk });
  }
  return (
    <Dialog open={!!req} onClose={onClose} title={tu.deactivateTitle}
      footer={<><Button variant="outline" onClick={onClose}>{t.common.cancel}</Button><Button variant="danger" onClick={submit} disabled={busy}>{busy ? "…" : tu.confirmDeactivate}</Button></>}>
      <div className="space-y-2">
        <p className="text-sm font-medium text-fg">{req.full_name ?? req.email}</p>
        <p className="text-sm text-fg-2">{tu.deactivateConfirm}</p>
      </div>
    </Dialog>
  );
}
