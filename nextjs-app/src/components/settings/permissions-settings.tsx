"use client";

// مصفوفة الصلاحيات التفصيلية (Batch 2C) — admin فقط.
// الحارس الفعلي في القاعدة (has_capability + RLS/RPC). هذه واجهة إدارة فقط:
//  • مصفوفة الأدوار: تبديل صلاحية لكل دور (set_role_capability).
//  • تجاوزات المستخدم: سماح/منع/وراثة لكل مستخدم (set_user_capability).
// admin يملك كل الصلاحيات دائمًا (تجاوز برمجي) فعموده معطّل ومفعّل.

import { useEffect, useMemo, useState } from "react";
import { UserCog } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { Select } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import {
  listPermissions, getRoleCapabilityMatrix, setRoleCapability,
  getUserCapabilityOverrides, setUserCapability, listRegistrationRequests,
  type PermissionRow,
} from "@/lib/queries";
import { TableMessage, checkboxClass } from "@/components/settings/settings-ui";

const ROLES = ["admin", "it_manager", "technician", "warehouse_manager", "viewer", "auditor"] as const;

export function PermissionsSettings() {
  const { t } = useAppPreferences();
  const tp = t.permissions;
  const [perms, setPerms] = useState<PermissionRow[]>([]);
  const [matrix, setMatrix] = useState<Record<string, Set<string>>>({});
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastState>(null);

  async function loadMatrix() {
    const [{ rows }, { matrix: m }] = await Promise.all([listPermissions(), getRoleCapabilityMatrix()]);
    setPerms(rows);
    const conv: Record<string, Set<string>> = {};
    for (const r of ROLES) conv[r] = new Set(m[r] ?? []);
    setMatrix(conv);
    setLoading(false);
  }
  useEffect(() => { loadMatrix(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // تجميع الصلاحيات حسب المجموعة للعرض المرتّب.
  const groups = useMemo(() => {
    const g: Record<string, PermissionRow[]> = {};
    for (const p of perms) (g[p.grp ?? "other"] ??= []).push(p);
    return g;
  }, [perms]);

  async function toggleRole(roleKey: string, permKey: string, next: boolean) {
    if (roleKey === "admin") return; // admin كامل دائمًا
    setMatrix((cur) => {
      const s = new Set(cur[roleKey]);
      if (next) s.add(permKey); else s.delete(permKey);
      return { ...cur, [roleKey]: s };
    });
    const err = await setRoleCapability(roleKey, permKey, next);
    if (err) { setToast({ type: "error", message: tp.error + err }); loadMatrix(); }
    else setToast({ type: "success", message: tp.updated });
  }

  const groupLabel = (g: string) => (tp.groups as Record<string, string>)[g] ?? g;

  return (
    <div className="space-y-4">
      {/* مصفوفة الأدوار */}
      <Card>
        <CardHeader title={tp.roleMatrix} description={tp.roleNote} />
        <div tabIndex={0} className="overflow-x-auto">
          <table className="ui-table">
            <thead>
              <tr>
                <th>{tp.capability}</th>
                {ROLES.map((r) => <th key={r} className="!text-center">{(t.roles as Record<string, string>)[r] ?? r}</th>)}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <TableMessage colSpan={ROLES.length + 1} loading />
              ) : Object.keys(groups).map((g) => (
                <GroupRows key={g} label={groupLabel(g)} rows={groups[g]} roles={ROLES} matrix={matrix} onToggle={toggleRole} colCount={ROLES.length + 1} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* تجاوزات المستخدمين */}
      <UserOverrides perms={perms} groups={groups} groupLabel={groupLabel} setToast={setToast} />

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function GroupRows({ label, rows, roles, matrix, onToggle, colCount }: {
  label: string; rows: PermissionRow[]; roles: readonly string[];
  matrix: Record<string, Set<string>>; onToggle: (r: string, k: string, next: boolean) => void; colCount: number;
}) {
  const { t } = useAppPreferences();
  return (
    <>
      <tr className="bg-surface-2">
        <td colSpan={colCount} className="!h-8 text-xs font-semibold text-muted">{label}</td>
      </tr>
      {rows.map((p) => (
        <tr key={p.key}>
          <td>
            <div className="font-mono text-[12.5px] font-medium text-fg [unicode-bidi:isolate]" dir="ltr">{p.key}</div>
            {p.description && <div className="text-xs text-muted">{p.description}</div>}
          </td>
          {roles.map((r) => {
            const checked = r === "admin" ? true : matrix[r]?.has(p.key) ?? false;
            return (
              <td key={r} className="text-center">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={r === "admin"}
                  aria-label={`${(t.roles as Record<string, string>)[r] ?? r} — ${p.key}`}
                  onChange={(e) => onToggle(r, p.key, e.target.checked)}
                  className={checkboxClass}
                />
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

function UserOverrides({ perms, groups, groupLabel, setToast }: {
  perms: PermissionRow[];
  groups: Record<string, PermissionRow[]>;
  groupLabel: (g: string) => string;
  setToast: (t: ToastState) => void;
}) {
  const { t } = useAppPreferences();
  const tp = t.permissions;
  const [users, setUsers] = useState<{ id: string; label: string }[]>([]);
  const [userId, setUserId] = useState("");
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    listRegistrationRequests("approved").then(({ rows }) =>
      setUsers(rows.map((u) => ({ id: u.id, label: `${u.full_name ?? u.email}${u.assigned_role ? ` — ${(t.roles as Record<string, string>)[u.assigned_role] ?? u.assigned_role}` : ""}` }))),
    );
  }, [t.roles]); // t.roles ثابت المرجع لكل لغة (قاموس ثابت) — يُحدّث التسميات عند تبديل اللغة

  async function loadOverrides(uid: string) {
    if (!uid) { setOverrides({}); return; }
    setLoading(true);
    const { overrides: o } = await getUserCapabilityOverrides(uid);
    setOverrides(o); setLoading(false);
  }

  function state(permKey: string): "allow" | "deny" | "inherit" {
    if (!(permKey in overrides)) return "inherit";
    return overrides[permKey] ? "allow" : "deny";
  }

  async function change(permKey: string, next: "allow" | "deny" | "inherit") {
    const err = await setUserCapability(userId, permKey, next);
    if (err) { setToast({ type: "error", message: tp.error + err }); return; }
    setToast({ type: "success", message: tp.updated });
    loadOverrides(userId);
  }

  return (
    <Card>
      <CardHeader
        title={tp.userOverrides}
        description={tp.userNote}
        actions={
          <div className="w-full min-w-[240px] sm:w-72">
            <Select value={userId} onChange={(v) => { setUserId(v); loadOverrides(v); }} placeholder={tp.pickUser}
              options={users.map((u) => ({ value: u.id, label: u.label }))} />
          </div>
        }
      />
      {!userId ? (
        <EmptyState compact icon={UserCog} title={tp.pickUser} description={tp.pickUserHint} />
      ) : loading ? (
        <div className="flex justify-center py-10"><Spinner label={t.common.loading} /></div>
      ) : (
        <div className="divide-y divide-line">
          {Object.keys(groups).map((g) => (
            <div key={g}>
              <div className="bg-surface-2 px-5 py-2 text-xs font-semibold text-muted">{groupLabel(g)}</div>
              <div className="divide-y divide-line">
                {groups[g].map((p) => (
                  <div key={p.key} className="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5">
                    <div className="min-w-0">
                      <div className="font-mono text-[12.5px] font-medium text-fg [unicode-bidi:isolate]" dir="ltr">{p.key}</div>
                      {p.description && <div className="text-xs text-muted">{p.description}</div>}
                    </div>
                    <TriState label={p.description || p.key} value={state(p.key)} onChange={(v) => change(p.key, v)} labels={{ allow: tp.allow, deny: tp.deny, inherit: tp.inherit }} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function TriState({ label, value, onChange, labels }: {
  label: string;
  value: "allow" | "deny" | "inherit";
  onChange: (v: "allow" | "deny" | "inherit") => void;
  labels: { allow: string; deny: string; inherit: string };
}) {
  const opts: { k: "inherit" | "allow" | "deny"; label: string; on: string }[] = [
    { k: "inherit", label: labels.inherit, on: "text-fg" },
    { k: "allow", label: labels.allow, on: "text-ok" },
    { k: "deny", label: labels.deny, on: "text-bad" },
  ];
  return (
    <div role="group" aria-label={label} className="ui-seg">
      {opts.map((o) => (
        <button
          key={o.k}
          type="button"
          aria-pressed={value === o.k}
          onClick={() => onChange(o.k)}
          className={`ui-seg-item !min-h-7 !px-2.5 !text-xs max-md:!min-h-10 ${value === o.k ? `font-semibold ${o.on}` : ""}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
